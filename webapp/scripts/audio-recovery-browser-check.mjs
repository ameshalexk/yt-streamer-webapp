// Real Chrome playback integration with a deliberately failing first audio
// request and a working MP3 on retry. No production source/API is touched.
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../public");
const ffmpeg=process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const image=spawnSync(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=red:s=320x180:r=1","-frames:v","1","-q:v","7","-c:v","mjpeg","-f","image2pipe","pipe:1"],{timeout:12000,maxBuffer:1000000});
assert.equal(image.status,0,image.stderr?.toString());
const audio=spawnSync(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t","16","-vn","-c:a","libmp3lame","-f","mp3","pipe:1"],{timeout:15000,maxBuffer:2000000});
assert.equal(audio.status,0,audio.stderr?.toString());
let audioRequests=0, firstFailure=false, forceFailures=false;
const types={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".svg":"image/svg+xml"};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://127.0.0.1");
 if(url.pathname==="/audio-test"){
  audioRequests++;
  if(audioRequests===1 || forceFailures){
    firstFailure=true;
    res.writeHead(502,{"content-type":"application/json"});
    res.end(JSON.stringify({error:"Temporary audio provider failure",retryable:true}));
  } else {
    res.writeHead(200,{"content-type":"audio/mpeg","cache-control":"no-store"});
    res.end(audio.stdout);
  }
  return;
 }
 if(url.pathname==="/video-test"){
  res.writeHead(200,{"content-type":"multipart/x-mixed-replace; boundary=videotest","cache-control":"no-store"});
  const part=Buffer.concat([Buffer.from("--videotest\r\nContent-Type: image/jpeg\r\nContent-Length: "+image.stdout.length+"\r\n\r\n"),image.stdout,Buffer.from("\r\n")]);
  let frames=0;
  const timer=setInterval(()=>{
    if(res.destroyed || frames++ > 150){clearInterval(timer);if(!res.destroyed)res.end();return;}
    res.write(part);
  },70);
  res.on("close",()=>clearInterval(timer));
  return;
 }
 if(url.pathname.startsWith("/api/")){
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({ok:true,playlists:[],items:[],sessions:[],data:[]}));
  return;
 }
 const filename=url.pathname==="/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\//,"");
 const pathname=path.resolve(root,filename);
 if(!pathname.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{
  const content=await fs.readFile(pathname);
  res.writeHead(200,{"content-type":types[path.extname(pathname)]||"application/octet-stream","cache-control":"no-store"});
  res.end(content);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const browser=await chromium.launch({
 executablePath:process.env.MOBILE_TEST_CHROME||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 headless:true,args:["--no-sandbox","--autoplay-policy=no-user-gesture-required"]
});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
 page.on("pageerror",e=>console.log("PageError:",e.message));
 await page.goto("http://127.0.0.1:"+server.address().port+"/",{waitUntil:"domcontentloaded"});
 await page.waitForFunction(()=>typeof window.playBufferedMjpegStream==="function",{timeout:14000});
 await page.evaluate(()=>{
   window.playBufferedMjpegStream({mjpegUrl:"/video-test?fps=12",audioUrl:"/audio-test"}, "Audio recovery test", {seekable:false,bufferedMjpeg:true});
 });
 await page.waitForFunction(()=>document.querySelector("#activePlaybackAudio")?.textContent.includes("reconnecting"),{timeout:9000});
 console.log("First audio failure correctly visible:",await page.locator("#activePlaybackAudio").textContent(),"requests",audioRequests);
 await page.waitForFunction(()=>document.querySelector("#activePlaybackAudio")?.textContent.includes("synchronized") && document.querySelector("#audio")?.currentTime > 0.25,{timeout:15000});
 const final=await page.evaluate(()=>({
  status:document.querySelector("#activePlaybackAudio").textContent,
  codec:document.querySelector("#activePlaybackCodec").textContent,
  elapsed:document.querySelector("#audio").currentTime,
  retryVisible:!!document.querySelector("#playerRetryAudioBtn").getClientRects().length,
  stats:activeCompat?.bufferedPlayer?.getStats?.()
 }));
 console.log("Recovery result",JSON.stringify({status:final.status,codec:final.codec,elapsed:final.elapsed,requestCount:audioRequests,retryVisible:final.retryVisible,rendered:final.stats?.renderedFrames}));
 assert.equal(firstFailure,true);
 assert.ok(audioRequests>=2,"Audio URL must be re-requested after failure");
 assert.match(final.status,/synchronized/);
 assert.match(final.codec,/MJPEG/);
 assert.equal(final.retryVisible,false);
 assert.ok(final.elapsed>0.25,"Recovered audio must actually advance");
 // The active codec differs from merely selecting an option. JXL render state
 // is independently labeled; it must not quietly claim MJPEG is in use.
 await page.evaluate(()=>{
   activeCompat.frameFormat="jxl";
   updateActivePlaybackStatus();
 });
 assert.match(await page.locator("#activePlaybackCodec").textContent(),/JPEG XL · (?:native )?JXL/);

 // Exhaust all bounded automatic retries, verify the UI does not claim sound,
 // then allow recovery by tapping the visible manual control.
 forceFailures=true;
 const failuresStart=audioRequests;
 await page.evaluate(()=>{
   window.playBufferedMjpegStream({mjpegUrl:"/video-test?fps=12",audioUrl:"/audio-test?phase=fail"}, "Permanent audio failure test", {seekable:false,bufferedMjpeg:true});
 });
 await page.waitForFunction(()=>document.querySelector("#activePlaybackAudio")?.textContent.includes("video clock (silent)"),{timeout:22000});
 assert.equal(audioRequests-failuresStart,4,"Expected one initial audio request + three retries");
 assert.equal(await page.locator("#playerRetryAudioBtn").isVisible(),true,"Manual recovery must be visible");
 console.log("Silent fallback correctly displayed after three retries; requests:",audioRequests-failuresStart);
 forceFailures=false;
 await page.locator("#playerRetryAudioBtn").click();
 await page.waitForFunction(()=>document.querySelector("#activePlaybackAudio")?.textContent.includes("synchronized") && document.querySelector("#audio")?.currentTime>0.2,{timeout:13000});
 assert.equal(await page.locator("#playerRetryAudioBtn").isVisible(),false);
 console.log("Manual Retry audio restored synchronized playback");

}finally{
 await browser.close();
 await new Promise(ok=>server.close(ok));
}
