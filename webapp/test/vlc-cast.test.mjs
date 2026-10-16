import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import {createCastService, buildCastArgs, castYoutubeUrl} from "../src/lib/vlc-cast.js";
import {createCastAccess} from "../src/lib/vlc-cast-access.js";
import {canUseCastReceiver,redactCastMediaPath} from "../src/lib/vlc-cast-routing.js";

test("cast source allowlist and ffmpeg H.264/AAC segmentation",()=>{
  assert.equal(castYoutubeUrl("https://www.youtube.com/watch?v=abc"),true);
  for(const u of ["http://youtube.com/watch?v=x","https://youtube.com.evil.com/watch?v=x",
    "file:///etc/passwd","http://127.0.0.1/private","https://www.youtube.com@localhost/watch"])
    assert.equal(castYoutubeUrl(u),false,u);
  const a=buildCastArgs({video:"v.mp4",audio:"a.m4a",startAt:40,dir:"/tmp/fabricated"});
  assert.deepEqual(a.filter(x=>x==="40"),["40","40"]); // same seek for both tracks
  assert.equal(a[a.indexOf("-map")+1],"0:v:0");
  assert.ok(a.includes("1:a:0"));
  assert.ok(a.some(x=>x.includes("delete_segments"))); // bounded disk (no two-hour cache)
  assert.ok(a.includes("libx264") && a.includes("aac"));
});

test("Access controls verify signature, audience, expiry and subject",async()=>{
  const {privateKey,publicKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
  const jwk=publicKey.export({format:"jwk"});jwk.kid="cast-test-key";
  const issuer="https://fabricated.cloudflareaccess.com";
  const audience="fabricated-issuer-audience-123456";
  const auth=createCastAccess({issuer,audience,fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
  const sign=(overrides={})=>{
    const h=Buffer.from(JSON.stringify({alg:"RS256",kid:jwk.kid})).toString("base64url");
    const c=Buffer.from(JSON.stringify({iss:issuer,aud:[audience],sub:"user-1",exp:Math.floor(Date.now()/1000)+3600,...overrides})).toString("base64url");
    const signature=crypto.sign("RSA-SHA256",Buffer.from(h+"."+c),privateKey).toString("base64url");
    return h+"."+c+"."+signature;
  };
  assert.equal(await auth({get:()=>sign()}),"user-1");
  const req=(header,cookie="")=>({get:(name)=>name==="cf-access-jwt-assertion"?header:name==="cookie"?cookie:null});
  assert.equal(await auth(req(null,"other=1; CF_Authorization="+sign()+"; last=2")),"user-1",
    "cookie from existing Access login works without assertion header");
  assert.equal(await auth(req(null,"CF_Authorization="+sign({exp:Math.floor(Date.now()/1000)+7*86400}))),"user-1",
    "signed Access sessions longer than one day are valid");
  assert.equal(await auth(req(null,"CF_Authorization="+sign({aud:"wrong-aud"}))),null);
  assert.equal(await auth(req(null,"CF_Authorization="+sign({exp:100}))),null);
  assert.equal(await auth(req(null,"CF_Authorization="+sign().slice(0,-4)+"0000")),null);
  assert.equal(await auth(req(null,"XCF_Authorization="+sign())),null,"no prefix cookie matches");
  assert.equal(await auth(req("bogus-header","CF_Authorization="+sign())),null,
    "an invalid assertion cannot be downgraded to a cookie");
  assert.equal(await auth({get:()=>sign({exp:Math.floor(Date.now()/1000)+7*86400})}),"user-1");
  assert.equal(await auth(req(null,"CF_Authorization="+("a".repeat(16001)))),null,
    "oversized cookies rejected");
  assert.equal(await auth({get:()=>sign({aud:"wrong-aud"})}),null);
  assert.equal(await auth({get:()=>sign({exp:100})}),null);
  assert.equal(await auth({get:()=>sign().slice(0,-2)+"zz"}),null);
  assert.equal(await auth({get:()=>""}),null);
  assert.equal(await createCastAccess({issuer:"http://127.0.0.1",audience})({get:()=>sign()}),null);
});

test("synthetic HLS ticket, manifest, segment, revoke, expiry and limits",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"yt-cast-mock-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let clock=Date.now();
  const fakeSpawn=(_path,args)=>{
    const p=new EventEmitter();
    p.stderr={resume(){}};
    p.kill=()=>{p.emit("exit",null);return true;};
    const output=args.at(-1),dir=path.dirname(output);
    void (async()=>{
      await fs.writeFile(path.join(dir,"segment_00000.ts"),Buffer.from("fabricated-segment"));
      await fs.writeFile(output,"#EXTM3U\n#EXTINF:4.0,\nsegment_00000.ts\n");
    })();
    return p;
  };
  const service=createCastService({root,publicOrigin:"https://stream.example",
    enabled:true,resolveSource:async()=>({video:"fabricated.mp4"}),spawnImpl:fakeSpawn,
    now:()=>clock,ttlMs:70000,idleMs:30000});
  t.after(()=>service.close());
  const s=await service.create({kind:"item",id:"sample"},"user-1");
  assert.equal(s.status,"ready");
  assert.ok(!s.url.includes("fabricated.mp4"));
  assert.ok(service.status(s.id,"user-1"));
  assert.equal(service.status(s.id,"someone-else"),null);
  const app=express();
  app.get("/cast/media/:id/:token/:file",(req,res)=>service.media(req,res));
  const server=app.listen(0,"127.0.0.1");
  t.after(()=>server.close());
  await new Promise(resolve=>server.once("listening",resolve));
  const url=s.url.replace("https://stream.example","http://127.0.0.1:"+server.address().port);
  let r=await fetch(url);assert.equal(r.status,200);assert.match(await r.text(),/#EXTM3U/);
  r=await fetch(url.replace("index.m3u8","segment_00000.ts"));assert.equal(r.status,200);
  const bad=url.replace(/\/[A-Za-z0-9_-]{43}\/index/, "/"+"A".repeat(43)+"/index");
  r=await fetch(bad);assert.equal(r.status,403);
  r=await fetch(url.replace("index.m3u8","../../private"));assert.notEqual(r.status,200);
  clock+=71000;
  r=await fetch(url);assert.equal(r.status,410);
  assert.equal(service.status(s.id,"user-1"),null);
  const s2=await service.create({kind:"item",id:"sample"},"user-1");
  assert.equal(await service.stop(s2.id),true);
  r=await fetch(s2.url.replace("https://stream.example","http://127.0.0.1:"+server.address().port));
  assert.equal(r.status,410);
  await assert.rejects(service.create({kind:"url",url:"http://127.0.0.1"},"user-1"),{status:400});
});

test("real ffmpeg produces playable A/V HLS from fabricated media (when installed)",{timeout:45000},async(t)=>{
  const ffmpeg=spawnSync("ffmpeg",["-version"],{stdio:"ignore"});
  const ffprobe=spawnSync("ffprobe",["-version"],{stdio:"ignore"});
  if(ffmpeg.status!==0 || ffprobe.status!==0){t.skip("ffmpeg/ffprobe not installed");return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"yt-cast-real-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fixture=path.join(root,"synthetic.mp4");
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=320x180:rate=24",
    "-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t","7","-c:v","libx264","-pix_fmt","yuv420p",
    "-c:a","aac","-y",fixture],{timeout:18000});
  const service=createCastService({root:path.join(root,"segments"),publicOrigin:"https://stream.example",
    enabled:true,resolveSource:async()=>({video:fixture}),readyTimeoutMs:20000});
  t.after(()=>service.close());
  const created=await service.create({kind:"item",id:"sample"},"fabricated");
  const dir=path.join(root,"segments",created.id);
  const list=await fs.readFile(path.join(dir,"index.m3u8"),"utf8");
  assert.match(list,/#EXTM3U/);
  const segment=path.join(dir,list.match(/segment_\d{5}\.ts/)[0]);
  const streams=JSON.parse(execFileSync("ffprobe",["-v","error","-show_streams","-of","json",segment],{timeout:15000}).toString()).streams;
  assert.ok(streams.some(s=>s.codec_name==="h264"),"H.264 segment");
  assert.ok(streams.some(s=>s.codec_name==="aac"),"AAC segment");
  const video=streams.find(s=>s.codec_name==="h264"), audio=streams.find(s=>s.codec_name==="aac");
  assert.ok(Math.abs(Number(video.start_time)-Number(audio.start_time))<0.25,
    "fabricated HLS A/V starts within 250 ms");
});

test("public receiver hostname rejects app, API and other routes",()=>{
  const h="cast.ameshalex.com", id="a".repeat(16),token="t".repeat(43);
  const path="/cast/media/"+id+"/"+token+"/index.m3u8";
  assert.equal(canUseCastReceiver({method:"GET",path,hostname:h,receiverHost:h}),true);
  assert.equal(canUseCastReceiver({method:"HEAD",path,hostname:h,receiverHost:h}),true);
  for (const bad of ["/","/api/health","/api/cast/sessions", "/stream/youtube",
      "/cast/media/"+id+"/"+token+"/index.m3u8/anything",
      "/cast/media/"+id+"/"+token+"/../../src/server.js",
      "/cast/media/"+id+"/"+token+"/playlist.m3u8"]) {
    assert.equal(canUseCastReceiver({method:"GET",path:bad,hostname:h,receiverHost:h}),false,bad);
  }
  assert.equal(canUseCastReceiver({method:"POST",path,hostname:h,receiverHost:h}),false);
  assert.equal(canUseCastReceiver({method:"GET",path,hostname:"stream.ameshalex.com",receiverHost:h}),false);
});

test("media ticket is redacted from application error log paths",()=>{
  const id="a".repeat(16),token="b".repeat(43);
  const path="/cast/media/"+id+"/"+token+"/segment_00001.ts";
  const output=redactCastMediaPath("HTTP failed "+path+" internal");
  assert.ok(!output.includes(id) && !output.includes(token));
  assert.match(output,/\/cast\/media\/\[redacted\]\/segment_00001\.ts/);
  assert.equal(redactCastMediaPath("/api/health"),"/api/health");
});
