import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import {randomBytes,randomUUID} from "node:crypto";
import {promisify} from "node:util";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import WebSocket from "ws";
import {startLocalAgentRelay} from "../scripts/ai-agent-local-relay.mjs";
import {startMacControlLocalBridge} from "../src/lib/ai-media-agent-mac-control-bridge.js";

const exec=promisify(execFile),secret=()=>randomBytes(32).toString("hex");
const cli=fileURLToPath(new URL("../scripts/ai-agent-mac-control-cli.mjs",import.meta.url));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function control(socket,action,args={}){
  try{
    const out=await exec(process.execPath,[cli,"--socket",socket,"--action",action,
      "--args",JSON.stringify(args)],{timeout:12000});
    return JSON.parse(out.stdout);
  }catch(ex){
    if(ex.stdout)return JSON.parse(ex.stdout);
    if(ex.code===2 && /Usage:/.test(ex.stderr||""))return {ok:false,error:"invalid_cli_action"};
    throw ex;
  }
}
async function pair(relay,proof){
  const ws=new WebSocket(relay.origin.replace("http","ws")+"/dev/player",{origin:relay.origin});
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  const registered=new Promise(resolve=>ws.once("message",raw=>resolve(JSON.parse(String(raw)))));
  ws.send(JSON.stringify({kind:"pair",proof,label:"Browser with local manual authorization"}));
  return {ws,device:await registered};
}
function next(ws,kind){
  return new Promise(resolve=>{
    const read=raw=>{const frame=JSON.parse(String(raw));if(frame.kind===kind){
      ws.off("message",read);resolve(frame);
    }};ws.on("message",read);
  });
}
async function setup(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"yt-macbridge-"));
  const socket=path.join(dir,"control.sock");
  const proof=secret(),relay=await startLocalAgentRelay({ownerToken:secret(),pairingToken:proof});
  const bridge=await startMacControlLocalBridge({relay,socketPath:socket});
  return {dir,socket,relay,bridge,proof,
    async close(){await bridge.close();await relay.close();await fs.rm(dir,{recursive:true,force:true});}};
}
test("Mac Control CLI uses private Unix socket and does not bypass exact browser approval",async()=>{
  const x=await setup();
  let ws;
  try{
    const st=await fs.lstat(x.socket);
    assert.ok(st.isSocket());assert.equal(st.mode&0o077,0);
    assert.deepEqual(await control(x.socket,"list_devices"),{ok:true,result:{devices:[]}});
    const paired=await pair(x.relay,x.proof);ws=paired.ws;
    const target=paired.device.device_id;
    const list=await control(x.socket,"list_devices");
    assert.equal(list.result.devices.length,1);
    assert.equal(list.result.devices[0].device_id,target);
    const unapproved=await control(x.socket,"pause",{
      device_id:target,approval_id:randomUUID()
    });
    assert.equal(unapproved.ok,false);
    assert.equal(unapproved.result.status,"unauthorized");
    // Unknown actions never reach the paired browser.
    assert.equal((await control(x.socket,"shell",{device_id:target})).ok,false);
    assert.equal((await control(x.socket,"play_media",{
      device_id:target,approval_id:randomUUID(),url:"https://example.com"
    })).ok,false);
    const approvalNotice=next(ws,"remote_approval_request");
    const requested=await control(x.socket,"request_browser_approval",{
      device_id:target,actions:["search_media","get_player_state","play_media","pause","resume","stop"]
    });
    assert.equal(requested.result.status,"pending_browser_approval");
    const prompt=await approvalNotice;
    assert.equal(prompt.subject,"Mac Control (local)");
    assert.equal(prompt.request_id,requested.result.request_id);
    assert.equal((await control(x.socket,"claim_browser_approval",{
      request_id:prompt.request_id
    })).result.status,"pending_browser_approval");
    const recorded=next(ws,"remote_approval_recorded");
    ws.send(JSON.stringify({kind:"approve_remote_request",request_id:prompt.request_id}));
    await recorded;
    const claim=await control(x.socket,"claim_browser_approval",{request_id:prompt.request_id});
    assert.equal(claim.result.status,"approved");
    const scope={device_id:target,approval_id:claim.result.approval_id};
    const command=next(ws,"command");
    const searched=control(x.socket,"search_media",{...scope,query:"test media",limit:1});
    const received=await command;
    assert.equal(received.action,"search_media");
    ws.send(JSON.stringify({kind:"ack",command_id:received.command_id,
      status:"completed",result:{results:[{media_id:"jNQXAC9IVRw",title:"Test",creator:"Fixture"}]},
      state:{playback_phase:"idle"}}));
    assert.equal((await searched).result.result.results[0].media_id,"jNQXAC9IVRw");
    const other=await control(x.socket,"pause",{device_id:randomUUID(),
      approval_id:scope.approval_id});
    assert.equal(other.result.status,"unauthorized");
    assert.deepEqual((await control(x.socket,"revoke_browser_approval",{
      approval_id:scope.approval_id
    })).result,{revoked:true});
    assert.equal((await control(x.socket,"pause",scope)).result.status,"unauthorized");
    ws.terminate();
    await new Promise(resolve=>ws.once("close",resolve));
    assert.equal((await control(x.socket,"list_devices")).result.devices.length,0);
  }finally{
    ws?.terminate();await x.close();
  }
});
test("Mac bridge refuses public/shared paths, arbitrary remote commands and rebind to same socket",async()=>{
  const x=await setup();
  try{
    await assert.rejects(startMacControlLocalBridge({
      relay:x.relay,socketPath:x.socket
    }),/socket_path_already_exists/);
    const publicDir=await fs.mkdtemp(path.join(os.tmpdir(),"yt-macpublic-"));
    try{
      await fs.chmod(publicDir,0o755);
      await assert.rejects(startMacControlLocalBridge({
        relay:x.relay,socketPath:path.join(publicDir,"bridge.sock")
      }),/private_socket_directory_required/);
    }finally{await fs.rm(publicDir,{recursive:true,force:true});}
    assert.equal((await control(x.socket,"request_browser_approval",{
      device_id:randomUUID(),actions:["open_url"]
    })).ok,false);
    assert.equal((await control(x.socket,"list_devices",{command:"rm -rf"})).ok,false);
    assert.equal((await control(x.socket,"play_media",{
      device_id:randomUUID(),approval_id:randomUUID(),media_id:"https://unsafe"
    })).ok,false);
    // Every request ID is idempotent at the bridge regardless of action.
    const request={id:randomUUID(),action:"list_devices",args:{}};
    async function raw(){
      return new Promise((resolve,reject)=>{
        const socket=net.createConnection(x.socket),chunks=[];
        socket.once("connect",()=>socket.write(JSON.stringify(request)+"\n"));
        socket.on("data",chunk=>chunks.push(chunk));
        socket.once("end",()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));
        socket.once("error",reject);
      });
    }
    assert.equal((await raw()).ok,true);
    assert.equal((await raw()).error,"duplicate_request");
  }finally{await x.close();}
});
