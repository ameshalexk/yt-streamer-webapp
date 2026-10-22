// End-to-end synthetic multipart JXL -> worker -> buffered player -> canvas.
// Isolated localhost, no accounts, production server, or external videos.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const fixture=await fs.readFile(path.join(process.env.JXL_WASM_SAMPLES_DIR || path.resolve(root, '../test/fixtures/jxl-wasm'),'480p.jxl'));
const crlf='\r\n';
function multipart(corrupt=false){
 const parts=[];
 for(let i=0;i<16;i++){
  const bytes=corrupt && i===3 ? Buffer.from([0xff,0x0a,0,0,0,0,0]) : fixture;
  parts.push(Buffer.from(`--frame${crlf}Content-Type: image/jxl${crlf}Content-Length: ${bytes.length}${crlf}${crlf}`),bytes,Buffer.from(crlf));
 }
 parts.push(Buffer.from(`--frame--${crlf}`));
 return Buffer.concat(parts);
}
const server=http.createServer(async(req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;
 if(name==='/') {res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Buffered JXL worker integration test</title><script src="/buffered-mjpeg.js"></script><canvas id="player"></canvas>');return;}
 if(name.startsWith('/jxlstream')){
  const body=multipart(new URL(req.url,'http://localhost').searchParams.has('corrupt'));
  res.writeHead(200,{'content-type':'multipart/x-mixed-replace; boundary=frame','x-mjpeg-fps':'12','cache-control':'no-store'});
  // Deliberately break multipart framing across network writes.
  for(let i=0;i<body.length;i+=8191)res.write(body.subarray(i,Math.min(i+8191,body.length)));
  res.end();return;
 }
 const file=path.resolve(root,'.'+name);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{const b=await fs.readFile(file);res.writeHead(200,{'content-type':file.endsWith('.wasm')?'application/wasm':'text/javascript'});res.end(b);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.MOBILE_TEST_CHROME||process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');
 const result=await page.evaluate(async()=>{
  const {createExperimentalJxlDecoder}=await import('/experimental/jxl-wasm/decoder-client.mjs');
  const run=async(corrupt=false)=>{
   const decoder=createExperimentalJxlDecoder({maxPending:4});
   const canvas=document.querySelector('#player');
   let final,fail,states=[];
   const settled=new Promise(resolve=>{final=resolve;fail=resolve;});
   const player=new window.BufferedMjpeg.BufferedMjpegPlayer({
    url:'/jxlstream'+(corrupt?'?corrupt=1':''),canvas,audio:null,fps:12,frameFormat:'jxl',
    frameDecoder:(blob)=>decoder.decode(blob),startupSeconds:0.25,rebufferSeconds:0.25,
    maxQueueSeconds:3,maxQueueBytes:2*1024*1024,maxFrameBytes:1024*1024,
    onState:(state)=>states.push(state),onEnded:()=>final('ended'),onError:(err)=>fail('error:'+err.message),
   });
   const started=performance.now();
   try{
    await player.start();
    const settledState=await Promise.race([settled,new Promise(r=>setTimeout(()=>r('timeout'),5000))]);
    const stats=player.getStats();
    const pixel=canvas.getContext('2d').getImageData(0,0,1,1).data;
    return {state:settledState,rendered:stats.renderedFrames,received:stats.receivedFrames,dropped:stats.droppedFrames,
      avgDecodeMs:stats.averageDecodeMs,maxDecodeMs:stats.maxDecodeMs,workerMs:stats.wasmWorkerDecodeMs,transport:stats.wasmTransferMode,elapsed:Math.round(performance.now()-started),
      rgba:pixel.join(','),states:[...new Set(states)]};
   }finally{player.destroy();decoder.close();}
  };
  return {successful:await run(false),corrupt:await run(true)};
 });
 console.log('Observed buffered stream states',JSON.stringify(result));
 assert.equal(result.successful.state,'ended',JSON.stringify(result));
 assert.ok(result.successful.rendered>=12,JSON.stringify(result));
 assert.equal(result.successful.received,16);
 assert.match(result.corrupt.state,/error:/);
 console.log('PASS local buffered JXL WASM stream',JSON.stringify(result));
 await page.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
