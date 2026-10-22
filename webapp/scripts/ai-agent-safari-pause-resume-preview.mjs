// Temporary, isolated, home-LAN-only iPhone Safari playback-resume preview.
// Does not start YT Streamer production, alter its web files, or bypass consent.
// IMPORTANT: test uses HTTP/WS on trusted Wi-Fi, not production HTTPS/Access.
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import {createReadStream} from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomBytes,randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {WebSocketServer} from "ws";
import {AgentSessionRegistry} from "../src/lib/ai-media-agent-session-registry.js";
import {BrowserApprovalRegistry} from "../src/lib/ai-media-agent-remote-authorization.js";
import {startMacControlLocalBridge} from "../src/lib/ai-media-agent-mac-control-bridge.js";

const HOST=process.env.YT_SAFARI_TEST_HOST;
const PORT=Number(process.env.YT_SAFARI_TEST_PORT||18431);
if(!/^192\.168\.50\.(?:[1-9]|[1-9]\d|1\d{2}|2[0-4]\d|25[0-4])$/.test(HOST||"")||
   !Number.isInteger(PORT)||PORT<1024||PORT>65535)
 throw Error("explicit_home_lan_interface_required");
const ORIGIN="http://"+HOST+":"+PORT;
const directory=path.dirname(fileURLToPath(import.meta.url));
const clipPath=path.join(await fs.mkdtemp(path.join(os.tmpdir(),"yt-safari-video-")),"clip.mp4");
const scriptPath=path.join(directory,"../public/ai-agent-safari-resume-preview.js");
const controlDir=process.env.YT_SAFARI_TEST_CONTROL_DIR||
  path.join(os.homedir(),".yt-safari-test");
const controlSocket=path.join(controlDir,"bridge.sock");
const proofPath=path.join(controlDir,"pairing.key");
// The service's LAN-only tab pairing proof must survive LaunchAgent restarts.
async function persistentPairingProof(){
 await fs.mkdir(controlDir,{recursive:true,mode:0o700});
 const dirStat=await fs.lstat(controlDir);
 if(!dirStat.isDirectory()||(dirStat.mode&0o077)!==0 ||
   (typeof process.getuid==="function"&&dirStat.uid!==process.getuid()))
  throw Error("unsafe_pairing_directory");
 const provided=process.env.YT_SAFARI_TEST_PAIR_SECRET;
 if(provided!==undefined){
  if(!/^[-_a-zA-Z0-9]{40,60}$/.test(provided))throw Error("invalid_test_pairing_proof");
  return provided;
 }
 try{
  const fd=await fs.open(proofPath,"wx",0o600);
  try{await fd.writeFile(randomBytes(32).toString("base64url")+"\n");}
  finally{await fd.close();}
 }catch(ex){if(ex?.code!=="EEXIST")throw ex;}
 const st=await fs.lstat(proofPath);
 if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
   (typeof process.getuid==="function"&&st.uid!==process.getuid())||st.size>100)
  throw Error("unsafe_pairing_proof_file");
 const proof=(await fs.readFile(proofPath,"utf8")).trim();
 if(!/^[-_a-zA-Z0-9]{40,60}$/.test(proof))throw Error("invalid_stored_pairing_proof");
 return proof;
}
const secret=await persistentPairingProof();
const sessions=new Map();
const approvals=new BrowserApprovalRegistry({maxTtlMs:300000});
const registry=new AgentSessionRegistry({
 ttlMs:90000,timeoutMs:6500,maxSessions:1,
 authorizePairing:({principal,pairingProof})=>principal==="owner"&&pairingProof===secret
});
// ChatGPT's user-authorized "resume" is a narrow, persistent test setting.
// If iOS has suspended Safari, deliver ONE resume on the next authenticated
// reconnect, only for the same pairing secret, within a short bounded window.
// No network-accessible controls, no URLs, arbitrary JS, or other actions.
let queuedResume=null;
const RESUME_QUEUE_MS=120000;
async function deliverResume(deviceId){
 return registry.dispatch({principal:"owner",deviceId,action:"resume",args:{}});
}
const relay={
 registry,approvals,
 async previewPause(){
  queuedResume=null;
  const target=registry.list("owner")[0];
  if(!target)return {status:"offline",reason:"safari_tab_disconnected_or_suspended"};
  return registry.dispatch({principal:"owner",deviceId:target.device_id,action:"pause",args:{}});
 },
 async previewResume(){
  const target=registry.list("owner")[0];
  if(target){
   queuedResume=null;
   const outcome=await deliverResume(target.device_id);
   if(outcome.status!=="offline")return outcome;
  }
  const expiresAt=Date.now()+RESUME_QUEUE_MS;
  queuedResume={expiresAt};
  return {status:"queued_until_reconnect",expires_at:expiresAt,
    reason:"safari_tab_disconnected_or_suspended"};
 },
 remoteHooks:{
  requestBrowserApproval({deviceId,connectionId,requestId,subject,actions}){
   return registry.connectionFor("owner",deviceId)===connectionId&&
     registry.notifyDevice("owner",deviceId,{kind:"remote_approval_request",
      device_id:deviceId,request_id:requestId,subject,actions});
  }
 }
};
const run=promisify(execFile);
// If the temporary preview was terminated abruptly (e.g. SIGKILL), Unix
// sockets can remain on disk. Remove only the exact same-owner dead inode;
// never disconnect or replace another live Mac Control bridge process.
async function clearOrphanSocket(){
 let st;
 try{st=await fs.lstat(controlSocket);}catch(ex){
  if(ex?.code==="ENOENT")return;
  throw ex;
 }
 if(!st.isSocket()||typeof process.getuid==="function"&&st.uid!==process.getuid()||
   (st.mode&0o077)!==0)throw Error("existing_untrusted_socket");
 const status=await new Promise(resolve=>{
  const probe=net.createConnection(controlSocket);
  probe.setTimeout(1500,()=>{probe.destroy();resolve("timeout");});
  probe.once("connect",()=>{probe.destroy();resolve("in_use");});
  probe.once("error",ex=>{probe.destroy();resolve(ex.code||"error");});
 });
 if(status!=="ECONNREFUSED")throw Error("existing_bridge_"+status);
 const newer=await fs.lstat(controlSocket).catch(()=>null);
 if(!newer?.isSocket()||newer.ino!==st.ino||newer.dev!==st.dev)
  throw Error("socket_changed_during_orphan_check");
 await fs.unlink(controlSocket);
}
let bridge,server,closed=false;
const wss=new WebSocketServer({noServer:true,maxPayload:2500});

const html=String.raw`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>Safari live video resume test</title>
<link rel="stylesheet" href="/style.css"></head><body>
<h2>Live iPhone Safari test</h2>
<p>1. Start the clip. 2. Pause it. 3. Ask ChatGPT to resume the SAME video.</p>
<video id="clip" controls playsinline webkit-playsinline preload="auto" src="/clip.mp4"></video>
<button id="localPlay">Play locally</button>
<button id="localPause">Pause locally</button>
<p id="clock">Waiting for video</p><p role="status" id="status">Pairing...</p>
<details><summary>Playback diagnostics</summary><pre id="frame"></pre></details>
<p class="small">Temporary unencrypted home-Wi-Fi demonstration with synthetic MP4 and audio. Keep Safari open in the foreground.</p>
<script src="/client.js"></script>
</body></html>`;
const css="body{font:17px -apple-system,system-ui;background:#101820;color:white;max-width:640px;margin:12px auto;padding:14px}"+
"video{width:100%;display:block;background:black;max-height:53vh}"+
"button{font:inherit;min-height:48px;padding:10px 16px;margin:10px 6px 6px 0;border-radius:9px}"+
"pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}"+
".small{font-size:12px;color:#adbccd}";

function reject(socket){
 if(!socket.destroyed){
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
 }
}
async function close(){
 if(closed)return;
 closed=true;
 for(const s of sessions.keys())s.terminate();
 if(bridge)await bridge.close().catch(()=>{});
 if(server?.listening)await new Promise(resolve=>server.close(()=>resolve()));
 await new Promise(resolve=>wss.close(()=>resolve()));
 await fs.rm(path.dirname(clipPath),{recursive:true,force:true});
}
async function route(req,res){
 if(req.headers.host!==HOST+":"+PORT){
  res.writeHead(403).end();return;
 }
 // Bound to home LAN interface, and do not permit public-IP clients.
 if(!/^(?:::ffff:)?192\.168\.50\.\d{1,3}$/.test(req.socket.remoteAddress||"")){
  res.writeHead(403).end();return;
 }
 res.setHeader("cache-control","no-store");
 res.setHeader("referrer-policy","no-referrer");
 res.setHeader("x-content-type-options","nosniff");
 res.setHeader("x-frame-options","DENY");
 res.setHeader("content-security-policy",
  "default-src 'none'; media-src 'self'; style-src 'self'; script-src 'self'; "+
  "connect-src 'self' ws://"+HOST+":"+PORT+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 if(!["GET","HEAD"].includes(req.method)){res.writeHead(405).end();return;}
 if(req.url==="/"){
  res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
  res.end(req.method==="HEAD"?"":html);
 }else if(req.url==="/style.css"){
  res.writeHead(200,{"content-type":"text/css; charset=utf-8"});
  res.end(req.method==="HEAD"?"":css);
 }else if(req.url==="/client.js"){
  res.writeHead(200,{"content-type":"text/javascript; charset=utf-8"});
  res.end(req.method==="HEAD"?"":await fs.readFile(scriptPath));
 }else if(req.url==="/clip.mp4"){
  const f=await fs.stat(clipPath);
  const range=req.headers.range;
  let start=0,end=f.size-1,status=200;
  if(range){
   const m=/^bytes=(\d+)-(\d*)$/.exec(range);
   if(!m||Number(m[1])>=f.size ||
      (m[2]!==""&&Number(m[2])<Number(m[1]))){
    res.writeHead(416,{"content-range":"bytes */"+f.size}).end();return;
   }
   start=Number(m[1]);end=m[2]?Math.min(f.size-1,Number(m[2])):f.size-1;
   status=206;
  }
  const headers={
   "content-type":"video/mp4","accept-ranges":"bytes","content-length":end-start+1
  };
  if(status===206)headers["content-range"]="bytes "+start+"-"+end+"/"+f.size;
  res.writeHead(status,headers);
  if(req.method==="HEAD"){res.end();return;}
  // Do not construct a FileHandle then abandon it while a streamed response
  // is still running. On Node 26 this can crash the entire preview process.
  const readable=createReadStream(clipPath,{start,end,autoClose:true});
  readable.on("error",()=>res.destroy());
  res.on("close",()=>readable.destroy());
  readable.pipe(res);
 }else res.writeHead(404).end();
}
try{
 await run("/opt/homebrew/bin/ffmpeg",[
  "-hide_banner","-loglevel","error","-y",
  "-f","lavfi","-i","testsrc2=size=480x270:rate=15",
  "-f","lavfi","-i","sine=frequency=440:sample_rate=44100",
  "-t","90","-c:v","libx264","-preset","ultrafast","-crf","31",
  "-pix_fmt","yuv420p","-c:a","aac","-b:a","48k",
  "-movflags","+faststart",clipPath
 ],{timeout:100000,maxBuffer:300000});
 await fs.mkdir(controlDir,{mode:0o700,recursive:true});
 const st=await fs.lstat(controlDir);
 if(!st.isDirectory()||(st.mode&0o077)!==0||
   (typeof process.getuid==="function"&&st.uid!==process.getuid()))
  throw Error("unsafe_socket_directory");
 await clearOrphanSocket();
 bridge=await startMacControlLocalBridge({relay,socketPath:controlSocket,approvalTtlMs:300000});
 server=http.createServer((req,res)=>{
  route(req,res).catch(()=>res.destroy());
 });
 server.on("upgrade",(req,socket,head)=>{
  if(req.url!=="/control"||req.headers.host!==HOST+":"+PORT||
     req.headers.origin!==ORIGIN||sessions.size>=2||
     !/^(?:::ffff:)?192\.168\.50\.\d{1,3}$/.test(socket.remoteAddress||"")){
   reject(socket);return;
  }
  wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws));
 });
 wss.on("connection",ws=>{
  const connectionId=randomUUID();
  let deviceId=null;
  sessions.set(ws,{deviceId:null,connectionId});
  const login=setTimeout(()=>ws.close(1008,"pairing_required"),3500);
  ws.on("message",buffer=>{
   let msg;
   try{msg=JSON.parse(buffer.toString("utf8"));}
   catch{ws.close(1008,"invalid_json");return;}
   if(!deviceId){
    if(msg?.kind!=="pair"||typeof msg.proof!=="string"){
     ws.close(1008,"pairing_required");return;
    }
    try{
     if(msg.proof!==secret)throw Error("bad_pairing_proof");
     // Safari can reconnect before its suspended transport is fully closed.
     // A second connection with the SAME proof replaces the stale one.
     // Revoke its previous grant and require fresh tab consent each time.
     for(const [peer,old] of sessions){
      if(peer===ws)continue;
      if(old.deviceId){
       approvals.revokeConnection(old.deviceId,old.connectionId);
       registry.disconnect({deviceId:old.deviceId,connectionId:old.connectionId});
      }
      peer.close(1001,"paired_tab_reconnected");
     }
     const reg=registry.register({principal:"owner",pairingProof:msg.proof,
      connectionId,label:"iPhone Safari real-time test",
      send(frame){
       if(ws.readyState!==ws.OPEN)return false;
       ws.send(JSON.stringify(frame));return true;
      }});
     deviceId=reg.device_id;
     sessions.set(ws,{deviceId,connectionId});
     clearTimeout(login);
     ws.send(JSON.stringify({kind:"registered",...reg}));
     // The new browser connection is paired with the same strong secret,
     // so a short-lived queued ChatGPT resume may now be delivered.
     const job=queuedResume;
     if(job){
      queuedResume=null;
      if(Date.now()<job.expiresAt){
       setImmediate(()=>{void deliverResume(deviceId).catch(()=>{});});
      }
     }
    }catch{ws.close(1008,"pairing_denied");}
    return;
   }
   if(msg?.kind==="heartbeat"){
    if(!registry.heartbeat({principal:"owner",deviceId,connectionId,state:msg.state}))
      ws.close(1012,"stale");
   }else if(msg?.kind==="approve_remote_request"){
    const valid=typeof msg.request_id==="string"&&
      approvals.approvePendingFromBrowser({
       requestId:msg.request_id,deviceId,connectionId
      });
    ws.send(JSON.stringify({kind:valid?"remote_approval_recorded":"remote_approval_rejected"}));
   }else if(msg?.kind==="ack"){
    registry.acknowledge({principal:"owner",deviceId,connectionId,
      commandId:msg.command_id,status:msg.status,state:msg.state,error:msg.error});
   }else ws.close(1008,"invalid_frame");
  });
  ws.on("close",()=>{
   clearTimeout(login);sessions.delete(ws);
   approvals.revokeConnection(deviceId,connectionId);
   if(deviceId)registry.disconnect({deviceId,connectionId});
  });
  ws.on("error",()=>{});
 });
 await new Promise((resolve,reject)=>{
  server.once("error",reject);
  server.listen(PORT,HOST,resolve);
 });
 console.log(JSON.stringify({
  status:"ready",url:ORIGIN+"/#pair="+secret,
  controller_socket:controlSocket,
  lifetime:"persistent LaunchAgent; explicit stop required",
  mode:"paired LAN-only test clip, user-authorized single-call Resume, no Safari approval dialog",
  started_at:new Date().toISOString(),pid:process.pid
 }));
 // Production remains untouched. The user requested this isolated test service
 // to stay available; the per-connection pairing is still strongly scoped.
 if(process.env.YT_SAFARI_TEST_LIFETIME_MS){
  const lifetime=Number(process.env.YT_SAFARI_TEST_LIFETIME_MS);
  if(Number.isSafeInteger(lifetime)&&lifetime>=1000&&lifetime<=86400000)
   setTimeout(()=>{void close().then(()=>process.exit(0));},lifetime).unref();
 }
 for(const signal of ["SIGINT","SIGTERM"]){
  process.on(signal,()=>close().then(()=>process.exit(0)));
 }
}catch(ex){
 await close().catch(()=>{});
 throw ex;
}
