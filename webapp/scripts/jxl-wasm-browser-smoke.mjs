// Isolated local Chrome WebAssembly test: no changes to the production site.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const samples=process.env.JXL_WASM_SAMPLES_DIR || path.resolve(root, '../test/fixtures/jxl-wasm');
let wasmRequests=0;
const server=http.createServer(async(req,res)=>{
 const pathName=new URL(req.url,'http://localhost').pathname;
 if(pathName==='/') {res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Local JXL WASM smoke</title>');return;}
 if(/^\/sample(360|480|720)\.jxl$/.test(pathName)) {
  const file=path.resolve(samples,pathName.endsWith('720.jxl')?'720p.jxl':pathName.endsWith('480.jxl')?'480p.jxl':'360p.jxl');
  try{const data=await fs.readFile(file);res.writeHead(200,{'content-type':'image/jxl'});res.end(data);}catch{res.writeHead(404);res.end();}return;
 }
 const file=path.resolve(root,'.'+pathName);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{const data=await fs.readFile(file);if(file.endsWith('.wasm'))wasmRequests++;res.writeHead(200,{'content-type':file.endsWith('.wasm')?'application/wasm':'text/javascript','cache-control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.MOBILE_TEST_CHROME||process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');
 assert.equal(wasmRequests,0,'WASM must not load without explicit decoder use');
 const result=await page.evaluate(async()=>{
  const {createExperimentalJxlDecoder}=await import('/experimental/jxl-wasm/decoder-client.mjs');
  const fixture='/wpPBgATCAEAKAFnEygBAFChMsq4wcu5ni8/dFhM27jO0FbbFpYkioxjk3QCh5ACOzJmzBhjxswYg+eMMcZkSCk/AMDBOHQRBGzjP6/zLAR4hJUkAA==';
  const bytes=Uint8Array.from(atob(fixture),c=>c.charCodeAt(0));
  const decoder=createExperimentalJxlDecoder();
  const results=[];
  try {
   const first=await decoder.decode(new Blob([bytes],{type:'image/jxl'}));
   const check=document.createElement('canvas');check.width=first.width;check.height=first.height;check.getContext('2d').drawImage(first.source,0,0);
   const pixel=check.getContext('2d').getImageData(0,0,1,1).data;
   results.push({size:[first.width,first.height],alpha:pixel[3],transport:first.transport});first.release();
   let invalidRejected=false;try{await decoder.decode(new Blob([new Uint8Array([1,2,3])]));}catch{invalidRejected=true;}
   for(const size of [360,480,720]) {
     const response=await fetch('/sample'+size+'.jxl');if(!response.ok)throw Error('missing sample '+size);
     const blob=await response.blob();const timings=[];
     for(let i=0;i<5;i++){
       const start=performance.now(); const f=await decoder.decode(blob);
       timings.push({elapsed:Math.round(performance.now()-start),decode:f.decodeMs,total:f.totalMs,transport:f.transport});
       const expectedWidth={360:640,480:854,720:1280}[size];if(f.width!==expectedWidth)throw Error('bad frame width '+size);
       f.release();
     }
     results.push({size,bytes:blob.size,timings});
     if(size===480) {
       const both=await Promise.all([decoder.decode(blob),decoder.decode(blob)]);
       both.forEach(f=>f.release());
       results.push({concurrentTwo:true});
     }
   }
   const blob=await (await fetch('/sample480.jxl')).blob();
   const rgba=createExperimentalJxlDecoder({preferBitmap:false});
   let rgbaTransport;
   try {const f=await rgba.decode(blob);rgbaTransport=f.transport;f.release();}finally{rgba.close();}
   const pending=decoder.decode(blob);
   decoder.close();
   let cancelled=false;try{await pending;}catch{cancelled=true;}
   return {results,invalidRejected,rgbaTransport,cancelled};
  }finally{decoder.close();}
 });
 assert.deepEqual(result.results[0].size,[64,64]);assert.equal(result.results[0].alpha,255);
 assert.ok(result.invalidRejected);assert.ok(result.cancelled);assert.equal(result.rgbaTransport,'rgba');assert.equal(wasmRequests,2);
 console.log('PASS JXL WASM worker native-independent decoder',JSON.stringify(result),'wasmRequests',wasmRequests);
 await page.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
