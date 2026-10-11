import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  idleMs=15*60_000, readyTimeoutMs=15000}) {
  const sessions = new Map();
  const rates = new Map();
  let origin="";
  try {
    const u = new URL(publicOrigin);
    if (u.protocol==="https:" && !u.username && !u.password && u.pathname==="/" && !u.search && !u.hash) origin=u.origin;
  } catch {}
  const available = !!(enabled && origin && root && resolveSource);
  function headers(res) {
    res.set({"Cache-Control":"private, no-store, max-age=0","Referrer-Policy":"no-referrer",
      "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex, nofollow, nosnippet"});
  }
  async function stop(id) {
    const s=sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
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
      if(now()>=s.exp || now()-s.last>idleMs) await stop(s.id);
    }
  }
  const timer=setInterval(()=>{void sweep().catch(()=>{});},30000);
  timer.unref?.();
  async function create(body, owner) {
    if(!available) throw Object.assign(Error("Cast unavailable until access is configured"),{status:503});
    await sweep();
    if(sessions.size>=2) throw Object.assign(Error("Two cast sessions already active"),{status:429});
    const {kind,id,url} = body || {};
    const startAt=Number(body?.startAt || 0);
    if(!Number.isFinite(startAt) || startAt<0 || startAt>43200 ||
      !(((kind==="item" || kind==="legacy") && /^[\w-]{1,120}$/.test(id || "") && !url)
        || (kind==="youtube" && castYoutubeUrl(url) && !id))) {
      throw Object.assign(Error("Unsupported cast source"),{status:400});
    }
    const src=await resolveSource({kind,id,url});
    if(!src?.video) throw Object.assign(Error("Video unavailable"),{status:422});
    const sid=crypto.randomBytes(12).toString("base64url");
    const token=crypto.randomBytes(32).toString("base64url");
    const dir=path.join(root,sid);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const s={id:sid,owner,tokenHash:digest(token),dir,ff:null,exp:now()+ttlMs,last:now(),state:"starting"};
    sessions.set(sid,s);
    try {
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
              expiresAt:new Date(s.exp).toISOString(),status:"ready"};
          }
        } catch {}
        await delay(150);
      }
      throw Error("HLS startup timed out");
    } catch {
      await stop(sid);
      throw Object.assign(Error("HLS encoder failed to prepare the stream"),{status:502});
    }
  }
  function owned(id,owner) { const s=sessions.get(id); return s?.owner===owner ? s : null; }
  function status(id,owner) {
    const s=owned(id,owner);
    return s ? {id:s.id,status:s.state,expiresAt:new Date(s.exp).toISOString()} : null;
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
    if(now()>=s.exp || now()-s.last>idleMs) {await stop(id);return res.status(410).end();}
    if(!crypto.timingSafeEqual(digest(token),s.tokenHash)) return res.status(403).end();
    s.last=now();
    try {
      const filePath=path.join(s.dir,file),stat=await fs.stat(filePath);
      if(!stat.isFile() || !stat.size) return res.status(404).end();
      res.type(file.endsWith(".m3u8")?"application/vnd.apple.mpegurl":"video/mp2t");
      return res.sendFile(filePath);
    } catch {return res.status(s.state==="error"?502:404).end();}
  }
  async function close(){clearInterval(timer);for(const id of [...sessions.keys()])await stop(id);}
  return {available,create,media,stop,owned,status,sweep,close,headers};
}
