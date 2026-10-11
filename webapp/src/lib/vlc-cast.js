import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {probeVodDuration, vodPlaylist, makeVodSegment, VOD_MAX_SECONDS} from "./vlc-cast-vod.js";

// Standalone opt-in HLS service. Never changes the browser's existing transports.
export const castYoutubeUrl = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.port
      && ["youtube.com","www.youtube.com","m.youtube.com","youtu.be"].includes(u.hostname)
      && (u.hostname === "youtu.be" || /^\/(watch|shorts\/[^/]+|live\/[^/]+)$/.test(u.pathname));
  } catch { return false; }
};
const digest = (s) => crypto.createHash("sha256").update(s).digest();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export function buildCastArgs({video,audio,live=false,startAt=0,dir}) {
  if (!video || !dir) throw Error("Missing video or output path");
  const a = ["-hide_banner","-loglevel","error"];
  if (!live) a.push("-re");
  if (!live && startAt > 0) a.push("-ss",String(startAt));
  a.push("-i",video);
  if (audio) {
    if (!live && startAt > 0) a.push("-ss",String(startAt));
    a.push("-i",audio);
  }
  a.push("-map","0:v:0","-map",audio ? "1:a:0" : "0:a:0?",
    "-vf","scale=trunc(min(854\\,iw)/2)*2:-2,fps=24",
    "-c:v","libx264","-preset","veryfast","-profile:v","main","-level","3.1",
    "-pix_fmt","yuv420p","-b:v","1300k","-maxrate","1600k","-bufsize","3200k",
    "-g","96","-keyint_min","96","-sc_threshold","0",
    "-c:a","aac","-b:a","128k","-ac","2","-ar","44100",
    "-f","hls","-hls_time","4","-hls_segment_type","mpegts",
    "-hls_list_size", "8",
    "-hls_flags","independent_segments+temp_file+delete_segments",
    "-hls_segment_filename",path.join(dir,"segment_%05d.ts"),
    path.join(dir,"index.m3u8"));
  return a;
}
export function createCastService({root,publicOrigin,resolveSource,ffmpegPath="ffmpeg",
  enabled=false, now=Date.now, spawnImpl=spawn, ttlMs=90*60_000,
  idleMs=45*60_000, maxMs=6*60*60_000, readyTimeoutMs=15000,
  probeDuration=probeVodDuration}) {
  const sessions = new Map();
  const rates = new Map();
  let creating=0;
  let closed=false;
  let origin="";
  try {
    const u = new URL(publicOrigin);
    if (u.protocol==="https:" && !u.username && !u.password && u.pathname==="/" && !u.search && !u.hash) origin=u.origin;
  } catch {}
  const available = !!(enabled && origin && root && resolveSource);
  function headers(res) {
    res.set({"Cache-Control":"private, no-store, max-age=0",
      "CDN-Cache-Control":"no-store","Cloudflare-CDN-Cache-Control":"no-store",
      "Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
      "X-Robots-Tag":"noindex, nofollow, nosnippet"});
  }
  async function stop(id) {
    const s=sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    s.stopping=true;
    // Wait briefly for FFmpeg to release files before removing the scratch directory.
    if (s.ff && s.ff.exitCode == null) {
      await new Promise((done) => {
        let finished=false;
        const finish=()=>{if(finished)return;finished=true;clearTimeout(timeout);done();};
        const timeout=setTimeout(()=>{try{s.ff.kill("SIGKILL");}catch{}finish();},1200);
        s.ff.once("exit",finish);
        try {s.ff.kill("SIGTERM");} catch {finish();}
      });
    }
    await fs.rm(s.dir,{recursive:true,force:true});
    return true;
  }
  async function sweep() {
    for(const s of sessions.values()) {
      if(now()>=s.exp || now()>=s.maxAt || now()-s.last>idleMs || s.state==="error") await stop(s.id);
    }
  }
  const timer=setInterval(()=>{void sweep().catch(()=>{});},30000);
  timer.unref?.();
  async function create(body, owner) {
    if(!available || closed) throw Object.assign(Error("Cast unavailable until access is configured"),{status:503});
    await sweep();
    // Reserve a slot before asynchronous source resolution/probing. Concurrent
    // creation requests must not bypass the two-session encoder cap.
    if(sessions.size+creating>=2) throw Object.assign(Error("Two cast sessions already active"),{status:429});
    creating++;
    try {
    const {kind,id,url} = body || {};
    const startAt=Number(body?.startAt || 0);
    if(!Number.isFinite(startAt) || startAt<0 || startAt>43200 ||
      !(((kind==="item" || kind==="legacy") && /^[\w-]{1,120}$/.test(id || "") && !url)
        || (kind==="youtube" && castYoutubeUrl(url) && !id))) {
      throw Object.assign(Error("Unsupported cast source"),{status:400});
    }
    const src=await resolveSource({kind,id,url});
    if(closed) throw Object.assign(Error("Cast service shutting down"),{status:503});
    if(!src?.video) throw Object.assign(Error("Video unavailable"),{status:422});
    // A fixed on-demand VOD timeline supports arbitrary seeking and long pauses.
    // Unknown-duration sources retain the existing rolling handoff, explicitly marked nonseekable.
    let duration=null;
    try {duration=await probeDuration(src.video);}catch{}
    if(duration != null && (!Number.isFinite(duration) || duration<=0 || duration>VOD_MAX_SECONDS))
      throw Object.assign(Error("VLC VOD supports movies up to 4 hours 15 minutes"),{status:422});
    if(closed) throw Object.assign(Error("Cast service shutting down"),{status:503});
    const sid=crypto.randomBytes(12).toString("base64url");
    const token=crypto.randomBytes(32).toString("base64url");
    const dir=path.join(root,sid);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    if(closed){
      await fs.rm(dir,{recursive:true,force:true});
      throw Object.assign(Error("Cast service shutting down"),{status:503});
    }
    const s={id:sid,owner,tokenHash:digest(token),dir,ff:null,exp:now()+ttlMs,
      maxAt:now()+maxMs,last:now(),state:"starting",duration,
      source:src,cache:new Map(),pending:new Map(),pins:new Map(),activeTransfers:0,
      queue:Promise.resolve(),stopping:false};
    sessions.set(sid,s);
    try {
      if(duration != null){
        await fs.writeFile(path.join(dir,"index.m3u8"),vodPlaylist(duration),{mode:0o600});
        // Encode only the first segment at creation; the receiver triggers others.
        await makeVodSegment(s,0,{ffmpegPath,spawnImpl});
        s.state="ready";
        return {id:sid,url:origin+"/cast/media/"+sid+"/"+token+"/index.m3u8",
          expiresAt:new Date(s.exp).toISOString(),maxExpiresAt:new Date(s.maxAt).toISOString(),
          status:"ready",seekable:true,mode:"vod",idleMinutes:Math.floor(idleMs/60000)};
      }
      s.ff=spawnImpl(ffmpegPath,buildCastArgs({...src,dir,startAt}),{stdio:["ignore","ignore","pipe"]});
      s.ff.stderr?.resume();
      s.ff.once("error",()=>{s.state="error";});
      s.ff.once("exit",(code)=>{if(sessions.get(sid)===s)s.state=code===0?"ended":"error";});
      const deadline=Date.now()+readyTimeoutMs;
      while(Date.now()<deadline) {
        if(s.state==="error") throw Error("Encoder failed");
        try {
          const m=await fs.readFile(path.join(dir,"index.m3u8"),"utf8");
          const parts=m.match(/segment_\d{5}\.ts/g);
          if(parts?.length && (await fs.stat(path.join(dir,parts.at(-1)))).size>0) {
            s.state="ready";
            return {id:sid,url:origin+"/cast/media/"+sid+"/"+token+"/index.m3u8",
              expiresAt:new Date(s.exp).toISOString(),maxExpiresAt:new Date(s.maxAt).toISOString(),
              status:"ready",seekable:false,mode:"rolling",idleMinutes:Math.floor(idleMs/60000)};
          }
        } catch {}
        await delay(150);
      }
      throw Error("HLS startup timed out");
    } catch {
      await stop(sid);
      throw Object.assign(Error("HLS encoder failed to prepare the stream"),{status:502});
    }
    } finally {creating--;}
  }
  function owned(id,owner) { const s=sessions.get(id); return s?.owner===owner ? s : null; }
  function status(id,owner) {
    const s=owned(id,owner);
    return s ? {id:s.id,status:s.state,expiresAt:new Date(s.exp).toISOString(),
      maxExpiresAt:new Date(s.maxAt).toISOString(),seekable:s.duration!=null,
      mode:s.duration!=null?"vod":"rolling"} : null;
  }
  async function media(req,res) {
    headers(res);
    if(!available) return res.status(404).end();
    const minute=Math.floor(now()/60000),ip=req.socket.remoteAddress || "unknown", r=rates.get(ip);
    const count=r?.minute===minute?r.count+1:1;
    rates.set(ip,{minute,count});
    if(rates.size>512) rates.clear();
    if(count>240) return res.status(429).end();
    const {id,token,file}=req.params;
    if(!/^[\w-]{16}$/.test(id || "") || !/^[\w-]{43}$/.test(token || "")
       || !/^(index\.m3u8|segment_\d{5}\.ts)$/.test(file || "")) return res.status(404).end();
    const s=sessions.get(id);
    if(!s) return res.status(410).end();
    if(now()>=s.exp || now()>=s.maxAt || now()-s.last>idleMs) {await stop(id);return res.status(410).end();}
    if(!crypto.timingSafeEqual(digest(token),s.tokenHash)) return res.status(403).end();
    // Count valid requests as activity before slow on-demand encoding begins.
    s.last=now();
    s.exp=Math.min(s.maxAt,now()+ttlMs);
    let releaseTransfer=()=>{};
    try {
      let filePath=path.join(s.dir,file);
      if(s.duration!=null && file!=="index.m3u8"){
        if(s.activeTransfers>=8)return res.status(429).end();
        const index=Number(file.slice(8,-3));
        if(index>=Math.ceil(s.duration/6)) return res.status(404).end();
        // Pin a segment *before* waiting for its encoder job. Otherwise another
        // request may evict the file between encoding, stat and HTTP sendFile.
        s.activeTransfers++;
        s.pins.set(index,(s.pins.get(index)||0)+1);
        let released=false;
        releaseTransfer=()=>{
          if(released)return;
          released=true;s.activeTransfers=Math.max(0,s.activeTransfers-1);
          const remaining=(s.pins.get(index)||1)-1;
          if(remaining)s.pins.set(index,remaining);else s.pins.delete(index);
        };
        res.once("finish",releaseTransfer);
        res.once("close",releaseTransfer);
        filePath=await makeVodSegment(s,index,{ffmpegPath,spawnImpl});
      }
      // Revocation/sweeper may run while the async encoder is active.
      if(s.stopping || sessions.get(id)!==s || now()>=s.maxAt)
        return res.status(410).end();
      const stat=await fs.stat(filePath);
      if(!stat.isFile() || !stat.size) return res.status(404).end();
      // Receiver-initiated sliding lease: no Access cookie or API call on the TV.
      // Even uninterrupted playback ends at the immutable hard ceiling.
      res.type(file.endsWith(".m3u8")?"application/vnd.apple.mpegurl":"video/mp2t");
      return res.sendFile(filePath);
    } catch(error) {
      releaseTransfer();
      if(res.headersSent || res.writableEnded) return;
      return res.status(error?.status===429?429:error?.status===410?410:s.state==="error"?502:503).end();
    }
  }
  async function cleanupStaleScratch({minAgeMs=maxMs+2*60*60_000}={}){
    // Reclaim old session-shaped directories under the dedicated scratch root.
    if(!available || !Number.isFinite(minAgeMs) || minAgeMs<0)return 0;
    let entries=[];
    try{entries=await fs.readdir(root,{withFileTypes:true});}
    catch(error){if(error.code==="ENOENT")return 0;throw error;}
    let removed=0;
    for(const entry of entries){
      if(!entry.isDirectory() || !/^[A-Za-z0-9_-]{16}$/.test(entry.name)
          || sessions.has(entry.name))continue;
      const dir=path.join(root,entry.name);
      try{
        const stat=await fs.lstat(dir);
        if(!stat.isDirectory() || now()-stat.mtimeMs<minAgeMs)continue;
        await fs.rm(dir,{recursive:true,force:true});
        removed++;
      }catch(error){if(error.code!=="ENOENT")throw error;}
    }
    return removed;
  }
  async function close(){
    closed=true;
    clearInterval(timer);
    for(const id of [...sessions.keys()])await stop(id);
  }
  return {available,create,media,stop,owned,status,sweep,close,headers,cleanupStaleScratch};
}
