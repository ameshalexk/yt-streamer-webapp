import http from "node:http";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import fs from "node:fs";
// Real FFmpeg process + multipart transport + real Chrome bitmap decoding.
// Never starts the YT Streamer production server.
const { streamJxl, jxlEncoderStatus } = await import("../src/lib/jxl-stream.js");
const buildTestMjpegArgs = () => [
  "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "color=c=red:size=64x64:rate=4", "-t", "2", "-map", "0:v:0",
  "-q:v", "7", "-f", "mpjpeg", "pipe:1",
];
const status=jxlEncoderStatus();
assert.equal(status.available,true, status.reason || "No isolated JXL encoder");
assert.ok(process.env.JXL_FFMPEG_PATH, "Never run with the default FFmpeg");
const server=http.createServer((req,res)=>{
  if (req.url === "/stream") return streamJxl(req,res,{
    input:"synthetic.mp4",params:{fps:4,height:64,quality:7},isLive:false
  },buildTestMjpegArgs);
  res.writeHead(200,{"content-type":"text/html"});res.end("<body><h1>Local JXL test</h1></body>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
const executablePath = process.env.JXL_TEST_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(executablePath)) throw new Error("Set JXL_TEST_BROWSER to the installed Chrome 155+ path");
const browser=await chromium.launch({executablePath,headless:true,args:["--no-sandbox"]});
try {
  const page=await browser.newPage();
  page.on("console",msg=>console.log("Chrome console",msg.text()));
  await page.goto("http://127.0.0.1:"+port+"/");
  await page.addScriptTag({path:"public/buffered-mjpeg.js"});
  const result=await page.evaluate(()=>new Promise(resolve=>{
    const canvas=document.createElement("canvas");canvas.width=64;canvas.height=64;document.body.append(canvas);
    let done=false;
    const result=(which,extras={})=>{
       if(done)return;done=true;const stats=player.getStats();
       const pixel=[...canvas.getContext("2d").getImageData(32,32,1,1).data];
       resolve({which,stats,pixel,...extras});player.destroy();
    };
    const player=new window.BufferedMjpeg.BufferedMjpegPlayer({
      url:"/stream",canvas, fps:4,frameFormat:"jxl",startupSeconds:0.25,
      rebufferSeconds:0.25,maxQueueSeconds:3,audioEnabled:()=>false,
      onError:error=>result("error",{error:String(error)}),
      onEnded:()=>result("ended")
    });
    player.start();
    setTimeout(()=>result("timeout"),6000);
  }));
  console.log(JSON.stringify({mode:result.which,received:result.stats.receivedFrames,rendered:result.stats.renderedFrames,decodeMs:result.stats.averageDecodeMs,pixel:result.pixel,error:result.error||null},null,2));
  assert.ok(result.stats.receivedFrames === 8, "Expected 8 real JXL frames from isolated FFmpeg");
  assert.ok(result.stats.renderedFrames >= 1, "JXL frames were not decoded and rendered by real Chrome");
  assert.ok(result.pixel[0] > 80 && result.pixel[0] > result.pixel[1], "Canvas does not contain expected red test frame");
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
