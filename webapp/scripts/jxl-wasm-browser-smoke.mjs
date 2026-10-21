// Isolated local Chrome worker smoke: does not touch user sessions or production.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const sample=path.resolve(process.env.JXL_WASM_TEST_SAMPLE || path.join(process.env.HOME, 'Developer/ytstreamer-jxl-wasm-spike-20261021/frame720.jxl'));
let wasmRequests=0;
const server=http.createServer(async(req,res)=>{
 const pathName=new URL(req.url,'http://localhost').pathname;
 if(pathName==='/') {res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Local JXL WASM smoke</title>');return;}
 if(pathName==='/sample720.jxl') {try{const data=await fs.readFile(sample);res.writeHead(200,{'content-type':'image/jxl'});res.end(data);}catch{res.writeHead(404);res.end();}return;}
 const file=path.resolve(root,'.'+pathName);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{const data=await fs.readFile(file);if(file.endsWith('.wasm'))wasmRequests++;res.writeHead(200,{'content-type':file.endsWith('.wasm')?'application/wasm':'text/javascript','cache-control':'no-store'});res.end(data);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.MOBILE_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');
 assert.equal(wasmRequests,0,'WASM must not load without explicit decoder use');
 const result=await page.evaluate(async()=>{
  const {createExperimentalJxlDecoder}=await import('/experimental/jxl-wasm/decoder-client.mjs');
  const fixture='/wpPBgATCAEAKAFnEygBAFChMsq4wcu5ni8/dFhM27jO0FbbFpYkioxjk3QCh5ACOzJmzBhjxswYg+eMMcZkSCk/AMDBOHQRBGzjP6/zLAR4hJUkAA==';
  const bytes=Uint8Array.from(atob(fixture),c=>c.charCodeAt(0));
  const decoder=createExperimentalJxlDecoder();
  try {
   const first=await decoder.decode(new Blob([bytes],{type:'image/jxl'}));
   const size=[first.width,first.height];const alpha=first.source.getContext('2d').getImageData(0,0,1,1).data[3];first.release();
   let invalidRejected=false;try{await decoder.decode(new Blob([new Uint8Array([1,2,3])]));}catch{invalidRejected=true;}
   const response=await fetch('/sample720.jxl');const jxl=await response.blob();
   const timings=[];for(let i=0;i<3;i++){const start=performance.now();const f=await decoder.decode(jxl);timings.push(Math.round(performance.now()-start));if(f.width!==1280||f.height!==720)throw Error('bad 720p size');f.release();}
   return {size,alpha,invalidRejected,timings};
  } finally {decoder.close();}
 });
 assert.deepEqual(result.size,[64,64]);assert.equal(result.alpha,255);assert.ok(result.invalidRejected);assert.equal(wasmRequests,1);
 console.log('PASS local Chrome JXL WASM worker',JSON.stringify(result),'wasmRequests',wasmRequests);
 await page.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
