// Controlled Chrome speech -> persistent AudioWorklet -> real local Whisper WASM -> game trick.
// Fixture speech is synthesized; this does not prove physical Tesla or iPhone microphone behavior.
// Usage: TESLAMON_GAME_SOURCE=/path/to/standalone/game node scripts/teslamon-game-handsfree-browser-check.mjs
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const game = process.env.TESLAMON_GAME_SOURCE;
if (!game) throw new Error('TESLAMON_GAME_SOURCE must point to verification/audio-fixtures.');
const clips = {};
for (const name of ['short-jump','jump','roll','sit','spin','unknown']) {
  clips[name] = (await fs.readFile(path.join(game, 'verification/audio-fixtures', name + '.wav'))).toString('base64');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const types = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
  '.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream'};
const server = http.createServer(async (request,response) => {
  const url = new URL(request.url,'http://127.0.0.1');
  const relative = url.pathname.endsWith('/') ? url.pathname.slice(1) + 'index.html' : url.pathname.slice(1);
  const full = path.resolve(root,decodeURIComponent(relative));
  if (!full.startsWith(root + path.sep)) {response.writeHead(403);response.end();return;}
  try {
    const body=await fs.readFile(full);
    response.writeHead(200,{'Content-Type':types[path.extname(full)] || 'application/octet-stream'});
    response.end(body);
  } catch {response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true, args:['--no-first-run','--autoplay-policy=no-user-gesture-required']
});
const evidence={origin,actions:[],micCalls:0,workerCount:0,loadCount:0,transcribeCount:0,
  modelRequests:[],forbiddenRequests:[],errors:[],results:[],cache:null,hidden:null};
try {
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']});
  const page=await context.newPage();
  page.on('pageerror',error=>evidence.errors.push(String(error)));
  page.on('request',request=>{
    const u=new URL(request.url());
    if(u.pathname.includes('/games/models/'))evidence.modelRequests.push(u.pathname);
    if(request.method()!=='GET' || u.pathname.includes('/api/teslamon/transcribe')) {
      evidence.forbiddenRequests.push(request.method()+' '+u.pathname);
    }
  });
  await page.goto(origin+'/games/',{waitUntil:'load'});
  const harness=await page.evaluate(async encoded=>{
    const ctx=new AudioContext({sampleRate:48000});
    await ctx.resume();
    const decoded={};
    for(const [name,b64] of Object.entries(encoded)){
      const bytes=Uint8Array.from(atob(b64),char=>char.charCodeAt(0));
      decoded[name]=await ctx.decodeAudioData(bytes.buffer);
    }
    const dest=ctx.createMediaStreamDestination();
    const originalMic=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const NativeWorker=window.Worker;
    const track=dest.stream.getAudioTracks()[0];
    const s=window.__continuousProof={micCalls:0,workerCount:0,loadCount:0,transcribeCount:0,
      results:[],actions:[],track,tracks:[track],dest,ctx,
      speak:(name,gain=1)=>{
        const clip=decoded[name];if(!clip)throw Error('missing clip '+name);
        const source=ctx.createBufferSource();
        const gainNode=ctx.createGain();
        gainNode.gain.value=gain;
        source.buffer=clip;source.connect(gainNode);gainNode.connect(dest);
        source.start(ctx.currentTime+.08);
        return {durationMs:clip.duration*1000,gain};
      },
      snapshot:()=>({micCalls:s.micCalls,workerCount:s.workerCount,loadCount:s.loadCount,
        transcribeCount:s.transcribeCount,results:s.results.slice(),actions:s.actions.slice(),
        trackState:track.readyState,button:document.querySelector('#handsFreeToggle')?.textContent,
        note:document.querySelector('#voiceNote')?.textContent})
    };
    navigator.mediaDevices.getUserMedia=async(...args)=>{s.micCalls++;return dest.stream;};
    window.Worker=class extends NativeWorker{
      constructor(...args){
        super(...args);s.workerCount++;
        this.addEventListener('message',event=>{
          if(event.data?.type==='result')s.results.push(event.data.text);
        });
      }
      postMessage(msg,...rest){
        if(msg.type==='load')s.loadCount++;
        if(msg.type==='transcribe')s.transcribeCount++;
        return super.postMessage(msg,...rest);
      }
    };
    new MutationObserver(()=>{
      const c=document.querySelector('#dog')?.getAttribute('class')||'';
      const found=c.match(/action-(jump|roll|sit|spin)/);
      if(found)s.actions.push(found[1]);
    }).observe(document.querySelector('#dog'),{attributes:true,attributeFilter:['class']});
    s.restore=async()=>{
      navigator.mediaDevices.getUserMedia=originalMic;
      window.Worker=NativeWorker;
      track.stop();await ctx.close();
    };
    return {prepared:true};
  },clips);
  assert.equal(harness.prepared,true);
  const toggle=page.locator('#handsFreeToggle');
  assert.match(await toggle.innerText(),/Off/);
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector('#handsFreeToggle')?.dataset.state==='on',{timeout:120000});
  const begin=await page.evaluate(()=>window.__continuousProof.snapshot());
  assert.equal(begin.micCalls,1);
  assert.equal(begin.trackState,'live');
  assert.equal(begin.workerCount,1);
  assert.equal(begin.loadCount,1);
  assert.match(begin.note,/Mic ON/);
  for (const [name,expected,gain] of [['short-jump','jump',.05],['roll','roll',1],['sit','sit',1],['spin','spin',1],['jump','jump',1]]) {
    const before=(await page.evaluate(()=>window.__continuousProof.snapshot())).actions.length;
    await page.evaluate(([clip,amplitude])=>window.__continuousProof.speak(clip,amplitude),[name,gain]);
    await page.waitForFunction(({min,action})=>{
      const actions=window.__continuousProof.actions;
      return actions.length>min && actions.slice(min).includes(action);
    },{min:before,action:expected},{timeout:55000});
  }
  const repeated=await page.evaluate(()=>window.__continuousProof.snapshot());
  assert.deepEqual(repeated.actions.slice(0,5),['jump','roll','sit','spin','jump']);
  assert.equal(repeated.micCalls,1,'stream stays open across utterances');
  assert.equal(repeated.workerCount,1);
  assert.equal(repeated.loadCount,1);
  assert.ok(repeated.transcribeCount>=5);
  assert.equal(repeated.trackState,'live');
  const beforeUnknown=repeated.actions.length;
  await page.evaluate(()=>window.__continuousProof.speak('unknown'));
  await page.waitForFunction(min=>window.__continuousProof.transcribeCount>min,repeated.transcribeCount,{timeout:35000});
  await page.waitForTimeout(1600);
  assert.equal((await page.evaluate(()=>window.__continuousProof.snapshot())).actions.length,beforeUnknown);
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector('#handsFreeToggle')?.dataset.state==='off');
  const ended=await page.evaluate(()=>window.__continuousProof.snapshot());
  assert.equal(ended.trackState,'ended');
  assert.equal(ended.micCalls,1);
  assert.equal(ended.workerCount,1);
  assert.equal(ended.loadCount,1);
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  const cached=await page.evaluate(async()=>{
    const keys=await caches.keys();let count=0;
    for(const key of keys){const cache=await caches.open(key);const entries=await cache.keys();
      count+=entries.filter(entry=>entry.url.includes('/games/models/whisper-tiny-en-79fb389/')).length;
    }
    return count;
  });
  evidence.cache={files:cached};
  assert.ok(cached>=7,'model stays in same-origin cache');
  evidence.actions=ended.actions;
  evidence.micCalls=ended.micCalls;
  evidence.workerCount=ended.workerCount;
  evidence.loadCount=ended.loadCount;
  evidence.transcribeCount=ended.transcribeCount;
  evidence.results=ended.results;
  await page.evaluate(()=>window.__continuousProof.restore());
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
