// Actual UI-mode click gating in isolated local Chrome. No production requests.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const frame480=await fs.readFile(path.join(process.env.JXL_WASM_SAMPLES_DIR || path.resolve(root, '../test/fixtures/jxl-wasm'),'480p.jxl'));
let wasmFetches=0;
let seekBusyResponses=0;
let seekAccepted=0;
let serverJxlAvailable=true;
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
 const wanted=new URL(req.url,'http://localhost').pathname;
 if(wanted==='/test/disable'){serverJxlAvailable=false;res.end('ok');return;}
 if(wanted==='/test/enable'){serverJxlAvailable=true;res.end('ok');return;}
 if(wanted==='/synthetic-jxl-bad') {
  res.writeHead(200,{'content-type':'multipart/x-mixed-replace; boundary=frame','x-mjpeg-fps':'12'});
  for(let i=0;i<8;i++) {
    const bytes=i===3?Buffer.from([0xff,0x0a,0,0,0,0]):frame480;
    res.write(`--frame\r\nContent-Type: image/jxl\r\nContent-Length: ${bytes.length}\r\n\r\n`);
    res.write(bytes);res.write('\r\n');
  }
  res.end('--frame--\r\n');return;
 }
 if(wanted==='/synthetic-jxl-seek') {
  const target=Number(new URL(req.url,'http://localhost').searchParams.get('timestamp')||0);
  if(target>0 && seekBusyResponses<2){seekBusyResponses++;res.writeHead(429,{'content-type':'application/json'});res.end('{"error":"encoder busy"}');return;}
  seekAccepted++;
  res.writeHead(200,{'content-type':'multipart/x-mixed-replace; boundary=frame','x-mjpeg-fps':new URL(req.url,'http://localhost').searchParams.get('fps')||'12'});
  for(let i=0;i<90;i++){
   res.write(`--frame\r\nContent-Type: image/jxl\r\nContent-Length: ${frame480.length}\r\n\r\n`);
   res.write(frame480);res.write('\r\n');
  }
  res.end('--frame--\r\n');return;
 }
 if(wanted==='/api/experimental/jxl') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({available:serverJxlAvailable,reason:serverJxlAvailable?null:'disabled for test'}));return;}
 if(wanted.startsWith('/api/')) {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,playlists:[],items:[],sessions:[],data:[]}));return;}
 const relative=wanted==='/'?'/index.html':decodeURIComponent(wanted);
 const file=path.resolve(root,'.'+relative);
 if(!file.startsWith(root+path.sep)) {res.writeHead(403);res.end();return;}
 try{const b=await fs.readFile(file);if(file.endsWith('.wasm'))wasmFetches++;res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(b);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.MOBILE_TEST_CHROME||process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const url='http://127.0.0.1:'+server.address().port;
 await page.goto(url+'/?ui=classic',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>typeof window.browserSupportsExperimentalJxl==='function' && typeof window.renderYoutubePlaybackMethod==='function');
 assert.equal(wasmFetches,0,'JXL WASM cannot load before the button is selected');
 await page.evaluate(()=>{
  browserSupportsExperimentalJxl=async()=>false; // simulate Tesla lacking native JXL
  const Orig=window.Worker;
  window.__workerStats={created:0,terminated:0};
  window.Worker=class TrackedWorker extends Orig{
   constructor(...args){super(...args);window.__workerStats.created++;}
   terminate(){window.__workerStats.terminated++;super.terminate();}
  };
 });
 const jxl=page.locator('[data-playback-method="jxl"]');
 await jxl.click();
 await page.waitForFunction(()=>document.querySelector('[data-playback-method="jxl"]').getAttribute('aria-pressed')==='true',{timeout:12000});
 const activated=await page.evaluate(()=>({mode:youtubePlaybackMethod,worker:Boolean(jxlWasmDecoder),stats:window.__workerStats,stored:localStorage.getItem('ytStreamerYoutubePlaybackMethod')}));
 assert.equal(activated.mode,'jxl');assert.equal(activated.worker,true);assert.equal(activated.stored,null);assert.equal(wasmFetches,1);
 // Reproduce a real in-player seek while the previous JXL encoder is still
 // handing off. Two HTTP 429 responses must be retried without leaving JXL,
 // and any in-flight pre-seek decoder work must be discarded.
 await page.evaluate(()=>{
   replayFn=(startAt=0)=>playBufferedMjpegStream({mjpegUrl:'/synthetic-jxl-seek?timestamp='+startAt,audioUrl:null},'Seek regression',
     {experimentalJxl:true,seekable:true,duration:300,startAt});
   replayFn(0);
 });
 await page.waitForFunction(()=>window.__YT_STREAMER_BUFFER_STATS__?.renderedFrames>=1,{timeout:12000});
 await page.evaluate(()=>seekStreamTo(90));
 await page.waitForFunction(()=>streamSeek.startAt===90 && window.__YT_STREAMER_BUFFER_STATS__?.renderedFrames>=1,{timeout:15000});
 const afterSeek=await page.evaluate(()=>({mode:youtubePlaybackMethod,worker:Boolean(jxlWasmDecoder),profile:jxlWasmDecoder?.profile,
   current:getStreamCurrentTime(),workers:window.__workerStats,video:activeCompat?.mjpegUrl}));
 assert.equal(afterSeek.mode,'jxl');assert.equal(afterSeek.worker,true);
 assert.equal(afterSeek.workers.created,2);assert.equal(afterSeek.workers.terminated,1);
 assert.equal(seekBusyResponses,2);assert.ok(seekAccepted>=2);
 assert.match(afterSeek.video,/timestamp=90/);
 assert.match(afterSeek.video,/wasm=1/);
 assert.ok([12,15].includes(afterSeek.profile.fps));
 assert.match(afterSeek.video,/fps=(?:12|15)/);
 await page.locator('[data-playback-method="mjpeg"]').click();
 const afterSwitch=await page.evaluate(()=>({mode:youtubePlaybackMethod,worker:Boolean(jxlWasmDecoder),stats:window.__workerStats}));
 assert.equal(afterSwitch.mode,'mjpeg');assert.equal(afterSwitch.worker,false);assert.equal(afterSwitch.stats.created,afterSwitch.stats.terminated);
 // An actual multipart stream with a corrupted JXL frame must return to MJPEG.
 await jxl.click();
 await page.waitForFunction(()=>document.querySelector('[data-playback-method="jxl"]').getAttribute('aria-pressed')==='true');
 await page.evaluate(()=>{
   window.__jxlFallbackCalled=false;
   playBufferedMjpegStream({mjpegUrl:'/synthetic-jxl-bad',audioUrl:null},'Synthetic corrupt JXL',{experimentalJxl:true,seekable:false});
   replayFn=()=>{window.__jxlFallbackCalled=true;return Promise.resolve();};
 });
 await page.waitForFunction(()=>window.__jxlFallbackCalled===true,{timeout:12000});
 const recovered=await page.evaluate(()=>({mode:youtubePlaybackMethod,worker:Boolean(jxlWasmDecoder),jxl:document.querySelector('[data-playback-method="jxl"]').getAttribute('aria-pressed'),stats:window.__workerStats}));
 assert.equal(recovered.mode,'mjpeg');assert.equal(recovered.worker,false);assert.equal(recovered.jxl,'false');
 await page.evaluate(()=>localStorage.setItem('ytStreamerYoutubePlaybackMethod','jxl'));
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>typeof window.renderYoutubePlaybackMethod==='function');
 const afterReload=await page.evaluate(()=>({mode:youtubePlaybackMethod,jxl:document.querySelector('[data-playback-method="jxl"]').getAttribute('aria-pressed')}));
 assert.equal(afterReload.mode,'mjpeg');assert.equal(afterReload.jxl,'false');assert.ok(wasmFetches>=3);
 // A failed encoder check must close a probed WebAssembly worker and not opt in.
 await page.goto(url+'/test/disable');await page.goto(url+'/?ui=classic');
 await page.waitForFunction(()=>typeof window.browserSupportsExperimentalJxl==='function');
 await page.evaluate(()=>{
  browserSupportsExperimentalJxl=async()=>false;
  const Orig=window.Worker;window.__workerStats={created:0,terminated:0};
  window.Worker=class TrackedWorker extends Orig{constructor(...args){super(...args);window.__workerStats.created++;}terminate(){window.__workerStats.terminated++;super.terminate();}};
 });
 await page.locator('[data-playback-method="jxl"]').click();
 await page.waitForFunction(()=>window.__workerStats?.terminated===1,{timeout:12000});
 const blocked=await page.evaluate(()=>({mode:youtubePlaybackMethod,worker:Boolean(jxlWasmDecoder),stats:window.__workerStats}));
 assert.equal(blocked.mode,'mjpeg');assert.equal(blocked.worker,false);assert.equal(blocked.stats.created,1);
 assert.equal(errors.length,0,errors.join(';'));
 console.log('PASS opt-in mode, seek 429 retry/worker reset, FPS probe, corrupt-stream MJPEG recovery, reload reset, encoder block',JSON.stringify({activated,afterSeek,seekBusyResponses,seekAccepted,afterSwitch,recovered,afterReload,blocked,wasmFetches}));
 await page.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
