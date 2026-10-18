import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import express from "express";
import {streamAudio, activeAudioCount} from "../src/lib/stream.js";

const folder=fs.mkdtempSync(path.join(os.tmpdir(),"ytstreamer-audio-e2e-"));
const clip=path.join(folder,"audible.m4a");
const silent=path.join(folder,"silent.mp4");
const ffmpeg=process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
function make(args){
 const p=spawnSync(ffmpeg,["-v","error",...args],{timeout:15000,encoding:"utf8"});
 assert.equal(p.status,0,p.stderr);
}
make(["-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t","2","-c:a","aac","-y",clip]);
make(["-f","lavfi","-i","color=c=red:s=32x32:r=2","-t","1","-an","-c:v","mpeg4","-y",silent]);
const app=express();
app.get("/audio/valid",(req,res)=>streamAudio(req,res,{input:clip}));
app.get("/audio/missing",(req,res)=>streamAudio(req,res,{input:silent}));
const server=http.createServer(app);
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const base="http://127.0.0.1:"+server.address().port;
try{
 const good=await fetch(base+"/audio/valid");
 const bytes=new Uint8Array(await good.arrayBuffer());
 assert.equal(good.status,200);
 assert.match(good.headers.get("content-type"),/audio\/mpeg/);
 assert.ok(bytes.length>4000,"MP3 should stream real audio bytes; request close must NOT kill encoder");
 console.log("Audio success",good.status,bytes.length,"bytes");
 const missing=await fetch(base+"/audio/missing");
 const failed=await missing.json();
 assert.equal(missing.status,502);
 assert.match(failed.error,/Audio source unavailable/);
 console.log("Silent source correctly fails",missing.status,failed.error);
 assert.equal(activeAudioCount(),0);
 console.log("PASS request lifecycle and real audio vs no-audio HTTP response semantics");
} finally {
 await new Promise(done=>server.close(done));
 fs.rmSync(folder,{recursive:true,force:true});
}
