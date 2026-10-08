import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startLocalAgentRelay } from "../scripts/ai-agent-local-relay.mjs";
import { startLocalRemoteMcpGateway } from "../scripts/ai-agent-remote-mcp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const key = () => crypto.randomBytes(32).toString("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

async function fixture() {
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    res.setHeader("Cache-Control","no-store");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type","application/json");
      const body = url.pathname === "/api/youtube/search" ? {items:[
        {id:"dQw4w9WgXcQ",title:"Test: safe media title",channelTitle:"Test channel",duration:120,url:"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}]}
        : url.pathname === "/api/health" ? {ok:true,activeStreams:0}
        : url.pathname === "/api/playlists" ? [] : url.pathname === "/api/watch-history" ? []
        : url.pathname === "/api/sessions" ? {counts:{browserSessions:0,realChromeSessions:0},browserSessions:[],realChromeSessions:[]}
        : {};
      res.end(JSON.stringify(body)); return;
    }
    const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
    const file = path.resolve(root,name);
    if (!file.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
    try {
      const data=await fs.readFile(file);
      const ext=path.extname(file);
      res.setHeader("Content-Type",({".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".webmanifest":"application/manifest+json"})[ext]||"application/octet-stream");
      res.end(data);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}

test("two REAL Chrome tabs: explicit pairing, selected-tab state/commands, negative auth, stale IDs and reconnect", {timeout:45000}, async t => {
  const site = await fixture();
  const owner=key(), pairing=key();
  const relay=await startLocalAgentRelay({ownerToken:owner,pairingToken:pairing,browserOrigin:site.origin,ttlMs:7000});
  let browser, remoteGateway;
  try {
    browser=await chromium.launch({channel:"chrome",headless:true,args:["--no-first-run","--no-default-browser-check"]});
    const context=await browser.newContext();
    const target=await context.newPage();
    const control=await context.newPage();
    const errors=[];
    target.on("pageerror",err=>errors.push(err.message));
    await target.goto(site.origin+"/?ai_agent_dev=1",{waitUntil:"load"});
    await control.goto(site.origin+"/?ai_agent_dev=1",{waitUntil:"load"});
    await target.waitForFunction(()=>Boolean(window.YTStreamerMediaAgent));
    assert.equal(await target.locator("#aiAgentDevPanel").count(),1);
    const port=String(new URL(relay.origin).port);
    await target.locator("#aiAgentRelay").fill(port);
    await target.locator("#aiAgentPairing").fill(pairing);
    await target.locator("#aiAgentLabel").fill("Tesla simulated tab");
    await target.locator("#aiAgentConnect").click();
    await target.waitForFunction(()=>document.querySelector("#aiAgentStatus").textContent.includes("Paired"),{timeout:5000});
    const oldId=await target.locator("#aiAgentDevice").textContent();
    assert.match(oldId,/^[0-9a-f-]{36}$/);
    await control.locator("#aiAgentRelay").fill(port);
    await control.locator("#aiAgentOwner").fill(owner);
    await control.locator("#aiAgentRefresh").click();
    await control.waitForFunction(()=>document.querySelector("#aiAgentTarget").options.length===1);
    assert.equal(await control.locator("#aiAgentTarget").inputValue(),oldId);
    // The *controller browser tab* issues an authenticated fetch, not a Node-only simulation.
    await control.locator("#aiAgentSend").click();
    await control.waitForFunction(()=>document.querySelector("#aiAgentResult").textContent.includes('"status": "completed"'));
    assert.match(await control.locator("#aiAgentResult").textContent(),/inactive/);

    // Search in the real app adapter and read back actual, bounded results.
    await control.locator("#aiAgentAction").selectOption("search_media");
    await control.locator("#aiAgentArg").fill("safe music");
    await control.locator("#aiAgentSend").click();
    await control.waitForFunction(()=>document.querySelector("#aiAgentResult").textContent.includes("dQw4w9WgXcQ"));
    assert.match(await control.locator("#aiAgentResult").textContent(),/Test channel/);

    // Prime only the existing app's *test playback state*, no network media playback.
    await target.evaluate(() => {
      replayFn = () => {};
      document.querySelector("#screen").classList.add("playing","mjpeg-mode");
      document.querySelector("#pauseBtn").disabled = false;
      document.querySelector("#nowPlaying").textContent = "Test media";
    });
    await control.locator("#aiAgentAction").selectOption("pause");
    await control.locator("#aiAgentSend").click();
    await control.waitForFunction(()=>document.querySelector("#aiAgentResult").textContent.includes('"paused": true'));
    assert.equal(await target.evaluate(()=>playbackPaused),true);
    // Volume is NOT silently written to an unverified Tesla/system output.
    await control.locator("#aiAgentAction").selectOption("set_volume");
    await control.locator("#aiAgentArg").fill("30");
    await control.locator("#aiAgentSend").click();
    await control.waitForFunction(()=>document.querySelector("#aiAgentResult").textContent.includes('"status": "unsupported"'));

    // Remote MCP claim requires an actual trusted Playwright click on the real browser UI.
    const pairKeys=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
    const publicJwk=pairKeys.publicKey.export({format:"jwk"});
    const remoteIssuer="https://example.cloudflareaccess.com", remoteAudience="chrome-test-app";
    const epoch=Math.floor(Date.now()/1000);
    const h=Buffer.from(JSON.stringify({alg:"RS256",kid:"chrome-test-key"})).toString("base64url");
    const b=Buffer.from(JSON.stringify({iss:remoteIssuer,aud:remoteAudience,sub:"owner-test",iat:epoch-10,exp:epoch+300})).toString("base64url");
    const remoteJwt=h+"."+b+"."+crypto.sign("RSA-SHA256",Buffer.from(h+"."+b),pairKeys.privateKey).toString("base64url");
    remoteGateway=await startLocalRemoteMcpGateway({relay,audience:remoteAudience,allowedSubjects:["owner-test"],
      jwksProvider:{issuer:remoteIssuer,get:async()=>({keys:[{kid:"chrome-test-key",kty:"RSA",use:"sig",n:publicJwk.n,e:publicJwk.e}]})}});
    async function remoteTool(name,args){
      const response=await fetch(remoteGateway.origin+"/remote/mcp",{method:"POST",
        headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
          "cf-access-jwt-assertion":remoteJwt,"x-ai-request-id":crypto.randomUUID()},
        body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name,arguments:args}})});
      assert.equal(response.status,200);
      return (await response.json()).result.structuredContent;
    }
    const challenge=await remoteTool("request_browser_approval",{device_id:oldId,actions:["get_player_state","pause"]});
    assert.equal(challenge.status,"pending_browser_approval");
    await target.locator("#aiAgentApproveRemote").waitFor();
    const beforeConsent=await remoteTool("claim_browser_approval",{request_id:challenge.request_id});
    assert.equal(beforeConsent.status,"pending_browser_approval");
    await target.locator("#aiAgentApproveRemote").click(); // trusted user-activation event
    let grant;
    for(let retry=0;retry<12;retry++){
      grant=await remoteTool("claim_browser_approval",{request_id:challenge.request_id});
      if(grant.status==="approved")break;
      await delay(40);
    }
    assert.equal(grant.status,"approved");
    const remoteState=await remoteTool("get_player_state",{device_id:oldId,approval_id:grant.approval_id});
    assert.equal(remoteState.status,"completed");
    assert.equal(remoteState.state.paused,true);
    const outOfScope=await remoteTool("next",{device_id:oldId,approval_id:grant.approval_id});
    assert.equal(outOfScope.status,"unauthorized");

    // Browser fetch with wrong credentials must fail (no anonymous command).
    const forbidden=await control.evaluate(async ({port,id}) => {
      const r=await fetch(`http://127.0.0.1:${port}/dev/command`,{
        method:"POST",headers:{"Authorization":"Bearer wrong","Content-Type":"application/json"},
        body:JSON.stringify({device_id:id,action:"pause"})
      });
      return r.status;
    },{port,id:oldId});
    assert.equal(forbidden,401);
    const wrong=await control.evaluate(async ({port,id,owner}) => {
      const r=await fetch(`http://127.0.0.1:${port}/dev/command`,{
        method:"POST",headers:{"Authorization":`Bearer ${owner}`,"Content-Type":"application/json"},
        body:JSON.stringify({device_id:id,action:"pause"})
      });
      return r.json();
    },{port,id:"a0000000-0000-0000-0000-000000000000",owner});
    assert.equal(wrong.status,"offline");

    // The real Chrome browser may not expose experimental WebMCP. Feature detection is honest.
    const nativeWebMcp = await target.evaluate(() => Boolean(document.modelContext?.registerTool));
    assert.equal(typeof nativeWebMcp, "boolean");
    const webMcpMock = await target.evaluate(async () => {
      const registered = [];
      Object.defineProperty(document, "modelContext", {configurable:true,value:{registerTool:async tool=>{registered.push(tool);}}});
      await new Promise((resolve,reject) => {
        const el=document.createElement("script");
        el.src="/ai-media-agent-webmcp.js?mock=1";
        el.onload=resolve; el.onerror=reject; document.body.append(el);
      });
      await new Promise(resolve=>setTimeout(resolve,30));
      const snapshot=await registered.find(item=>item.name==="yt_player_state").execute({});
      const search=await registered.find(item=>item.name==="yt_search_media").execute({query:"fixture search",limit:1});
      return {names:registered.map(item=>item.name),snapshot,search,status:window.YTStreamerWebMCPStatus};
    });
    assert.equal(webMcpMock.status,"registered");
    assert.equal(webMcpMock.names.length,8);
    assert.match(webMcpMock.snapshot,/"paused":true/);
    assert.match(webMcpMock.search,/"media_id":"dQw4w9WgXcQ"/);
    t.diagnostic(`Native Chrome WebMCP API available in this test build: ${nativeWebMcp}; mocked feature-detection registration passed`);

    // Force a transient WebSocket disconnect (local test hook), prove automatic re-pairing.
    relay.disconnectPlayersForTest();
    await target.waitForFunction(old => {
      const value=document.querySelector("#aiAgentDevice")?.textContent || "";
      return value.length === 36 && value !== old && document.querySelector("#aiAgentStatus")?.textContent.includes("Paired");
    },oldId,{timeout:8000});
    const recoveredId=await target.locator("#aiAgentDevice").textContent();
    assert.notEqual(recoveredId,oldId);
    const preReconnect=await fetch(relay.origin+"/dev/command",{method:"POST",headers:{authorization:`Bearer ${owner}`,"content-type":"application/json"},body:JSON.stringify({device_id:oldId,action:"pause"})}).then(r=>r.json());
    assert.equal(preReconnect.status,"offline");
    await control.locator("#aiAgentRefresh").click();
    await control.waitForFunction(id=>document.querySelector("#aiAgentTarget").value===id,recoveredId);

    // Closing the real target tab expires its identity; reconnect gets NEW ID.
    await target.close();
    await delay(100);
    const stale=await fetch(relay.origin+"/dev/command",{method:"POST",headers:{authorization:`Bearer ${owner}`,"content-type":"application/json"},body:JSON.stringify({device_id:recoveredId,action:"get_player_state"})}).then(r=>r.json());
    assert.equal(stale.status,"offline");
    const replacement=await context.newPage();
    await replacement.goto(site.origin+"/?ai_agent_dev=1");
    await replacement.locator("#aiAgentRelay").fill(port);
    await replacement.locator("#aiAgentPairing").fill(pairing);
    await replacement.locator("#aiAgentConnect").click();
    await replacement.waitForFunction(()=>document.querySelector("#aiAgentStatus").textContent.includes("Paired"));
    const newId=await replacement.locator("#aiAgentDevice").textContent();
    assert.notEqual(newId,oldId);
    assert.deepEqual(errors,[]);
    t.diagnostic("two real development tabs, explicit selection, state ACK, search, pause, unsupported volume, denied auth, stale identity and new pairing passed");
  } finally { await remoteGateway?.close(); await browser?.close(); await relay.close(); await site.close(); }
});
