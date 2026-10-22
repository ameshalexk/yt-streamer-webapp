import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign,randomBytes,randomUUID} from "node:crypto";
import WebSocket from "ws";
import {startLocalAgentRelay} from "../scripts/ai-agent-local-relay.mjs";
import {startLocalRemoteMcpGateway,createPinnedCloudflareJwksProvider} from "../scripts/ai-agent-remote-mcp.mjs";

const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const {n,e}=publicKey.export({format:"jwk"});
const issuer="https://example.cloudflareaccess.com",audience="remote-test-app";
const jwks={keys:[{kid:"access-key-1",kty:"RSA",use:"sig",alg:"RS256",n,e}]};
const auth=()=>randomBytes(32).toString("hex");
function jwt(subject="owner-1",values={}){
  const epoch=Math.floor(Date.now()/1000);
  const head=Buffer.from(JSON.stringify({alg:"RS256",kid:"access-key-1",typ:"JWT"})).toString("base64url");
  const payload=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub:subject,iat:epoch-10,exp:epoch+300,...values})).toString("base64url");
  return head+"."+payload+"."+sign("RSA-SHA256",Buffer.from(head+"."+payload),privateKey).toString("base64url");
}
async function call(gateway,token,name,args={},other={}){
  const body=name==="initialize"?{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25"}}
    :name==="tools/list"?{jsonrpc:"2.0",id:2,method:"tools/list"}
    :{jsonrpc:"2.0",id:3,method:"tools/call",params:{name,arguments:args}};
  const res=await fetch(gateway.origin+"/remote/mcp",{method:"POST",headers:{
    "content-type":"application/json","accept":"application/json, text/event-stream",
    "mcp-protocol-version":"2025-11-25","cf-access-jwt-assertion":token,
    "x-ai-request-id":other.nonce||randomUUID(),...other.headers},body:JSON.stringify(body)});
  const json=await res.json();
  return {code:res.status,body:json,data:json.result?.structuredContent};
}
async function setup(){
  const relay=await startLocalAgentRelay({ownerToken:auth(),pairingToken:auth()});
  const gateway=await startLocalRemoteMcpGateway({relay,audience,allowedSubjects:["owner-1"],
    jwksProvider:{issuer,get:async()=>jwks}});
  return {relay,gateway,close:async()=>{await gateway.close();await relay.close();}};
}
async function pair(relay,proof){
  const socket=new WebSocket(relay.origin.replace("http","ws")+"/dev/player",{origin:relay.origin});
  await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
  const registered=new Promise(resolve=>socket.once("message",raw=>resolve(JSON.parse(String(raw)))));
  socket.send(JSON.stringify({kind:"pair",proof,label:"Selected paired tab"}));
  return {socket,device:await registered};
}
test("trusted JWKS source is pinned, cache expires and fetch failures fail closed",async()=>{
  let at=10000,calls=0;
  const fetchImpl=async(url,options)=>{calls++;assert.equal(url,"https://example.cloudflareaccess.com/cdn-cgi/access/certs");
    assert.equal(options.redirect,"error");return {ok:true,text:async()=>JSON.stringify(jwks)};};
  assert.throws(()=>createPinnedCloudflareJwksProvider({teamDomain:"attacker.example"}),/invalid_jwks_configuration/);
  const provider=createPinnedCloudflareJwksProvider({teamDomain:"example.cloudflareaccess.com",
    fetchImpl,now:()=>at,ttlMs:1000});
  assert.equal((await provider.get()).keys.length,1);
  await provider.get();assert.equal(calls,1);
  at+=1001;await provider.get();assert.equal(calls,2);
  const broken=createPinnedCloudflareJwksProvider({teamDomain:"example.cloudflareaccess.com",
    fetchImpl:async()=>{throw Error("offline");}});
  await assert.rejects(broken.get(),/offline/);
});
test("remote MCP enforces signed Access JWT, subject allowlist, no Origin, distinct endpoint",async()=>{
  const x=await setup();try{
    assert.equal((await call(x.gateway,jwt(),"initialize")).code,200);
    const listing=await call(x.gateway,jwt(),"tools/list");
    assert.ok(listing.body.result.tools.some(t=>t.name==="request_browser_approval"));
    const notification=await fetch(x.gateway.origin+"/remote/mcp",{method:"POST",headers:{
      "content-type":"application/json",accept:"application/json, text/event-stream",
      "cf-access-jwt-assertion":jwt()},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})});
    assert.equal(notification.status,202);
    const denied=await call(x.gateway,jwt("visitor"),"list_devices");
    assert.equal(denied.code,401);
    assert.equal((await call(x.gateway,jwt("owner-1",{aud:"wrong"}),"list_devices")).code,401);
    assert.equal((await call(x.gateway,jwt("owner-1",{exp:1}),"list_devices")).code,401);
    assert.equal((await call(x.gateway,jwt().slice(0,-2)+"xx","list_devices")).code,401);
    assert.equal((await call(x.gateway,"none","list_devices")).code,401);
    assert.equal((await call(x.gateway,jwt(),"list_devices",{}, {headers:{origin:"https://untrusted.invalid"}})).code,403);
    const dev=await fetch(x.gateway.origin+"/dev/mcp");assert.equal(dev.status,404);
  }finally{await x.close();}
});
test("approval requires exact paired browser, claim by same identity and unique nonce",async()=>{
  const owner=auth(),proof=auth();
  const relay=await startLocalAgentRelay({ownerToken:owner,pairingToken:proof});
  const gateway=await startLocalRemoteMcpGateway({relay,audience,allowedSubjects:["owner-1","owner-2"],
    jwksProvider:{issuer,get:async()=>jwks}});
  let socket;
  try{
    const p=await pair(relay,proof);socket=p.socket;
    const token=jwt(),device_id=p.device.device_id;
    const devices=await call(gateway,token,"list_devices");
    assert.equal(devices.data.devices[0].device_id,device_id);
    const pendingRequest=new Promise(resolve=>socket.once("message",raw=>resolve(JSON.parse(String(raw)))));
    const requested=await call(gateway,token,"request_browser_approval",{device_id,actions:["pause","get_player_state"]});
    assert.equal(requested.data.status,"pending_browser_approval");
    const prompt=await pendingRequest;
    assert.equal(prompt.kind,"remote_approval_request");assert.equal(prompt.device_id,device_id);
    const unapproved=await call(gateway,token,"pause",{device_id,approval_id:randomUUID()});
    assert.equal(unapproved.data.status,"unauthorized");
    const crossClaim=await call(gateway,jwt("owner-2"),"claim_browser_approval",{request_id:requested.data.request_id});
    assert.equal(crossClaim.data.status,"not_found");
    const notClaimed=await call(gateway,token,"claim_browser_approval",{request_id:requested.data.request_id});
    assert.equal(notClaimed.data.status,"pending_browser_approval");
    // Approval comes only via the already paired WS, not through a public HTTP route.
    socket.send(JSON.stringify({kind:"approve_remote_request",request_id:requested.data.request_id}));
    const recorded=await new Promise(resolve=>socket.once("message",raw=>resolve(JSON.parse(String(raw)))));
    assert.equal(recorded.kind,"remote_approval_recorded");
    const claimed=await call(gateway,token,"claim_browser_approval",{request_id:requested.data.request_id});
    assert.equal(claimed.data.status,"approved");
    const approval_id=claimed.data.approval_id;
    const responseFromBrowser=new Promise(resolve=>socket.once("message",raw=>{
      const m=JSON.parse(String(raw));if(m.kind==="command"){
        socket.send(JSON.stringify({kind:"ack",command_id:m.command_id,status:"completed",state:{paused:true}}));
        resolve(m);
      }
    }));
    const response=await call(gateway,token,"pause",{device_id,approval_id});
    assert.equal(response.data.status,"completed");
    assert.equal((await responseFromBrowser).action,"pause");
    const deniedAction=await call(gateway,token,"next",{device_id,approval_id});
    assert.equal(deniedAction.data.status,"unauthorized");
    const idempotencyKey=randomUUID();
    const first=await call(gateway,token,"get_player_state",{device_id,approval_id},{nonce:idempotencyKey});
    assert.ok(first.data.status);
    const replay=await call(gateway,token,"get_player_state",{device_id,approval_id},{nonce:idempotencyKey});
    assert.equal(replay.code,409);
    const crossRevoke=await call(gateway,jwt("owner-2"),"revoke_browser_approval",{approval_id});
    assert.equal(crossRevoke.data.revoked,false);
    assert.equal((await call(gateway,jwt("owner-2"),"pause",{device_id,approval_id})).data.status,"unauthorized");
    const revoked=await call(gateway,token,"revoke_browser_approval",{approval_id});
    assert.equal(revoked.data.revoked,true);
    assert.equal((await call(gateway,token,"pause",{device_id,approval_id})).data.status,"unauthorized");
  }finally{socket?.terminate();await gateway.close();await relay.close();}
});
test("disconnect invalidates browser grants, stale IDs and unsafe arguments denied",async()=>{
  const proof=auth(),relay=await startLocalAgentRelay({ownerToken:auth(),pairingToken:proof});
  const gateway=await startLocalRemoteMcpGateway({relay,audience,allowedSubjects:["owner-1"],
    jwksProvider:{issuer,get:async()=>jwks}});
  let socket;
  try{
    const p=await pair(relay,proof);socket=p.socket;
    const token=jwt(),device_id=p.device.device_id;
    assert.equal((await call(gateway,token,"request_browser_approval",{device_id:"not-a-uuid",actions:["pause"]})).body.result.isError,true);
    assert.equal((await call(gateway,token,"request_browser_approval",{device_id,actions:["shell"]})).body.result.isError,true);
    const pending=await call(gateway,token,"request_browser_approval",{device_id,actions:["play_media"]});
    assert.equal(pending.data.status,"pending_browser_approval");
    socket.terminate();
    await new Promise(resolve=>socket.once("close",resolve));
    assert.equal((await call(gateway,token,"claim_browser_approval",{request_id:pending.data.request_id})).data.status,"not_found");
    assert.equal((await call(gateway,token,"request_browser_approval",{device_id,actions:["play_media"]})).data.status,"offline");
  }finally{socket?.terminate();await gateway.close();await relay.close();}
});

test("standard session replay protection without custom nonce headers",async()=>{
  const x=await setup();
  try{
    const token=jwt("owner-1");
    const raw=async(body,{session,identity=token,nonce}={})=>{
      const headers={"content-type":"application/json",accept:"application/json, text/event-stream",
        "cf-access-jwt-assertion":identity};
      if(session)headers["mcp-session-id"]=session;
      if(nonce)headers["x-ai-request-id"]=nonce;
      const res=await fetch(x.gateway.origin+"/remote/mcp",{method:"POST",headers,body:JSON.stringify(body)});
      return {code:res.status,headers:res.headers,body:await res.json()};
    };
    const init=await raw({jsonrpc:"2.0",id:1,method:"initialize",
      params:{protocolVersion:"2025-11-25"}});
    assert.equal(init.code,200);
    const session=init.headers.get("mcp-session-id");
    assert.ok(session?.length>=32,"session is unpredictable and non-empty");
    const command={jsonrpc:"2.0",id:12,method:"tools/call",
      params:{name:"list_devices",arguments:{}}};
    assert.equal((await raw(command,{session})).code,200);
    assert.equal((await raw(command,{session})).code,409,"same RPC id cannot execute twice");
    assert.equal((await raw({...command,id:13},{session})).code,200);
    assert.equal((await raw({...command,id:14},{session,identity:jwt("visitor")})).code,401);
    assert.equal((await raw({...command,id:15},{session,identity:jwt("owner-2")})).code,401);
    assert.equal((await raw({...command,id:16},{session:"not-valid"})).code,404);
    assert.equal((await raw({...command,id:17})).code,400,"stateless calls still need unique UUID nonce");
    const legacyId=randomUUID();
    assert.equal((await raw({...command,id:18},{nonce:legacyId})).code,200);
    assert.equal((await raw({...command,id:19},{nonce:legacyId})).code,409);
    const resumed=await raw({jsonrpc:"2.0",id:2,method:"initialize",
      params:{protocolVersion:"2025-11-25"}});
    assert.notEqual(resumed.headers.get("mcp-session-id"),session,
      "new handshake creates a new isolated replay domain");
  }finally{await x.close();}
});

test("unknown signing-key rollover refreshes pinned JWKS once; invalid tokens fail closed",async()=>{
  const rotated=generateKeyPairSync("rsa",{modulusLength:2048});
  const {n:n2,e:e2}=rotated.publicKey.export({format:"jwk"});
  const key2={kid:"access-key-2",kty:"RSA",use:"sig",alg:"RS256",n:n2,e:e2};
  let current=jwks,refreshCount=0;
  const relay=await startLocalAgentRelay({ownerToken:auth(),pairingToken:auth()});
  const gateway=await startLocalRemoteMcpGateway({relay,audience,allowedSubjects:["owner-1"],
    jwksProvider:{issuer,get:async()=>current,refresh:async()=>{
      refreshCount++;current={keys:[...jwks.keys,key2]};return current;
    }}});
  function signedRotated(overrides={},kid="access-key-2"){
    const time=Math.floor(Date.now()/1000);
    const header=Buffer.from(JSON.stringify({alg:"RS256",kid})).toString("base64url");
    const body=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub:"owner-1",
      iat:time-2,exp:time+100,...overrides})).toString("base64url");
    return header+"."+body+"."+sign("RSA-SHA256",Buffer.from(header+"."+body),rotated.privateKey).toString("base64url");
  }
  try{
    const first=await call(gateway,signedRotated(),"list_devices");
    assert.equal(first.code,200);
    assert.equal(refreshCount,1,"missing key triggers one trusted refresh");
    assert.equal((await call(gateway,signedRotated(),"list_devices")).code,200);
    assert.equal(refreshCount,1,"known key is cached");
    assert.equal((await call(gateway,signedRotated({exp:1}),"list_devices")).code,401);
    assert.equal((await call(gateway,signedRotated({aud:"another-app"}),"list_devices")).code,401);
    assert.equal((await call(gateway,signedRotated({sub:"intruder"}),"list_devices")).code,401);
    assert.equal((await call(gateway,signedRotated({},"unknown-key"),"list_devices")).code,401);
    assert.equal(refreshCount,1,"unrecognized kid cannot flood pinned JWKS");
  }finally{await gateway.close();await relay.close();}
});
