import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {generateKeyPairSync,sign,randomUUID} from "node:crypto";
import {WebSocket,WebSocketServer} from "ws";
import {TrustedBrowserRegistrationFlow} from "../src/lib/ai-media-agent-trusted-browser-flow.js";

const nowSec=2000000000;
const issuer="https://verified-team.cloudflareaccess.com";
const aud="test-app-audience-123";
const origin="https://player.example.test";
const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});
const provider={issuer,get:async()=>({keys:[{...jwk,kid:"real-signature-key",use:"sig",alg:"RS256"}]})};
function jwt({sub="owner",iss=issuer,audience=aud,exp=nowSec+100,iat=nowSec-10}={}){
  const b=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
  const head=b({alg:"RS256",kid:"real-signature-key"});
  const body=b({sub,iss,aud:audience,exp,iat});
  const input=head+"."+body;
  return input+"."+sign("RSA-SHA256",Buffer.from(input),privateKey).toString("base64url");
}
function makeFlow(clock=()=>nowSec*1000){
  return new TrustedBrowserRegistrationFlow({jwksProvider:provider,audience:aud,
    allowedOrigins:[origin],allowedSubjects:["owner"],now:clock});
}
function request(token,extra={}){
  return {headers:{origin,upgrade:"websocket",connection:"keep-alive, Upgrade",
    "cf-access-jwt-assertion":token,...extra}};
}
test("cryptographically verified Access upgrade binds server-owned identity, device, connection and actions",async()=>{
  const flow=makeFlow();
  const connection=await flow.connect(request(jwt(),{"x-user-email":"intruder@example.test"}));
  assert.ok(connection.device_id&&connection.connection_id);
  assert.notEqual(connection.device_id,connection.connection_id);
  assert.equal(flow.authorize({},randomUUID(),"pause"),false,"fabricated handle cannot authorize");
  const nonce=flow.issue(connection.handle,["get_player_state","pause"]).registration_nonce;
  assert.equal(flow.redeem({},nonce),null,"fabricated handle cannot redeem nonce");
  const grant=flow.redeem(connection.handle,nonce);
  assert.ok(grant.registration_id);
  assert.equal(flow.redeem(connection.handle,nonce),null,"single use nonce");
  assert.equal(flow.authorize(connection.handle,grant.registration_id,"pause"),true);
  assert.equal(flow.authorize(connection.handle,grant.registration_id,"play_media"),false);
  assert.equal(flow.disconnect(connection.handle),true);
  assert.equal(flow.disconnect(connection.handle),false);
  assert.equal(flow.authorize(connection.handle,grant.registration_id,"pause"),false);
});
test("trusted browser upgrade denies spoofed, expired, wrong scope and unverified inputs",async()=>{
  const flow=makeFlow();
  const good=jwt();
  for(const req of [
    request(good,{origin:"https://evil.example.test"}),
    request(good,{upgrade:"h2c"}),
    request(good,{connection:"keep-alive"}),
    request(good,{"cf-access-jwt-assertion":undefined}),
    request(good,{"cf-access-jwt-assertion":good.slice(0,-2)+"xx"}),
    request(jwt({sub:"other"})),
    request(jwt({audience:"wrong-audience"})),
    request(jwt({iss:"https://another.cloudflareaccess.com"})),
    request(jwt({exp:nowSec-1})),
    request(good,{cookie:"CF_Authorization="+jwt({sub:"other"})}),
    request(good,{"cf-access-jwt-assertion":undefined,cookie:"CF_Authorization=bad"})
  ])await assert.rejects(()=>flow.connect(req),/trusted_browser_denied/);
  const cookieSession=await flow.connect(request(good,{"cf-access-jwt-assertion":undefined,
    cookie:"another=abc; CF_Authorization="+good}));
  assert.ok(cookieSession.handle,"signed Access cookie accepted without supplied principal");
  flow.disconnect(cookieSession.handle);
});
test("JWT expiry closes active authorization and reconnection mints new identifiers",async()=>{
  let clock=nowSec*1000;
  const flow=makeFlow(()=>clock);
  const first=await flow.connect(request(jwt({exp:nowSec+3})));
  const nonce=flow.issue(first.handle,["pause"]).registration_nonce;
  const grant=flow.redeem(first.handle,nonce);
  assert.equal(flow.authorize(first.handle,grant.registration_id,"pause"),true);
  clock+=3001;
  assert.equal(flow.authorize(first.handle,grant.registration_id,"pause"),false);
  assert.throws(()=>flow.issue(first.handle,["pause"]),/trusted_browser_denied/);
  flow.disconnect(first.handle);
  const second=await flow.connect(request(jwt({iat:nowSec,exp:nowSec+100})));
  assert.notEqual(second.device_id,first.device_id);
  assert.notEqual(second.connection_id,first.connection_id);
  assert.equal(flow.authorize(second.handle,grant.registration_id,"pause"),false);
  flow.disconnect(second.handle);
});
test("real loopback WebSocket upgrade verifies Access BEFORE registration and revokes on disconnect",async()=>{
  const flow=makeFlow();
  const wss=new WebSocketServer({noServer:true});
  const server=http.createServer((_req,res)=>{res.writeHead(404);res.end();});
  const record=[];
  let serverSocketClosed;
  const closedOnServer=new Promise(resolve=>{serverSocketClosed=resolve;});
  server.on("upgrade",async(req,socket,head)=>{
    try{
      const conn=await flow.connect(req);
      wss.handleUpgrade(req,socket,head,ws=>{
        const nonce=flow.issue(conn.handle,["get_player_state"]).registration_nonce;
        ws.send(JSON.stringify({kind:"challenge",nonce}));
        ws.on("message",raw=>{
          const data=JSON.parse(raw.toString());
          const grant=flow.redeem(conn.handle,data.nonce);
          record.push({grant,allowed:grant&&flow.authorize(conn.handle,grant.registration_id,"get_player_state")});
          ws.send(JSON.stringify({kind:"registered",approved:!!record.at(-1).allowed}));
        });
        ws.on("close",()=>{flow.disconnect(conn.handle);record.push({closed:true});serverSocketClosed();});
      });
    }catch{socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");socket.destroy();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="ws://127.0.0.1:"+server.address().port;
  try{
    const refused=new WebSocket(url,{origin,headers:{"Cf-Access-Jwt-Assertion":"forged"}});
    const refusedResult=await new Promise(resolve=>{
      refused.once("unexpected-response",(_req,res)=>resolve(res.statusCode));
      refused.once("error",()=>resolve("error"));
    });
    assert.equal(refusedResult,401);
    const ws=new WebSocket(url,{origin,headers:{"Cf-Access-Jwt-Assertion":jwt()}});
    const outcome=await new Promise((resolve,reject)=>{
      ws.once("error",reject);
      ws.on("message",data=>{
        const msg=JSON.parse(data.toString());
        if(msg.kind==="challenge")ws.send(JSON.stringify({nonce:msg.nonce,identity:"intruder",device_id:randomUUID()}));
        if(msg.kind==="registered")resolve(msg);
      });
    });
    assert.equal(outcome.approved,true);
    ws.close();
    await new Promise(resolve=>ws.once("close",resolve));
    await closedOnServer;
    assert.equal(record.at(-1).closed,true);
  }finally{
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>server.close(resolve));
  }
});
