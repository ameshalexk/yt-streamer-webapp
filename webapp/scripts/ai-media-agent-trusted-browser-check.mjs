// Development-only real Chrome + signed browser-cookie + MCP relay acceptance.
// No production listener, tunnel, device, secrets, or actual media playback.
import assert from "node:assert/strict";
import http from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {generateKeyPairSync,sign,randomUUID} from "node:crypto";
import {chromium} from "playwright-core";
import {TrustedBrowserRegistrationFlow} from "../src/lib/ai-media-agent-trusted-browser-flow.js";
import {startTrustedAccessBrowserRelay} from "./ai-agent-trusted-access-relay.mjs";
import {startLocalRemoteMcpGateway} from "./ai-agent-remote-mcp.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../public");
const chrome=process.env.CHROME_PATH || process.env.MOBILE_TEST_CHROME ||
  (process.platform==="darwin"?"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome":"/usr/bin/google-chrome");
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const issuer="https://phase3-test.cloudflareaccess.com";
const audience="yt-streamer-phase3-test";
const pub=publicKey.export({format:"jwk"});
const jwks={issuer,get:async()=>({keys:[{...pub,kid:"phase3-key",use:"sig",alg:"RS256"}]})};
const encode=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
function token(sub="owner"){
  const at=Math.floor(Date.now()/1000);
  const h=encode({alg:"RS256",kid:"phase3-key"});
  const p=encode({sub,iss:issuer,aud:audience,iat:at-15,exp:at+300});
  return h+"."+p+"."+sign("RSA-SHA256",Buffer.from(h+"."+p),privateKey).toString("base64url");
}
async function mcp(gateway,subject,action,args){
  const response=await fetch(gateway.origin+"/remote/mcp",{
    method:"POST",
    headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
      "cf-access-jwt-assertion":token(subject),"x-ai-request-id":randomUUID()},
    body:JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:"tools/call",
      params:{name:action,arguments:args}})
  });
  const raw=await response.json();
  assert.equal(response.status,200,action+" "+JSON.stringify(raw));
  return {data:raw.result?.structuredContent,isError:raw.result?.isError};
}
const fixtureHtml=`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Trusted MCP browser fixture</title></head>
<body><h1>Trusted playback test fixture</h1>
<script>
window.__calls=[];
let phase="idle";
window.YTStreamerMediaAgent={
  get_player_state:()=>({playback_phase:phase,mode:"mjpeg",media_id:phase==="idle"?"":"jNQXAC9IVRw",paused:phase==="paused"}),
  execute:async(action,args)=>{
    window.__calls.push(action);
    if(action==="search_media")return {status:"completed",result:{results:[{
      media_id:"jNQXAC9IVRw",title:"Local phase 3 test media",creator:"Fixture",duration_seconds:30}]}};
    if(action==="get_player_state")return {status:"completed",state:window.YTStreamerMediaAgent.get_player_state()};
    if(action==="play_media"){if(args.media_id!=="jNQXAC9IVRw")return {status:"failed",error:"invalid_media"};phase="playing";return {status:"accepted"};}
    if(action==="pause"){phase="paused";return {status:"completed"};}
    if(action==="resume"){phase="playing";return {status:"accepted"};}
    if(action==="stop"){phase="idle";return {status:"completed"};}
    return {status:"failed",error:"not_supported"};
  }
};
</script>
<script src="/ai-media-agent-trusted-dev.js"></script>
</body></html>`;

async function serve(){
  const server=http.createServer(async(req,res)=>{
    if(req.method!=="GET"){res.writeHead(405).end();return;}
    if(req.url?.startsWith("/ai-media-agent-trusted-dev.js")){
      const source=await readFile(path.join(root,"ai-media-agent-trusted-dev.js"));
      res.writeHead(200,{"content-type":"text/javascript; charset=utf-8",
        "cache-control":"no-store","x-content-type-options":"nosniff"});res.end(source);
    }else{
      res.writeHead(200,{"content-type":"text/html; charset=utf-8",
        "cache-control":"no-store","x-content-type-options":"nosniff"});res.end(fixtureHtml);
    }
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  return {origin:"http://127.0.0.1:"+server.address().port,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
async function paired(page,port,origin){
  await page.goto(origin+"/?ai_agent_trusted_dev", {waitUntil:"domcontentloaded"});
  await page.locator("#aiAgentTrustedPort").fill(String(port));
  await page.locator("#aiAgentTrustedConnect").click();
  await page.waitForFunction(()=>document.querySelector("#aiAgentTrustedStatus")?.textContent?.includes("Authenticated browser paired:"),null,{timeout:10000});
}
async function run(){
  let fixture,relay,gateway,browser;
  try{
    fixture=await serve();
    const signed=token();
    const flow=new TrustedBrowserRegistrationFlow({
      jwksProvider:jwks,audience,allowedOrigins:[fixture.origin],
      allowedSubjects:["owner"]
    });
    relay=await startTrustedAccessBrowserRelay({trustedBrowserFlow:flow,ttlMs:20000,timeoutMs:3000});
    gateway=await startLocalRemoteMcpGateway({
      relay,jwksProvider:jwks,audience,allowedSubjects:["owner"],timeoutMs:3000
    });
    const relayPort=Number(new URL(relay.origin).port);
    browser=await chromium.launch({executablePath:chrome,headless:true,args:["--no-sandbox"]});
    const ctx=await browser.newContext();
    await ctx.addCookies([{name:"CF_Authorization",value:signed,domain:"127.0.0.1",path:"/",
      httpOnly:true,secure:false,sameSite:"Lax"}]);
    const selected=await ctx.newPage(),decoy=await ctx.newPage();
    await paired(selected,relayPort,fixture.origin);
    await paired(decoy,relayPort,fixture.origin);
    // A real browser without any signed Access cookie cannot register.
    const unauth=await browser.newContext();
    const unauthPage=await unauth.newPage();
    await unauthPage.goto(fixture.origin+"/?ai_agent_trusted_dev",{waitUntil:"domcontentloaded"});
    await unauthPage.locator("#aiAgentTrustedPort").fill(String(relayPort));
    await unauthPage.locator("#aiAgentTrustedConnect").click();
    await unauthPage.waitForFunction(()=>document.querySelector("#aiAgentTrustedStatus")
      ?.textContent?.includes("Disconnected; no remote action is authorized"),null,{timeout:10000});
    await unauth.close();
    const intruderContext=await browser.newContext();
    await intruderContext.addCookies([{name:"CF_Authorization",value:token("intruder"),
      domain:"127.0.0.1",path:"/",httpOnly:true,secure:false,sameSite:"Lax"}]);
    const intruder=await intruderContext.newPage();
    await intruder.goto(fixture.origin+"/?ai_agent_trusted_dev",{waitUntil:"domcontentloaded"});
    await intruder.locator("#aiAgentTrustedPort").fill(String(relayPort));
    await intruder.locator("#aiAgentTrustedConnect").click();
    await intruder.waitForFunction(()=>document.querySelector("#aiAgentTrustedStatus")
      ?.textContent?.includes("Disconnected; no remote action is authorized"),null,{timeout:10000});
    await intruderContext.close();
    const listed=await mcp(gateway,"owner","list_devices",{});
    assert.equal(listed.data.devices.length,2);
    const devices=listed.data.devices;
    const target=devices[0].device_id,other=devices[1].device_id;
    const actions=["get_player_state","search_media","play_media","pause","resume","stop"];

    const unapproved=await mcp(gateway,"owner","play_media",{
      device_id:target,approval_id:randomUUID(),media_id:"jNQXAC9IVRw"});
    assert.equal(unapproved.data.status,"unauthorized");
    assert.equal(unapproved.isError,true);
    assert.deepEqual(await selected.evaluate(()=>window.__calls),[]);

    const first=await mcp(gateway,"owner","request_browser_approval",{device_id:target,actions});
    assert.equal(first.data.status,"pending_browser_approval");
    await selected.locator("#aiAgentTrustedRequests [data-ai-action=approve]").waitFor();
    assert.equal(await decoy.locator("#aiAgentTrustedRequests [data-ai-action=approve]").count(),0,
      "Only the selected tab receives a permission request");
    assert.equal((await mcp(gateway,"owner","claim_browser_approval",
      {request_id:first.data.request_id})).data.status,"pending_browser_approval");
    // An untrusted JS-created synthetic click MUST NOT submit approval.
    await selected.evaluate(()=>{
      document.querySelector("#aiAgentTrustedRequests [data-ai-action=approve]")
        .dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
    });
    assert.equal((await mcp(gateway,"owner","claim_browser_approval",
      {request_id:first.data.request_id})).data.status,"pending_browser_approval");
    await selected.locator("#aiAgentTrustedRequests [data-ai-action=deny]").click();
    assert.equal((await mcp(gateway,"owner","claim_browser_approval",
      {request_id:first.data.request_id})).data.status,"pending_browser_approval");
    // Second request requires a NEW direct, trusted browser click.
    const next=await mcp(gateway,"owner","request_browser_approval",{device_id:target,actions});
    await selected.locator("#aiAgentTrustedRequests [data-ai-action=approve]").click();
    const grant=await mcp(gateway,"owner","claim_browser_approval",
      {request_id:next.data.request_id});
    assert.equal(grant.data.status,"approved");
    const scoped={device_id:target,approval_id:grant.data.approval_id};
    const search=await mcp(gateway,"owner","search_media",{...scoped,query:"test media",limit:1});
    assert.equal(search.data.status,"completed");
    assert.equal(search.data.result.results[0].media_id,"jNQXAC9IVRw");
    const play=await mcp(gateway,"owner","play_media",{...scoped,media_id:"jNQXAC9IVRw"});
    assert.equal(play.data.status,"accepted");
    const observe=await mcp(gateway,"owner","get_player_state",scoped);
    assert.equal(observe.data.state.playback_phase,"playing");
    assert.equal((await mcp(gateway,"owner","pause",scoped)).data.status,"completed");
    assert.equal((await mcp(gateway,"owner","get_player_state",scoped)).data.state.playback_phase,"paused");
    assert.equal((await mcp(gateway,"owner","resume",scoped)).data.status,"accepted");
    assert.equal((await mcp(gateway,"owner","get_player_state",scoped)).data.state.playback_phase,"playing");
    assert.equal((await mcp(gateway,"owner","stop",scoped)).data.status,"completed");
    assert.equal((await mcp(gateway,"owner","get_player_state",scoped)).data.state.playback_phase,"idle");
    assert.deepEqual(await decoy.evaluate(()=>window.__calls),[],"decoy must remain idle");
    const cross=await mcp(gateway,"owner","pause",{device_id:other,approval_id:grant.data.approval_id});
    assert.equal(cross.data.status,"unauthorized");
    await selected.locator("#aiAgentTrustedDisconnect").click();
    await selected.waitForFunction(()=>document.querySelector("#aiAgentTrustedStatus")?.textContent?.includes("Disconnected by this tab"));
    const revoked=await mcp(gateway,"owner","pause",scoped);
    assert.equal(revoked.data.status,"unauthorized");
    const counts={commands:(await selected.evaluate(()=>window.__calls)).length,decoyCommands:0};
    console.log(JSON.stringify({result:"PASS",browser:await browser.version(),mode:"signed Access cookie to real Chrome UI (synthetic playback fixture)",
      authentication:"provider-signed RS256; unsigned and disallowed-subject browsers rejected",
      approval:"required genuine user click",scope:"selected tab only",
      resultPhases:["search","play","pause","resume","stop","state readback","disconnect revoke"],
      ...counts},null,2));
  }finally{
    if(browser)await browser.close();
    if(gateway)await gateway.close();
    if(relay)await relay.close();
    if(fixture)await fixture.close();
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});