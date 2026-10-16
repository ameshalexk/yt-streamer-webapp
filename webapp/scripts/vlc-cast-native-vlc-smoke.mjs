// Optional Mac-only VLC interoperability smoke test. Runs an isolated HTTP
// origin, synthetic media, and a one-off headless VLC subprocess; never touches
// the deployed YT Streamer service or personal media. No Chromecast assertions.
import {spawn,execFileSync} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import {createCastService} from "../src/lib/vlc-cast.js";

const vlcPath=process.env.VLC_BINARY || "/Applications/VLC.app/Contents/MacOS/VLC";
const root=await fs.mkdtemp(path.join(os.tmpdir(),"yt-cast-vlc-native-"));
let service,listener;
const ffmpeg=(args)=>execFileSync("ffmpeg",["-hide_banner","-loglevel","error",...args],
  {timeout:30000});
try {
  await fs.access(vlcPath);
  const video=path.join(root,"video.mp4");
  const audio=path.join(root,"audio.m4a");
  ffmpeg(["-f","lavfi","-i","testsrc2=size=320x180:rate=24",
    "-t","14","-an","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-y",video]);
  ffmpeg(["-f","lavfi","-i","sine=frequency=500:sample_rate=44100",
    "-t","14","-c:a","aac","-y",audio]);
  service=createCastService({root:path.join(root,"segments"),
    publicOrigin:"https://cast.fixture.invalid",enabled:true,
    resolveSource:async()=>({video,audio})});
  const item=await service.create({kind:"item",id:"fixture"},"local-test-owner");
  if(!item.seekable)throw Error("fixture must be seekable");
  const app=express();
  app.get("/cast/media/:id/:token/:file",(req,res)=>service.media(req,res));
  listener=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>listener.once("listening",resolve));
  const input=item.url.replace("https://cast.fixture.invalid",
    "http://127.0.0.1:"+listener.address().port);
  const output=path.join(root,"vlc-output.ts");
  const args=["--ignore-config","--intf","dummy","--no-media-library",
    "--no-video","--no-audio","--no-video-title-show","--no-sout-all",
    "--sout=#standard{access=file,mux=ts,dst="+output+"}",
    "--play-and-exit",input,"vlc://quit"];
  const started=Date.now();
  const outcome=await new Promise((resolve,reject)=>{
    const child=spawn(vlcPath,args,{stdio:["ignore","ignore","pipe"]});
    let log="";
    child.stderr.on("data",chunk=>{log=(log+chunk).slice(-5000)});
    const timer=setTimeout(()=>child.kill("SIGKILL"),35000);
    child.once("error",error=>{clearTimeout(timer);reject(error)});
    child.once("exit",(code,signal)=>{clearTimeout(timer);resolve({code,signal,log})});
  });
  const stat=await fs.stat(output).catch(()=>null);
  if(!stat || stat.size<3000){
    throw Error("VLC did not stream-out TS media: "+JSON.stringify(outcome));
  }
  const streams=JSON.parse(execFileSync("ffprobe",["-v","error","-show_streams",
    "-of","json",output],{timeout:12000}).toString()).streams;
  const kinds=streams.map(s=>s.codec_name);
  if(!kinds.includes("h264") || !kinds.includes("aac")){
    throw Error("VLC output missing codecs: "+kinds);
  }
  console.log(JSON.stringify({result:"PASS native Mac VLC demux and stream-out",
    bytes:stat.size,codecs:kinds,elapsedMs:Date.now()-started,
    warning:"Not an iPhone VLC or physical Chromecast test."}));
} finally {
  if(listener) await new Promise(resolve=>listener.close(resolve));
  if(service)await service.close();
  await fs.rm(root,{recursive:true,force:true});
}
