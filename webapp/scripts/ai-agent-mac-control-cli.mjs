#!/usr/bin/env node
// Mac Control shell invocations use this CLI as the ONLY local bridge entry.
// No HTTP listeners, Cloudflare credentials, arbitrary OS commands or URLs.
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";

const permitted=new Set(["list_devices","resume_paired_preview","request_browser_approval",
  "claim_browser_approval","revoke_browser_approval","get_player_state",
  "search_media","play_media","pause","resume","stop"]);
const help="Usage: node scripts/ai-agent-mac-control-cli.mjs --socket /private/path/bridge.sock --action list_devices --args '{}'\n";
const params={};
for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i],value=process.argv[i+1];
  if(!["--socket","--action","--args"].includes(key)||!value||params[key]!==undefined){
    process.stderr.write(help);process.exit(2);
  }
  params[key]=value;
}
if(!params["--action"]||!params["--socket"]||!permitted.has(params["--action"])){
  process.stderr.write(help);process.exit(2);
}
let args;
try{args=JSON.parse(params["--args"]||"{}");}
catch{process.stderr.write('Invalid JSON argument\n');process.exit(2);}
const socketPath=params["--socket"];
if(!path.isAbsolute(socketPath)||socketPath.length>92||!socketPath.endsWith(".sock")){
  process.stderr.write("Invalid private socket path\n");process.exit(2);
}
let handle;
try{
  const st=await fs.lstat(socketPath),dir=await fs.lstat(path.dirname(socketPath));
  if(!st.isSocket()||(st.mode&0o077)!==0||
     !dir.isDirectory()||(dir.mode&0o077)!==0||
     typeof process.getuid==="function"&&(st.uid!==process.getuid()||dir.uid!==process.getuid()))
    throw Error("local_bridge_socket_not_private");
  const request={id:randomUUID(),action:params["--action"],args};
  const response=await new Promise((resolve,reject)=>{
    handle=net.createConnection(socketPath);
    handle.setTimeout(9500,()=>handle.destroy(Error("bridge_timeout")));
    let data="";
    handle.once("connect",()=>handle.write(JSON.stringify(request)+"\n"));
    handle.on("data",bytes=>{
      data+=bytes.toString("utf8");
      if(Buffer.byteLength(data)>16384){handle.destroy(Error("response_too_large"));return;}
      const stop=data.indexOf("\n");
      if(stop<0)return;
      try{resolve(JSON.parse(data.slice(0,stop)));handle.end();}
      catch{handle.destroy(Error("invalid_bridge_response"));}
    });
    handle.once("error",reject);
    handle.once("end",()=>{if(!data.includes("\n"))reject(Error("bridge_disconnected"));});
  });
  if(response.id!==request.id||response.ok!==true){
    process.stdout.write(JSON.stringify({ok:false,error:response.error||"bridge_invalid_reply"})+"\n");
    process.exitCode=1;
  }else{
    const failed=new Set(["offline","unauthorized","failed","timeout_uncertain",
      "rate_limited","unsupported","not_found","busy","needs_user_gesture"]);
    const status=response.result?.status;
    process.stdout.write(JSON.stringify({ok:!failed.has(status),result:response.result})+"\n");
    if(failed.has(status))process.exitCode=1;
  }
}catch(ex){
  process.stdout.write(JSON.stringify({ok:false,error:String(ex?.message||"local_bridge_unavailable")})+"\n");
  process.exitCode=1;
}finally{handle?.destroy();}
