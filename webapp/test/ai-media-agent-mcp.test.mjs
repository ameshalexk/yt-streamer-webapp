import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import WebSocket from "ws";
import { startLocalAgentRelay } from "../scripts/ai-agent-local-relay.mjs";
const token=()=>crypto.randomBytes(32).toString("hex");

async function paired(relay,pair) {
  const ws=new WebSocket(relay.origin.replace("http","ws")+"/dev/player",{origin:relay.origin});
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  const ready=new Promise(resolve=>ws.once("message",raw=>resolve(JSON.parse(String(raw)))));
  ws.send(JSON.stringify({kind:"pair",proof:pair,label:"MCP paired playback tab"}));
  const device=await ready;
  ws.on("message",raw=>{
    const frame=JSON.parse(String(raw));
    if (frame.kind==="command") ws.send(JSON.stringify({kind:"ack",command_id:frame.command_id,
      status:frame.action==="request_fullscreen"?"needs_user_gesture":"completed",
      state:{paused:frame.action==="pause",title:"Observed media",mode:"mjpeg",fullscreen_kind:"none"},
      ...(frame.action==="search_media" ? {result:{results:[{media_id:"dQw4w9WgXcQ",title:"Fetched test",creator:"Fixture",duration_seconds:90}]}} : {})}));
  });
  return {ws,device};
}
async function request(relay,owner,method,params={},opts={}) {
  const response=await fetch(relay.origin+"/dev/mcp",{
    method:"POST",headers:{authorization:`Bearer ${owner}`,"content-type":"application/json",
      accept:"application/json, text/event-stream","mcp-protocol-version":"2025-11-25",...(opts.headers||{})},
    body:JSON.stringify({jsonrpc:"2.0",id:Math.floor(Math.random()*100000),method,params}),
  });
  return {status:response.status,body:await response.json()};
}
test("authenticated real MCP JSON-RPC client handshake, tool enumeration, paired player call, search readback, errors", async()=>{
  const owner=token(),pair=token();
  const relay=await startLocalAgentRelay({ownerToken:owner,pairingToken:pair});
  let ws;
  try {
    const handshake=await request(relay,owner,"initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"test-client",version:"1"}});
    assert.equal(handshake.status,200);
    assert.equal(handshake.body.result.protocolVersion,"2025-11-25");
    assert.ok(handshake.body.result.capabilities.tools);
    const listing=await request(relay,owner,"tools/list");
    assert.equal(listing.body.result.tools.length,10);
    assert.ok(listing.body.result.tools.some(t=>t.name==="search_media"&&t.annotations.readOnlyHint));

    const first=await paired(relay,pair);ws=first.ws;
    const devices=await request(relay,owner,"tools/call",{name:"list_devices",arguments:{}});
    assert.equal(devices.body.result.structuredContent.devices[0].device_id,first.device.device_id);
    const result=await request(relay,owner,"tools/call",{name:"pause",arguments:{device_id:first.device.device_id}});
    assert.equal(result.body.result.structuredContent.status,"completed");
    assert.equal(result.body.result.structuredContent.state.paused,true);
    const search=await request(relay,owner,"tools/call",{name:"search_media",arguments:{device_id:first.device.device_id,query:"test song",limit:3}});
    assert.equal(search.body.result.structuredContent.result.results[0].media_id,"dQw4w9WgXcQ");
    const fullscreen=await request(relay,owner,"tools/call",{name:"request_fullscreen",arguments:{device_id:first.device.device_id}});
    assert.equal(fullscreen.body.result.structuredContent.status,"needs_user_gesture");
    const wrong=await request(relay,owner,"tools/call",{name:"pause",arguments:{device_id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}});
    assert.equal(wrong.body.result.structuredContent.status,"offline");
    assert.equal(wrong.body.result.isError,true);
    const invalid=await request(relay,owner,"tools/call",{name:"pause",arguments:{device_id:first.device.device_id,script:"bad"}});
    assert.equal(invalid.body.result.isError,true);
    assert.equal(invalid.body.result.content[0].text,"invalid_tool_arguments");

    assert.equal((await request(relay,"invalid","tools/list")).status,401);
    assert.equal((await request(relay,owner,"tools/list",{}, {headers:{"mcp-protocol-version":"nonsense"}})).status,400);
    const rejectedOrigin=await request(relay,owner,"tools/list",{}, {headers:{origin:"https://evil.example"}});
    assert.equal(rejectedOrigin.status,403);
    const noAccept=await request(relay,owner,"tools/list",{}, {headers:{accept:"application/json"}});
    assert.equal(noAccept.status,406);
  } finally {ws?.terminate();await relay.close();}
});
