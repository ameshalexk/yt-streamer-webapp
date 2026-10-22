// Local Mac Control bridge. It is never imported by the production web server.
// Requires a Unix socket in a private owner-only directory. Never bind TCP.
// The relay must already contain a browser signed into the trusted Access WS.
// This socket is reachable by other local processes of the SAME OS USER;
// its authority is nevertheless limited by explicit browser-side approval.
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import {validateMediaCommand} from "./ai-media-agent-session-registry.js";

const COMMANDS=new Set(["get_player_state","search_media","play_media","pause","resume","stop"]);
const OPERATIONS=new Set([...COMMANDS,"list_devices","resume_paired_preview",
  "request_browser_approval","claim_browser_approval","revoke_browser_approval"]);
const IDENTITY=Object.freeze({
  issuer:"urn:yt-streamer:mac-control:local-unix-socket",
  subject:"Mac Control (local)"
});
const uuid=x=>typeof x==="string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const isObj=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const keys=(obj,allowed)=>Object.keys(obj).every(k=>allowed.includes(k));
const error=status=>Object.assign(Error(status),{code:status});

function valid(action,args){
  if(!OPERATIONS.has(action)||!isObj(args))return false;
  if(action==="list_devices"||action==="resume_paired_preview")return keys(args,[]);
  if(action==="request_browser_approval")return keys(args,["device_id","actions"])
    &&uuid(args.device_id)&&Array.isArray(args.actions)
    &&args.actions.length>=1&&args.actions.length<=COMMANDS.size
    &&new Set(args.actions).size===args.actions.length
    &&args.actions.every(a=>COMMANDS.has(a));
  if(action==="claim_browser_approval")return keys(args,["request_id"])&&uuid(args.request_id);
  if(action==="revoke_browser_approval")return keys(args,["approval_id"])&&uuid(args.approval_id);
  if(!uuid(args.device_id)||!uuid(args.approval_id))return false;
  const {device_id,approval_id,...mediaArgs}=args;
  try{
    validateMediaCommand(action,mediaArgs);
    // Restrict to the exact browser adapter's implemented argument set.
    if(action==="search_media")return keys(mediaArgs,["query","limit"]);
    if(action==="play_media")return keys(mediaArgs,["media_id"])
      && /^[A-Za-z0-9_-]{11}$/.test(mediaArgs.media_id||"");
    return Object.keys(mediaArgs).length===0;
  }catch{return false;}
}
function strictSocketPath(socketPath){
  if(typeof socketPath!=="string"||!path.isAbsolute(socketPath)
     ||socketPath.length>92 ||path.basename(socketPath).startsWith(".")
     ||!socketPath.endsWith(".sock"))throw error("invalid_socket_path");
  return socketPath;
}

export async function startMacControlLocalBridge({relay,socketPath,
  maxRequestsPerMinute=60,approvalTtlMs=120000,now=Date.now}={}){
  const filename=strictSocketPath(socketPath);
  if(!relay?.registry||!relay?.approvals||
    typeof relay?.remoteHooks?.requestBrowserApproval!=="function"||
    !Number.isInteger(maxRequestsPerMinute)||maxRequestsPerMinute<1||maxRequestsPerMinute>180||
    !Number.isInteger(approvalTtlMs)||approvalTtlMs<1000||approvalTtlMs>300000||
    typeof now!=="function")throw error("invalid_mac_bridge_config");
  const parent=path.dirname(filename);
  // Require the caller to create the private directory explicitly; do not
  // create a guessable socket under /tmp or use a pre-existing socket.
  const dir=await fs.lstat(parent);
  if(!dir.isDirectory() ||dir.isSymbolicLink() ||(dir.mode & 0o077)!==0 ||
     typeof process.getuid==="function" &&dir.uid!==process.getuid())
    throw error("private_socket_directory_required");
  // macOS has a system-owned /var -> /private/var ancestor alias.
  // Accept it, but still require an actual (not symlink) owner-only
  // immediate parent, normalised absolute socket name, and owner checks.
  if(path.resolve(filename)!==filename)
    throw error("invalid_socket_path");
  try{await fs.lstat(filename);throw error("socket_path_already_exists");}
  catch(ex){if(ex?.code!=="ENOENT")throw ex;}
  const active=new Set(),seen=new Map();
  let hits=[],server,ownedInode=null;
  function prune(){
    const cutoff=now()-60000;
    hits=hits.filter(t=>t>=cutoff);
    for(const [id,time] of seen)if(time<cutoff)seen.delete(id);
  }
  async function dispatch(action,args){
    if(action==="list_devices")return {devices:relay.registry.list("owner")};
    // Explicit opt-in, preview-only capability. The user already authorized
    // this narrow action in ChatGPT; the browser still proves pairing through
    // its strong local secret. This never enables general playback commands.
    if(action==="resume_paired_preview")return typeof relay.previewResume==="function"
      ? relay.previewResume():{status:"unsupported"};
    if(action==="request_browser_approval"){
      const connectionId=relay.registry.connectionFor("owner",args.device_id);
      if(!connectionId)return {status:"offline"};
      const requested=relay.approvals.request({
        identity:IDENTITY,deviceId:args.device_id,connectionId,
        actions:args.actions,ttlMs:approvalTtlMs
      });
      if(!relay.remoteHooks.requestBrowserApproval({
        deviceId:args.device_id,connectionId,requestId:requested.request_id,
        subject:IDENTITY.subject,actions:args.actions
      })){
        relay.approvals.revokePendingConnection(args.device_id,connectionId);
        return {status:"offline"};
      }
      return requested;
    }
    if(action==="claim_browser_approval")
      return relay.approvals.claim({identity:IDENTITY,requestId:args.request_id})
        ||{status:"not_found"};
    if(action==="revoke_browser_approval")
      return {revoked:relay.approvals.revokeOwned(IDENTITY,args.approval_id)};
    const {device_id,approval_id,...commandArgs}=args;
    const connectionId=relay.registry.connectionFor("owner",device_id);
    if(!connectionId ||!relay.approvals.authorize({
      identity:IDENTITY,approvalId:approval_id,deviceId:device_id,
      connectionId,action
    }))return {status:"unauthorized"};
    return relay.registry.dispatch({
      principal:"owner",deviceId:device_id,action,args:commandArgs
    });
  }
  function handle(socket){
    active.add(socket);socket.setTimeout(9000,()=>socket.destroy());
    socket.on("close",()=>active.delete(socket));
    let buffer="",processed=false;
    socket.on("data",async bytes=>{
      if(processed)return;
      buffer+=bytes.toString("utf8");
      if(Buffer.byteLength(buffer)>8192){processed=true;socket.end(
        JSON.stringify({ok:false,error:"payload_too_large"})+"\n");return;}
      const pos=buffer.indexOf("\n");
      if(pos===-1)return;
      processed=true;
      let id=null;
      try{
        if(buffer.slice(pos+1).trim())throw error("multiple_requests_not_allowed");
        const request=JSON.parse(buffer.slice(0,pos));
        if(!isObj(request)||!uuid(request.id)||!valid(request.action,request.args))
          throw error("invalid_request");
        id=request.id;
        prune();
        if(seen.has(id))throw error("duplicate_request");
        if(hits.length>=maxRequestsPerMinute)throw error("rate_limited");
        if(seen.size>=1024)throw error("idempotency_capacity");
        seen.set(id,now());hits.push(now());
        const result=await dispatch(request.action,request.args);
        socket.end(JSON.stringify({id,ok:true,result})+"\n");
      }catch(ex){socket.end(JSON.stringify({
        id,ok:false,error:typeof ex?.code==="string"?ex.code:"request_failed"
      })+"\n");}
    });
    socket.on("error",()=>{});
  }
  server=net.createServer(handle);
  try{
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(filename,resolve);
    });
    await fs.chmod(filename,0o600);
    const stat=await fs.lstat(filename);
    if(!stat.isSocket() ||(stat.mode&0o077)!==0)throw error("unsafe_socket_permissions");
    ownedInode={ino:stat.ino,dev:stat.dev};
  }catch(ex){
    for(const peer of active)peer.destroy();
    await new Promise(resolve=>server.close(resolve)).catch(()=>{});
    throw ex;
  }
  return {
    socketPath:filename,
    async close(){
      for(const peer of active)peer.destroy();
      await new Promise(resolve=>server.close(resolve));
      // Node normally unlinks the Unix socket on server.close(). Do not
      // unlink a pathname that another process has subsequently replaced.
      const st=await fs.lstat(filename).catch(()=>null);
      if(st?.isSocket() &&st.ino===ownedInode?.ino &&st.dev===ownedInode?.dev)
        await fs.unlink(filename);
    }
  };
}
