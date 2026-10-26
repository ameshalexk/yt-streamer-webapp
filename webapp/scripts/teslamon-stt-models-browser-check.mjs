// Controlled generated speech through real local WASM. No microphone or planner.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const fixture=process.env.TESLAMON_STT_TEST_WAV;
if(!fixture)throw new Error('Provide a controlled generated speech WAV via TESLAMON_STT_TEST_WAV');
const mime={'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.onnx':'application/octet-stream'};
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 if(pathname==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end('<!doctype html><title>Local model verification</title>');}
 const file=pathname==='/fixture.wav'?fixture:path.resolve(root,decodeURIComponent(pathname.slice(1)));
 if(pathname!=='/fixture.wav'&&!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 try{const bytes=await fs.readFile(file);res.writeHead(200,{'content-type':pathname==='/fixture.wav'?'audio/wav':mime[path.extname(file)]||'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run']});
try{
 const page=await browser.newPage();const errors=[],remote=[],uploads=[];
 page.on('pageerror',e=>errors.push(String(e)));
 const origin='http://127.0.0.1:'+server.address().port;
 page.on('request',r=>{if(new URL(r.url()).origin!==origin)remote.push(r.url());if(r.method()!=='GET')uploads.push(r.url());});
 await page.goto(origin);
 const result=await page.evaluate(async()=>{
  const {VoiceEngine}=await import('/games/voice-engine.js?v=20261025-stt-models1');
  const {decodeRecordedAudio}=await import('/games/recorded-audio.js');
  const blob=await(await fetch('/fixture.wav')).blob();
  const samples=await decodeRecordedAudio(blob);const results=[];
  let active=0,maxActive=0,created=0;
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{
   constructor(...args){super(...args);created++;active++;maxActive=Math.max(maxActive,active);}
   terminate(){active--;return super.terminate();}
  };
  for(const modelId of ['whisper-tiny.en','whisper-base.en','whisper-tiny.en']){
   const engine=new VoiceEngine({modelId});const start=performance.now();
   try{
    const info=await engine.load();const loadMs=performance.now()-start;
    const transcriptions=[];
    for(let i=0;i<2;i++)transcriptions.push(await engine.transcribe(samples.slice()));
    results.push({modelId,info,loadMs,transcriptions});
   }finally{engine.dispose();}
  }
  const defaultEngine=new VoiceEngine();const defaultModel=defaultEngine.model.modelId;defaultEngine.dispose();
  return {seconds:samples.length/16000,results,active,maxActive,created,defaultModel};
 });
 for(const r of result.results){
  assert.equal(r.info.modelId,r.modelId);assert.equal(r.info.cacheState,'complete');assert.equal(r.info.cachedFiles,7);
  for(const t of r.transcriptions)assert.match(t.text,/video|space|time|fabric/i,'recognizable complete controlled command');
 }
 assert.equal(result.defaultModel,'whisper-tiny.en','independent game default remains Tiny');
 assert.equal(result.active,0);assert.equal(result.maxActive,1);assert.equal(result.created,3);
 assert.deepEqual(remote,[]);assert.deepEqual(uploads,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({context:'Mac Chrome, generated speech, direct WASM; not Tesla/iPhone or human accent evidence',...result},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
