// Chrome-only real ONNX/WASM model loading/inference smoke: no microphone or network upload.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.onnx':'application/octet-stream','.css':'text/css'};
const server=http.createServer(async(req,res)=>{
  const wanted=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
  const full=path.resolve(root,decodeURIComponent(wanted));
  if(!full.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{const bytes=await fs.readFile(full);res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream'});res.end(bytes);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'domcontentloaded'});
  const detail=await page.evaluate(async()=>{
    const {WakeWordEngine}=await import('/teslamon-wake-engine.js');
    const engine=new WakeWordEngine({
      keywords:['hey_jarvis','hey_luna','alexa'],baseAssetUrl:'/teslamon-wake-assets/models',
      ortWasmPath:'/teslamon-wake-assets/ort/',executionProviders:['wasm']
    });
    try{
      await engine.load();
      // Exercise the shared embedding and every actual wake head.
      for(let i=0;i<24;i++)await engine._processChunk(new Float32Array(1280),{emitEvents:false});
      const heads=Object.fromEntries(Object.entries(engine._keywordModels).map(([name,head])=>[name,{windowSize:head.windowSize,score:head.scores.at(-1)}]));
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      let workletStarted=false,allTracksStopped=false;
      const loaded=engine._loaded,keywords=Object.keys(engine._keywordModels),embeddings=engine._keywordModels.hey_jarvis?.history.length,vad=engine._isSpeechActive;
      try{
        await engine.start({stream});
        workletStarted=Boolean(engine._workletNode);
        await new Promise(resolve=>setTimeout(resolve,300));
      }finally{
        await engine.stop();
        stream.getTracks().forEach(track=>track.stop());
        allTracksStopped=stream.getTracks().every(track=>track.readyState==='ended');
      }
      return {loaded,keywords,heads,embeddings,vad,workletStarted,allTracksStopped,context:'Chrome synthetic microphone, no speech supplied or uploads'};
    }finally{await engine.stop();}
  },{timeout:60000});
  assert.equal(detail.loaded,true);
  assert.equal(detail.workletStarted,true,'real Chrome AudioWorklet start');
  assert.equal(detail.allTracksStopped,true,'mic tracks must be stopped');
  assert.deepEqual(detail.keywords,['hey_jarvis','hey_luna','alexa']);
  for(const head of Object.values(detail.heads))assert.ok(Number.isFinite(head.score)&&head.score>=0&&head.score<=1,'valid real wake-head inference score');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS real Chrome browser ONNX WebAssembly load and inference',JSON.stringify(detail));
}finally{await browser.close();await new Promise(r=>server.close(r));}
