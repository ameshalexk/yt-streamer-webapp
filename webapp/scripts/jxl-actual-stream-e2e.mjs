import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chromium} from "playwright-core";
import {streamJxl} from "../src/lib/jxl-stream.js";
import {buildMjpegArgs} from "../src/lib/stream.js";

// Real input/container, real production argument builder, real libjxl,
// production frame parser and browser decoder. Localhost only, temporary data.
const folder=fs.mkdtempSync(path.join(os.tmpdir(),"yt-jxl-e2e-"));
const mp4=path.join(folder,"real-source.mp4");
const sysffmpeg=process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const result=spawnSync(sysffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=320x180:rate=6",
  "-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t","4",
  "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest","-y",mp4],
 {timeout:20000,encoding:"utf8"});
assert.equal(result.status,0,result.stderr);
const routes=[];
const server=http.createServer((req,res)=>{
  if(req.url.startsWith("/stream")){
    routes.push(req.url);
    const seek=Number(new URL(req.url,"http://localhost").searchParams.get("seek")||0);
    streamJxl(req,res,{
      input:mp4,params:{height:180,fps:6,quality:7},isLive:false,
      startAt:seek,allowBurst:true
    },buildMjpegArgs);
    return;
  }
  res.writeHead(200,{"content-type":"text/html"});res.end("<body>JXL E2E</body>");
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const browser=await chromium.launch({executablePath:process.env.JXL_TEST_BROWSER||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--no-sandbox"]});
try{
 const page=await browser.newPage();
 await page.goto("http://127.0.0.1:"+server.address().port+"/");
 await page.addScriptTag({path:"public/buffered-mjpeg.js"});
 for(const seek of [0,1]){
   const outcome=await page.evaluate(seek=>new Promise(resolve=>{
     const canvas=document.createElement("canvas"); canvas.width=320;canvas.height=180;document.body.append(canvas);
     let done=false;
     const finish=(which,error)=>{
       if(done)return;done=true;
       const stats=player.getStats();
       player.destroy();canvas.remove();
       resolve({which,received:stats.receivedFrames,rendered:stats.renderedFrames,error:error?String(error):null});
     };
     const player=new window.BufferedMjpeg.BufferedMjpegPlayer({
       url:"/stream?seek="+seek,canvas,fps:6,frameFormat:"jxl",startupSeconds:.3,rebufferSeconds:.3,
       audioEnabled:()=>false,onError:e=>finish("error",e),onEnded:()=>finish("ended")
     });
     player.start();setTimeout(()=>finish("timeout"),10000);
   }),seek);
   console.log("seek",seek,outcome);
   assert.equal(outcome.which,"ended","Real stream should end normally");
   assert.ok(outcome.received>=10 && outcome.rendered>0,"JXL frames must reach canvas");
 }
 assert.equal(routes.length,2);
 console.log("PASS real source+audio-track input, real MJPEG builder, JXL encode+HTTP+Chrome canvas, seek=0/1.");
}finally{
 await browser.close();await new Promise(ok=>server.close(ok));fs.rmSync(folder,{recursive:true,force:true});
}
