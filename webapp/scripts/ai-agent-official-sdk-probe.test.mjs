// Independent official MCP SDK v2 compatibility probe.
// ISOLATED TEST ONLY: ephemeral loopback ports, synthetic Access JWT, no production services.
import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign,randomBytes} from "node:crypto";
import WebSocket from "ws";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {startLocalAgentRelay} from "./ai-agent-local-relay.mjs";
import {startLocalRemoteMcpGateway} from "./ai-agent-remote-mcp.mjs";

const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const {n,e}=publicKey.export({format:"jwk"});
const issuer="https://example.cloudflareaccess.com";
const audience="official-sdk-compat-probe";
const jwks={keys:[{kid:"test-key",kty:"RSA",use:"sig",alg:"RS256",n,e}]};
const secret=()=>randomBytes(32).toString("hex");
function signedJwt(subject="owner-1"){
  const now=Math.floor(Date.now()/1000);
  const head=Buffer.from(JSON.stringify({alg:"RS256",kid:"test-key",typ:"JWT"})).toString("base64url");
  const claims=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub:subject,iat:now-1,exp:now+90})).toString("base64url");
  return head+"."+claims+"."+sign("RSA-SHA256",Buffer.from(head+"."+claims),privateKey).toString("base64url");
}
function makeClient(url,token,versionNegotiation={mode:"auto"}){
  // Unmodified official MCP transport: NO custom per-request nonce/fetch adapter.
  // Server-issued Mcp-Session-Id binds identity and deduplicates JSON-RPC IDs.
  const client=new Client({name:"yt-streamer-official-sdk-probe",version:"0.1.0"},{versionNegotiation});
  const transport=new StreamableHTTPClientTransport(new URL(url+"/remote/mcp"),{
    requestInit:{headers:{"cf-access-jwt-assertion":token}}
  });
  return {client,transport};
}
function textResult(result){
  return result.structuredContent ||
    JSON.parse(result.content.find(part=>part.type==="text").text);
}
test("official SDK v2: auto fallback, tools, identity-bound approval, readback, modern pin rejection",{
  timeout:45000
},async()=>{
  const proof=secret();
  const relay=await startLocalAgentRelay({ownerToken:secret(),pairingToken:proof});
  const gateway=await startLocalRemoteMcpGateway({relay,audience,allowedSubjects:["owner-1"],jwksProvider:{issuer,get:async()=>jwks}});
  const clients=[];
  let browser;
  try{
    browser=new WebSocket(relay.origin.replace("http","ws")+"/dev/player",{origin:relay.origin});
    await new Promise((resolve,reject)=>{browser.once("open",resolve);browser.once("error",reject);});
    const registered=new Promise(resolve=>browser.once("message",msg=>resolve(JSON.parse(String(msg)))));
    browser.send(JSON.stringify({kind:"pair",proof,label:"Official SDK test tab"}));
    const paired=await registered;
    assert.equal(paired.kind,"registered");
    const device_id=paired.device_id;
    const sdk=makeClient(gateway.origin,signedJwt());
    clients.push(sdk.client);
    await sdk.client.connect(sdk.transport);
    assert.equal(sdk.client.getProtocolEra(),"legacy"); // 2025-11-25 fallback
    assert.ok(sdk.transport.sessionId?.length>=32,"official SDK must echo issued session ID");
    const list=await sdk.client.listTools();
    assert.ok(list.tools.some(t=>t.name==="request_browser_approval"));
    assert.ok(list.tools.some(t=>t.name==="get_player_state"));
    const devices=textResult(await sdk.client.callTool({name:"list_devices",arguments:{}}));
    assert.equal(devices.devices[0].device_id,device_id);
    const browserPrompt=new Promise(resolve=>browser.once("message",raw=>resolve(JSON.parse(String(raw)))));
    const request=textResult(await sdk.client.callTool({name:"request_browser_approval",
      arguments:{device_id,actions:["get_player_state"]}}));
    assert.equal(request.status,"pending_browser_approval");
    const prompt=await browserPrompt;
    assert.equal(prompt.kind,"remote_approval_request");
    assert.equal(prompt.request_id,request.request_id);
    browser.send(JSON.stringify({kind:"approve_remote_request",request_id:request.request_id}));
    await new Promise(resolve=>browser.once("message",raw=>{assert.equal(JSON.parse(String(raw)).kind,"remote_approval_recorded");resolve();}));
    const grant=textResult(await sdk.client.callTool({name:"claim_browser_approval",
      arguments:{request_id:request.request_id}}));
    assert.equal(grant.status,"approved");
    const received=new Promise(resolve=>browser.once("message",raw=>{
      const message=JSON.parse(String(raw));
      assert.equal(message.kind,"command");
      assert.equal(message.action,"get_player_state");
      browser.send(JSON.stringify({kind:"ack",command_id:message.command_id,status:"completed",
        state:{paused:true,playback_phase:"paused"}}));
      resolve(message);
    }));
    const result=textResult(await sdk.client.callTool({name:"get_player_state",
      arguments:{device_id,approval_id:grant.approval_id}}));
    await received;
    assert.equal(result.status,"completed");

    const pinned=makeClient(gateway.origin,signedJwt(),{mode:{pin:"2026-07-28"}});
    clients.push(pinned.client);
    await assert.rejects(pinned.client.connect(pinned.transport));
    const forbidden=makeClient(gateway.origin,signedJwt("unknown"));
    clients.push(forbidden.client);
    await assert.rejects(forbidden.client.connect(forbidden.transport));
  }finally{
    for(const client of clients)await client.close().catch(()=>{});
    browser?.terminate();
    await gateway.close();
    await relay.close();
  }
});
