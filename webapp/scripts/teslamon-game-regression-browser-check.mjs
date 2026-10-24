// Controlled Chrome regression for the self-hosted /games/ package.
// Generated mic fixtures feed the actual AudioWorklet, Whisper WASM and animation.
// Chrome simulation only; never equate it with a Tesla or iPhone microphone test.
// Usage: TESLAMON_GAME_SOURCE=/path/to/game-repo node scripts/teslamon-game-regression-browser-check.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const game = process.env.TESLAMON_GAME_SOURCE;
if (!game) throw new Error('Set TESLAMON_GAME_SOURCE to the standalone game repo with verification/audio-fixtures.');
const clips = {};
for (const name of ['short-jump','jump','repeat-jump','roll','sit','spin','unknown']) {
  clips[name] = (await fs.readFile(path.join(game,'verification/audio-fixtures',name+'.wav'))).toString('base64');
}
const harness = (await fs.readFile(path.join(game,'verification/retry-browser-harness.js'),'utf8'))
  .replace('export async function installRetryFixtureMic(', 'window.installRetryFixtureMic = async function(');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css',
  '.wasm':'application/wasm','.onnx':'application/octet-stream',
  '.json':'application/json','.md':'text/plain'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const relative=url.pathname.endsWith('/') ? url.pathname.slice(1)+'index.html' : url.pathname.slice(1);
  const target=path.resolve(root,decodeURIComponent(relative));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{const bytes=await fs.readFile(target);res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream'});res.end(bytes);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--no-first-run','--autoplay-policy=no-user-gesture-required']});
const proof={origin,runs:[],failures:[],modelRequests:[],reload:null};
try{
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']});
  const page=await context.newPage();
  page.on('pageerror',error=>proof.failures.push(String(error)));
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.pathname.includes('/games/models/'))proof.modelRequests.push(url.pathname);
  });
  await page.goto(origin+'/games/',{waitUntil:'load'});
  await page.addScriptTag({content:harness});
  await page.evaluate(async encoded=>{window.__voiceProof=await window.installRetryFixtureMic(encoded);},clips);
  const prepared=await page.evaluate(()=>window.__voiceProof.prepare());
  if(!/Tap to speak/.test(prepared.button))console.error('GAME PREP DEBUG',JSON.stringify({
    prepared,errors:proof.failures,
    page:await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,
      note:document.querySelector('#voiceNote')?.textContent,disabled:document.querySelector('#speak')?.disabled,
      secure:isSecureContext,worklet:typeof AudioWorkletNode,worker:typeof Worker,wasm:typeof WebAssembly}))
  },null,2));
  assert.match(prepared.button,/Tap to speak/);
  assert.equal(prepared.micCalls,0);
  assert.equal(prepared.workerCount,1);
  assert.equal(prepared.loadCount,1);
  assert.equal(prepared.modelInfo?.cachedFiles,7);
  proof.prepared=prepared;

  for(const [name,gain,action] of [
    ['short-jump',0.05,'jump'],['jump',1,'jump'],['repeat-jump',1,'jump'],
    ['roll',1,'roll'],['sit',1,'sit'],['spin',1,'spin'],['jump',1,'jump']
  ]){
    const result=await page.evaluate(([name,gain])=>window.__voiceProof.run(name,gain),[name,gain]);
    assert.ok(result.actions.some(item=>item.classes.includes('action-'+action)),
      name+' should produce a real '+action+' animation');
    assert.equal(result.tracksEnded,true,name+' should stop microphone tracks');
    assert.equal(result.workerCount,1,'worker must stay warm across tricks');
    assert.equal(result.loadCount,1,'model must not reload across tricks');
    proof.runs.push({name,gain,action,elapsedMs:result.elapsedMs,
      status:result.status,naturalMotion:result.actions.flatMap(item=>item.transforms).some(value=>value&&value!=='none')});
  }
  for(const name of ['unknown','silence','denied']){
    const result=await page.evaluate(name=>window.__voiceProof.run(name),name);
    assert.equal(result.actions.length,0,name+' must not execute a trick');
    assert.equal(result.workerCount,1);
    assert.equal(result.loadCount,1);
    proof.runs.push({name,status:result.status,actions:0,tracksEnded:result.tracksEnded});
  }

  const finish=await page.evaluate(()=>window.__voiceProof.run('repeat-jump',1,2000));
  if(!finish.actions.some(item=>item.classes.includes('action-jump')))console.error('FINISH DEBUG',JSON.stringify(finish,null,2));
  assert.ok(finish.actions.some(item=>item.classes.includes('action-jump')),
    'Finish speaking submits a captured Jump');
  proof.finish={status:finish.status,actions:finish.actions.length};

  const stop=await page.evaluate(async()=>{
    const state=window.__voiceProof, button=document.querySelector('#speak');
    const before=state.actions.length;
    state.name='jump';
    button.click();
    await new Promise(resolve=>setTimeout(resolve,400));
    document.querySelector('#stop').click();
    await new Promise(resolve=>setTimeout(resolve,2500));
    return {actions:state.actions.length-before,
      tracksEnded:state.tracks.every(track=>track.readyState==='ended'),
      button:button.textContent};
  });
  assert.equal(stop.actions,0,'Stop cancels capture without stale action');
  assert.equal(stop.tracksEnded,true);
  proof.stop=stop;

  const hidden=await page.evaluate(async()=>{
    const state=window.__voiceProof, before=state.actions.length;
    state.name='jump';
    document.querySelector('#speak').click();
    await new Promise(resolve=>setTimeout(resolve,400));
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve=>setTimeout(resolve,2500));
    delete document.hidden;
    return {actions:state.actions.length-before,tracksEnded:state.tracks.every(t=>t.readyState==='ended')};
  });
  assert.equal(hidden.actions,0);
  assert.equal(hidden.tracksEnded,true);
  proof.hiddenSimulation=hidden;

  await page.evaluate(()=>window.__voiceProof.restore());
  const beforeReload=proof.modelRequests.length;
  await page.reload({waitUntil:'load'});
  await page.addScriptTag({content:harness});
  await page.evaluate(async encoded=>{window.__voiceProof=await window.installRetryFixtureMic(encoded);},clips);
  const reload=await page.evaluate(()=>window.__voiceProof.prepare());
  assert.equal(reload.micCalls,0);
  assert.equal(reload.modelInfo?.cachedFiles,7);
  assert.equal(reload.modelInfo?.cacheState,'complete');
  assert.equal(reload.workerCount,1);
  assert.equal(reload.loadCount,1);
  proof.reload={...reload,additionalModelHttpRequests:proof.modelRequests.length-beforeReload};
  await page.evaluate(()=>window.__voiceProof.restore());
  assert.deepEqual(proof.failures,[]);
  console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
