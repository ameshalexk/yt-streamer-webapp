import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign,randomUUID} from "node:crypto";
import {WebSocket} from "ws";
import {TrustedBrowserRegistrationFlow} from "../src/lib/ai-media-agent-trusted-browser-flow.js";
import {startTrustedAccessBrowserRelay} from "../scripts/ai-agent-trusted-access-relay.mjs";
import {startLocalRemoteMcpGateway} from "../scripts/ai-agent-remote-mcp.mjs";

const issuer="https://trusted-test.cloudflareaccess.com";
const audience="separate-streamer-test-app";
const origin="http://127.0.0.1:18765";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});
const provider={issuer,get:async()=>({keys:[{...jwk,kid:"trusted-key",use:"sig",alg:"RS256"}]})};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let wall=Math.floor(Date.now()/1000);
function jwt({sub="owner",aud=audience,exp=wall+300,iss=issuer}={}){
  const encode=data=>Buffer.from(JSON.stringify(data)).toString("base64url");
  const h=encode({alg:"RS256",kid:"trusted-key"});
  const b=encode({sub,aud,exp,iat:wall-10,iss});
  const value=h+"."+b;
  return value+"."+sign("RSA-SHA256",Buffer.from(value),privateKey).toString("base64url");
}
const flow=(now=Date.now)=>new TrustedBrowserRegistrationFlow({
  jwksProvider:provider,audience,allowedSubjects:["owner"],allowedOrigins:[origin],now
});
function open(relay,token,{wsOrigin=origin,extra={}}={}){
  const ws=new WebSocket(relay.origin.replace("http","ws")+"/trusted/player",{
    origin:wsOrigin,headers:{"Cf-Access-Jwt-Assertion":token,...extra}
  });
  return ws;
}
async function unauthorized(ws){
  return new Promise((resolve,reject)=>{
    ws.once("unexpected-response",(_request,res)=>resolve(res.statusCode));
    ws.once("error",reject);
  });
}
function nextFrame(ws,kind){
  return new Promise((resolve,reject)=>{
    function receive(raw){
      let data;try{data=JSON.parse(String(raw));}catch{return;}
      if(data.kind===kind){ws.off("message",receive);ws.off("error",reject);resolve(data);}
    }
    ws.on("message",receive);ws.once("error",reject);
  });
}
async function mcp(gateway,name,args,token=jwt()){
  const reply=await fetch(gateway.origin+"/remote/mcp",{
    method:"POST",headers:{"content-type":"application/json",
      accept:"application/json, text/event-stream",
      "Cf-Access-Jwt-Assertion":token,"x-ai-request-id":randomUUID()},
    body:JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:"tools/call",
      params:{name,arguments:args}})
  });
  assert.equal(reply.status,200);
  const data=await reply.json();
  return data.result?.structuredContent;
}
test("signed Access WS browser session -> existing scoped MCP approval -> selected-tab ACK, revoke on disconnect",
  {timeout:16000},async()=>{
    const trusted=flow();
    const relay=await startTrustedAccessBrowserRelay({trustedBrowserFlow:trusted});
    const gateway=await startLocalRemoteMcpGateway({
      relay,jwksProvider:provider,audience,allowedSubjects:["owner"]});
    let ws;
    try{
      ws=open(relay,jwt());
      const registration=await nextFrame(ws,"registered");
      assert.match(registration.device_id,/^[0-9a-f-]{36}$/);
      const devices=await mcp(gateway,"list_devices",{});
      assert.equal(devices.devices.length,1);
      assert.equal(devices.devices[0].device_id,registration.device_id);
      assert.equal(devices.devices[0].label,"Access browser");
      // Browser identity was authenticated from signed upgrade, never from a
      // browser-submitted label, principal or device ID.
      ws.send(JSON.stringify({kind:"heartbeat",principal:"impostor",
        device_id:randomUUID(),state:{title:"Signed browser",paused:true}}));
      await wait(30);
      const state=await mcp(gateway,"list_devices",{});
      assert.equal(state.devices[0].state.title,"Signed browser");
      const pending=nextFrame(ws,"remote_approval_request");
      const request=await mcp(gateway,"request_browser_approval",{
        device_id:registration.device_id,actions:["get_player_state","pause"]});
      assert.equal(request.status,"pending_browser_approval");
      const prompt=await pending;
      assert.equal(prompt.request_id,request.request_id);
      assert.equal((await mcp(gateway,"claim_browser_approval",
        {request_id:request.request_id})).status,"pending_browser_approval");
      // This test simulates the browser's approval message, not physical user
      // activation, real Access login or Tesla acceptance.
      const recorded=nextFrame(ws,"remote_approval_recorded");
      ws.send(JSON.stringify({kind:"approve_remote_request",request_id:request.request_id}));
      await recorded;
      const grant=await mcp(gateway,"claim_browser_approval",{request_id:request.request_id});
      assert.equal(grant.status,"approved");
      assert.equal((await mcp(gateway,"next",{
        device_id:registration.device_id,approval_id:grant.approval_id})).status,"unauthorized");
      const cmd=nextFrame(ws,"command");
      const response=mcp(gateway,"pause",{
        device_id:registration.device_id,approval_id:grant.approval_id});
      const received=await cmd;
      assert.equal(received.action,"pause");
      assert.equal(received.device_id,registration.device_id);
      ws.send(JSON.stringify({kind:"ack",command_id:received.command_id,
        status:"completed",state:{paused:true,mode:"mjpeg"}}));
      assert.equal((await response).status,"completed");
      ws.close();
      await new Promise(resolve=>ws.once("close",resolve));
      await wait(25);
      assert.equal((await mcp(gateway,"list_devices",{})).devices.length,0);
      assert.equal((await mcp(gateway,"pause",{
        device_id:registration.device_id,approval_id:grant.approval_id})).status,"unauthorized");
    }finally{
      ws?.terminate();
      await gateway.close();
      await relay.close();
    }
});
test("forged, wrong-origin and wrong-subject Access browser upgrades never register",{
  timeout:10000},async()=>{
    const relay=await startTrustedAccessBrowserRelay({trustedBrowserFlow:flow()});
    try{
      for(const [token,extra] of [
        ["not-a-jwt",{}],
        [jwt({sub:"intruder"}),{}],
        [jwt({aud:"wrong-audience"}),{}],
        [jwt(),{wsOrigin:"http://127.0.0.1:6666"}]
      ]){
        assert.equal(await unauthorized(open(relay,token,extra)),401);
        assert.equal(relay.registry.list("owner").length,0);
      }
      // A current signed edge assertion takes precedence when the browser's
      // valid but older cookie represents another Access session.
      const edgeToken=jwt();
      const refreshed=open(relay,edgeToken,{extra:{
        Cookie:"CF_Authorization="+jwt({sub:"intruder"})
      }});
      const accepted=await nextFrame(refreshed,"registered");
      assert.ok(accepted.device_id);
      refreshed.close();
      await new Promise(resolve=>refreshed.once("close",resolve));
      for(let i=0;i<30&&relay.registry.list("owner").length;i++)await wait(10);
      assert.equal(relay.registry.list("owner").length,0);
      // An invalid edge assertion is never downgraded to a valid cookie.
      assert.equal(await unauthorized(open(relay,"bad.jwt.assertion",{
        extra:{Cookie:"CF_Authorization="+jwt()}
      })),401);
      assert.equal((await fetch(relay.origin+"/trusted/player")).status,404,
        "the trusted WebSocket has no unprotected HTTP command route");
    }finally{await relay.close();}
});
test("expired Access identity cannot heartbeat or execute commands after registry connection remains open",{
  timeout:10000},async()=>{
    let clock=Date.now();
    const trusted=flow(()=>clock);
    const relay=await startTrustedAccessBrowserRelay({trustedBrowserFlow:trusted,ttlMs:4000});
    let ws;
    try{
      const short=jwt({exp:Math.floor(clock/1000)+2});
      ws=open(relay,short);
      const registered=await nextFrame(ws,"registered");
      assert.equal(relay.registry.list("owner").length,1);
      clock+=2500;
      const closed=new Promise(resolve=>ws.once("close",code=>resolve(code)));
      ws.send(JSON.stringify({kind:"heartbeat",state:{title:"stale"}}));
      assert.equal(await closed,1008);
      // Client close may precede the server-side close cleanup callback.
      for(let tries=0;tries<30 && relay.registry.list("owner").length;tries++)await wait(10);
      assert.equal(relay.registry.list("owner").length,0);
      assert.ok(registered.device_id);
    }finally{ws?.terminate();await relay.close();}
});
