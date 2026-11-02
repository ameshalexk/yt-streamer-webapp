// End-to-end wake -> audio -> either local STT choice -> intent -> same-tab play.
// Uses only fixtures: never contacts Codex, downloads model weights or plays remote media.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const fakeStt=`export function createTeslaMonLocalStt({modelId}){
  let id=modelId; return {
    getState(){return {selectedModelId:id,selectedModel:{label:id.startsWith('moonshine')?'Moonshine':'Whisper'},loaded:true};},
    async transcribe(_blob,{signal}={}){if(signal?.aborted)throw new DOMException('Aborted','AbortError');return {text:'play baby shark'};},
    async setModel(value){id=value;},cancelPending(){},dispose(){}
  };
}`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/__fixture-stt.js'){
    res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fakeStt);
  }
  const file=path.resolve(root,decodeURIComponent(url.pathname.slice(1)||'index.html'));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{
    let text=await fs.readFile(file);
    if(url.pathname==='/teslamon-pet.js'){
      let source=text.toString();
      const check="['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'";
      assert.ok(source.includes(check));
      source=source.replace(check,"['127.0.0.1'].includes(location.hostname)");
      source=source.replace("import {createTeslaMonLocalStt} from './teslamon-local-stt.js?v=20261102-moonshine1';","import {createTeslaMonLocalStt} from './__fixture-stt.js';");
      const detector="const module=await import('./teslamon-wake-engine.js?v=20261025-mycroft-rhasspy1');\n      return module.createTeslaMonWakeDetector(options);";
      assert.ok(source.includes(detector));
      source=source.replace(detector,"window.__triggerWake=()=>options.onWake({keyword:'hey_jarvis',score:0.99});return {start:async()=>true,pause(){},resume(){},stop:async()=>{}};");
      const silence='createSilenceMonitor:options=>createTeslaMonSilenceMonitor(options),';
      assert.ok(source.includes(silence));
      source=source.replace(silence,"createSilenceMonitor:options=>({start(){setTimeout(options.onSpeechEnd,350);return Promise.resolve(true);},stop(){}}),");
      text=Buffer.from(source);
    }
    const extension=path.extname(file);
    const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'};
    const headers={'Content-Type':mime[extension]||'application/octet-stream'};
    if(url.searchParams.get('tm_stt_mode')==='moonshine'&&extension==='.html'){
      headers['Cross-Origin-Opener-Policy']='same-origin';headers['Cross-Origin-Embedder-Policy']='require-corp';
    }
    res.writeHead(200,headers);res.end(text);
  }catch(e){res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox','--no-first-run']});
try{
 for(const model of ['whisper-tiny.en','moonshine-tiny-streaming']){
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  const errors=[];const sent=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{
    window.__voiceCalls=[];
    window.YTStreamerMediaAgent={
      get_player_state:()=>({playback_phase:window.__voiceMedia?'playing':'idle',media_id:window.__voiceMedia||'',mode:'native_video',fullscreen_kind:'none'}),
      async execute(action,args={}){
        window.__voiceCalls.push(action);
        if(action==='pause_for_voice')return {status:'completed'};
        if(action==='search_media')return {status:'completed',result:{results:[{media_id:'ABCdef12345',title:'Baby Shark Dance | Pinkfong',creator:'Pinkfong'}]}};
        if(action==='play_media'){window.__voiceMedia=args.media_id;return {status:'accepted'};}
        if(action==='request_fullscreen')return {status:'needs_user_gesture'};
        if(action==='get_player_state')return {status:'completed',state:window.YTStreamerMediaAgent.get_player_state()};
        return {status:'failed'};
      }
    };
    const mkTrack=()=>({readyState:'live',stop(){this.readyState='ended'},addEventListener(){},removeEventListener(){}});
    const mkStream=()=>({getAudioTracks(){return this.tracks},getTracks(){return this.tracks},clone(){return mkStream()},tracks:[mkTrack()]});
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>mkStream()}});
    window.MediaRecorder=class {
      static isTypeSupported(){return true;}
      constructor(){this.state='inactive';this.mimeType='audio/webm';this.listeners={};}
      addEventListener(name,callback){(this.listeners[name]??=[]).push(callback);}
      fire(name,event={}){for(const fn of this.listeners[name]||[])fn(event);}
      start(){this.state='recording';this.onstart?.();}
      stop(){this.state='inactive';this.fire('dataavailable',{data:new Blob([new Uint8Array(300)],{type:'audio/webm'})});this.fire('stop');}
    };
  });
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort();
    if(url.pathname==='/api/teslamon/capabilities')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({codexAvailable:true})});
    if(url.pathname.startsWith('/api/')){sent.push(url.pathname);return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({status:'unavailable',code:'codex_usage_limit'})});}
    return route.continue();
  });
  await page.goto(origin+'/?ui=classic'+(model.startsWith('moonshine')?'&tm_stt_mode=moonshine':''),{waitUntil:'domcontentloaded'});
  try{await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Listening for'),null,{timeout:12000});}catch(error){console.log('WAKE DEBUG',await page.evaluate(()=>({state:document.querySelector('#tmWakeState')?.textContent,status:document.querySelector('#tmState')?.textContent,model:document.querySelector('#tmSttModelState')?.textContent,pet:!!document.querySelector('#teslamonPet'),supported:{worker:!!window.Worker,wasm:!!window.WebAssembly,audioContext:!!window.AudioContext,worklet:!!window.AudioWorkletNode,recorder:!!window.MediaRecorder,media:!!navigator.mediaDevices?.getUserMedia}})),errors,sent);throw error;}
  await page.evaluate(()=>window.__triggerWake());
  try{await page.waitForFunction(()=>window.__voiceCalls.includes('play_media'),null,{timeout:12000});}catch(error){console.log('PLAY DEBUG',await page.evaluate(()=>({calls:window.__voiceCalls,state:document.querySelector('#tmWakeState')?.textContent,status:document.querySelector('#tmState')?.textContent,model:document.querySelector('#tmSttModelState')?.textContent,command:document.querySelector('#tmText')?.value,phase:document.querySelector('#teslamonPet')?.dataset.wake})),errors,sent);throw error;}
  const result=await page.evaluate(()=>({calls:window.__voiceCalls,media:window.__voiceMedia,model:document.querySelector('#tmSttModel').value}));
  assert.equal(result.media,'ABCdef12345');
  assert.equal(result.model,model);
  assert.deepEqual(result.calls.slice(0,3),['pause_for_voice','search_media','play_media']);
  assert.deepEqual(sent.filter(x=>x.includes('/teslamon/')),[],'simple wake playback must not invoke unavailable Codex endpoints');
  assert.deepEqual(errors,[]);
  console.log(model, 'wake -> synthetic recorded audio -> transcript -> local play accepted without Codex');
  await context.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
