import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {spawnSync,execFileSync,execFile} from "node:child_process";
import {promisify} from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import {createCastService} from "../src/lib/vlc-cast.js";
import {vodPlaylist,buildVodSegmentArgs,VOD_CACHE_SEGMENTS} from "../src/lib/vlc-cast-vod.js";

const mockFfmpeg=(_bin,args)=>{
  const p=new EventEmitter();
  p.stderr={resume(){}};
  p.kill=()=>{setImmediate(()=>p.emit("exit",1));return true;};
  const out=args.at(-1);
  void (async()=>{
    try{
      await fs.writeFile(out,Buffer.alloc(320,parseInt(String(args[args.indexOf("-output_ts_offset")+1]),10)%250));
      p.exitCode=0;p.emit("exit",0);
    }catch{p.exitCode=1;p.emit("exit",1);}
  })();
  return p;
};

test("fixed seekable VOD playlist advertises complete 4-hour timeline",()=>{
  const manifest=vodPlaylist(4*3600);
  assert.match(manifest,/#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(manifest,/#EXT-X-ENDLIST/);
  assert.match(manifest,/segment_02399.ts/);
  assert.equal((manifest.match(/#EXTINF:/g)||[]).length,2400);
  assert.equal((manifest.match(/#EXT-X-DISCONTINUITY/g)||[]).length,0);
  const args=buildVodSegmentArgs({video:"video.mp4",audio:"audio.m4a",offset:10800,length:6,output:"/tmp/test.pending"});
  assert.equal(args.filter(x=>x==="10800.000").length,3,"both sources seek identically and PTS offset is constant");
  assert.ok(args.includes("-output_ts_offset"));
  assert.ok(!args.includes("-re"),"on-demand segments must not run in wall clock time");
});

test("mock 4-hour VOD: long pause, arbitrary seek, bounded LRU, sliding lease, hard expiry and revoke",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cast-vod-mock-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let time=Date.now();
  const cast=createCastService({root,publicOrigin:"https://cast.fake.test",enabled:true,
    now:()=>time,resolveSource:async()=>({video:"synthetic-movie.mp4",audio:"synthetic-audio.m4a"}),
    probeDuration:async()=>4*3600,spawnImpl:mockFfmpeg,
    ttlMs:90*60000,idleMs:45*60000,maxMs:6*3600000});
  t.after(()=>cast.close());
  const item=await cast.create({kind:"item",id:"movie"},"signed-owner");
  assert.equal(item.seekable,true);
  assert.equal(item.mode,"vod");
  const app=express();
  app.get("/cast/media/:id/:token/:file",(req,res)=>cast.media(req,res));
  const http=app.listen(0,"127.0.0.1");
  t.after(()=>http.close());
  await new Promise(resolve=>http.once("listening",resolve));
  const base=item.url.replace("https://cast.fake.test","http://127.0.0.1:"+http.address().port);
  const get=(file)=>fetch(base.replace("index.m3u8",file));
  let r=await get("index.m3u8");
  assert.equal(r.status,200);assert.match(await r.text(),/segment_02399.ts/);
  const segment=async(idx)=>{
    const r=await get("segment_"+String(idx).padStart(5,"0")+".ts");
    const body=await r.arrayBuffer();assert.equal(r.status,200,"segment "+idx);
    assert.equal(body.byteLength,320);
  };
  await segment(0);
  const ranged=await fetch(base.replace("index.m3u8","segment_00000.ts"),
    {headers:{Range:"bytes=0-15"}});
  assert.equal(ranged.status,206,"HTTP byte ranges are honored");
  assert.equal((await ranged.arrayBuffer()).byteLength,16);
  time+=6*60000; // paused for six minutes; no encoder runs during pause
  await segment(0);
  await segment(1900); // over three hours into movie, no pre-encoding required
  await segment(10); // backward jump
  for(let i=0;i<70;i++)await segment((i*31)%2400);
  const files=await fs.readdir(path.join(root,item.id));
  assert.ok(files.filter(f=>f.endsWith(".ts")).length<=VOD_CACHE_SEGMENTS,"bounded disk cache");
  for(let n=0;n<3;n++){time+=32*60000;await segment(2050+n);} // receiver alone renews lease, no Cloudflare Access cookie
  assert.ok(new Date(cast.status(item.id,"signed-owner").expiresAt).getTime()>time);
  for(let n=0;n<3;n++){time+=32*60000;await segment(2200+n);}
  assert.equal((await get("segment_02400.ts")).status,404);
  const invalid=base.replace(/\/[A-Za-z0-9_-]{43}\/index/, "/"+"x".repeat(43)+"/index");
  assert.equal((await fetch(invalid)).status,403);
  assert.equal(await cast.stop(item.id),true);
  assert.equal((await get("index.m3u8")).status,410);
  assert.equal((await fs.readdir(root)).length,0);
});

test("mock receiver lease fails closed after idle or hard max even with a good ticket",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cast-vod-expiry-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let time=Date.now();
  const cast=createCastService({root,publicOrigin:"https://cast.fake.test",enabled:true,
    now:()=>time,resolveSource:async()=>({video:"synthetic.mp4"}),probeDuration:async()=>10810,
    spawnImpl:mockFfmpeg,ttlMs:90*60000,idleMs:45*60000,maxMs:6*3600000});
  t.after(()=>cast.close());
  const first=await cast.create({kind:"item",id:"movie"},"signed-owner");
  const app=express();app.get("/cast/media/:id/:token/:file",(req,res)=>cast.media(req,res));
  const http=app.listen(0,"127.0.0.1");t.after(()=>http.close());
  await new Promise(resolve=>http.once("listening",resolve));
  const local=url=>url.replace("https://cast.fake.test","http://127.0.0.1:"+http.address().port);
  time+=46*60000;
  assert.equal((await fetch(local(first.url))).status,410,"pause longer than 45m ends idle authorization");
  const second=await cast.create({kind:"item",id:"movie"},"signed-owner");
  for(let i=0;i<11;i++){
    time+=32*60000;
    assert.equal((await fetch(local(second.url))).status,200,"receiver refreshes sliding lease");
  }
  time+=9*60000;
  assert.equal((await fetch(local(second.url))).status,410,"hard ceiling remains immutable");
});

test("actual ffmpeg generated VOD segment preserves video and separate audio timeline", {timeout:60000},async(t)=>{
  if(spawnSync("ffmpeg",["-version"],{stdio:"ignore"}).status!==0 ||
    spawnSync("ffprobe",["-version"],{stdio:"ignore"}).status!==0){t.skip("ffmpeg missing");return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cast-vod-real-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const video=path.join(root,"video.mp4"),audio=path.join(root,"audio.m4a");
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=320x180:rate=24",
    "-t","15","-an","-c:v","libx264","-pix_fmt","yuv420p","-y",video],{timeout:20000});
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=700:sample_rate=44100",
    "-t","15","-c:a","aac","-y",audio],{timeout:20000});
  const cast=createCastService({root:path.join(root,"cache"),publicOrigin:"https://cast.fake.test",
    enabled:true,resolveSource:async()=>({video,audio})});
  t.after(()=>cast.close());
  const item=await cast.create({kind:"item",id:"movie"},"owner");
  assert.equal(item.seekable,true);
  const app=express();app.get("/cast/media/:id/:token/:file",(req,res)=>cast.media(req,res));
  const http=app.listen(0,"127.0.0.1");t.after(()=>http.close());
  await new Promise(resolve=>http.once("listening",resolve));
  const url=item.url.replace("https://cast.fake.test","http://127.0.0.1:"+http.address().port)
    .replace("index.m3u8","segment_00002.ts");
  const r=await fetch(url);assert.equal(r.status,200);
  const sample=path.join(root,"seek-12s.ts");await fs.writeFile(sample,Buffer.from(await r.arrayBuffer()));
  const streams=JSON.parse(execFileSync("ffprobe",["-v","error","-show_streams","-of","json",sample],
    {timeout:14000}).toString()).streams;
  const v=streams.find(s=>s.codec_name==="h264"),a=streams.find(s=>s.codec_name==="aac");
  assert.ok(v && a,"separate video and audio encoded together");
  assert.ok(Math.abs(Number(v.start_time)-Number(a.start_time))<0.25,"A/V start within 250ms");
  assert.ok(Number(v.start_time)>11,"seeking produces absolute timeline PTS, not reset to zero");
  // An actual HLS reader must be able to traverse all on-demand segments over HTTP.
  const manifestUrl=url.replace("segment_00002.ts","index.m3u8");
  const {stdout}=await promisify(execFile)("ffprobe",
    ["-v","error","-show_entries","format=duration","-of","json",manifestUrl],
    {timeout:30000,maxBuffer:262144});
  const length=Number(JSON.parse(stdout).format.duration);
  assert.ok(length>14 && length<16,"the HLS VOD demuxer traverses all HTTP segments");
});

test("concurrent cast starts reserve their two slots before asynchronous source lookup",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cast-vod-admission-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const waiting=[];
  const cast=createCastService({root,publicOrigin:"https://cast.fake.test",enabled:true,
    resolveSource:()=>new Promise(resolve=>waiting.push(resolve)),
    probeDuration:async()=>12,spawnImpl:mockFfmpeg});
  t.after(()=>cast.close());
  const one=cast.create({kind:"item",id:"one"},"signed-owner");
  const two=cast.create({kind:"item",id:"two"},"signed-owner");
  // Both requests await sweep() once, then acquire their own slot synchronously.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(waiting.length,2);
  await assert.rejects(cast.create({kind:"item",id:"three"},"signed-owner"),{status:429});
  waiting.splice(0).forEach(resolve=>resolve({video:"synthetic.mp4"}));
  assert.equal((await one).status,"ready");
  assert.equal((await two).status,"ready");
  await assert.rejects(cast.create({kind:"item",id:"four"},"signed-owner"),{status:429});
});

test("service close during pending source lookup rejects late session creation",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cast-vod-close-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let finishLookup;
  const cast=createCastService({root,publicOrigin:"https://cast.fake.test",enabled:true,
    resolveSource:()=>new Promise(resolve=>{finishLookup=resolve}),
    probeDuration:async()=>12,spawnImpl:mockFfmpeg});
  const inflight=cast.create({kind:"item",id:"sample"},"owner");
  await new Promise(resolve=>setImmediate(resolve));
  await cast.close();
  finishLookup({video:"synthetic.mp4"});
  await assert.rejects(inflight,{status:503});
  await assert.rejects(cast.create({kind:"item",id:"new"},"owner"),{status:503});
  assert.equal((await fs.readdir(root)).length,0);
});

test("stale VOD scratch cleanup removes only old orphan session directories",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cast-vod-orphans-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const old="abcdefghijklmnop",young="qrstuvwxyzABCDEF",unrelated="your-important-data";
  for(const name of [old,young,unrelated])await fs.mkdir(path.join(root,name));
  const longAgo=new Date(Date.now()-9*3600000);
  await fs.utimes(path.join(root,old),longAgo,longAgo);
  await fs.utimes(path.join(root,unrelated),longAgo,longAgo);
  await fs.writeFile(path.join(root,"persistent.txt"),"don't delete");
  const cast=createCastService({root,publicOrigin:"https://cast.fake.test",enabled:true,
    resolveSource:async()=>({video:"synthetic.mp4"}),probeDuration:async()=>12,
    spawnImpl:mockFfmpeg});
  t.after(()=>cast.close());
  assert.equal(await cast.cleanupStaleScratch(),1);
  assert.deepEqual((await fs.readdir(root)).sort(),
    [young,unrelated,"persistent.txt"].sort());
});
