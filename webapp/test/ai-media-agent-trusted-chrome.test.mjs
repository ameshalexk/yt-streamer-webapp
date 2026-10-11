import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright-core";
import {generateKeyPairSync,sign,randomUUID} from "node:crypto";
import {TrustedBrowserRegistrationFlow} from "../src/lib/ai-media-agent-trusted-browser-flow.js";
import {startTrustedAccessBrowserRelay} from "../scripts/ai-agent-trusted-access-relay.mjs";
import {startLocalRemoteMcpGateway} from "../scripts/ai-agent-remote-mcp.mjs";

const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../public");
const issuer="https://real-chrome-test.cloudflareaccess.com";
const audience="separate-browser-dev-test";
const keyPair=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=keyPair.publicKey.export({format:"jwk"});
const provider={issuer,get:async()=>({keys:[{...jwk,kid:"chrome-access-key",use:"sig",alg:"RS256"}]})};
function jwt(){
  const now=Math.floor(Date.now()/1000);
  const encoded=data=>Buffer.from(JSON.stringify(data)).toString("base64url");
  const head=encoded({alg:"RS256",kid:"chrome-access-key"});
  const claims=encoded({iss:issuer,aud:audience,sub:"owner",iat:now-5,exp:now+300});
  const input=head+"."+claims;
  return input+"."+sign("RSA-SHA256",Buffer.from(input),keyPair.privateKey).toString("base64url");
}
async function fixture(){
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");
    res.setHeader("Cache-Control","no-store");
    if(url.pathname.startsWith("/api/")){
      res.setHeader("Content-Type","application/json");
      res.end(JSON.stringify(url.pathname==="/api/youtube/search"?
        {items:[{id:"dQw4w9WgXcQ",title:"Safe test",channelTitle:"Fixture channel",duration:120}]}:
        url.pathname==="/api/playlists"||url.pathname==="/api/watch-history"?[]:
        url.pathname==="/api/sessions"?{counts:{browserSessions:0,realChromeSessions:0},
          browserSessions:[],realChromeSessions:[]}:{ok:true}));
      return;
    }
    const name=url.pathname==="/"?"/index.html":url.pathname;
    const file=path.resolve(publicDir,"."+name);
    if(!file.startsWith(publicDir+path.sep)){res.writeHead(403).end();return;}
    try{
      const data=await fs.readFile(file);
      const ext=path.extname(file);
      res.setHeader("Content-Type",({".html":"text/html",".js":"text/javascript",
        ".css":"text/css",".svg":"image/svg+xml",".png":"image/png"})[ext]||"application/octet-stream");
      res.end(data);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {origin:"http://127.0.0.1:"+server.address().port,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
async function mcp(gateway,name,args,token){
  const res=await fetch(gateway.origin+"/remote/mcp",{method:"POST",
    headers:{accept:"application/json, text/event-stream","content-type":"application/json",
      "Cf-Access-Jwt-Assertion":token,"x-ai-request-id":randomUUID()},
    body:JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:"tools/call",
      params:{name,arguments:args}})});
  assert.equal(res.status,200);
  return (await res.json()).result.structuredContent;
}
test("REAL Chrome HttpOnly signed cookie registers target; trusted click grants scoped MCP pause and state",
  {timeout:120000},async()=>{
    const site=await fixture();
    const trusted=new TrustedBrowserRegistrationFlow({jwksProvider:provider,
      allowedOrigins:[site.origin],allowedSubjects:["owner"],audience});
    const relay=await startTrustedAccessBrowserRelay({trustedBrowserFlow:trusted,ttlMs:10000});
    const gateway=await startLocalRemoteMcpGateway({relay,jwksProvider:provider,audience,allowedSubjects:["owner"]});
    let browser;
    const token=jwt();
    try{
      browser=await chromium.launch({channel:"chrome",headless:true,
        args:["--no-first-run","--no-default-browser-check"]});
      const context=await browser.newContext();
      await context.addCookies([{name:"CF_Authorization",value:token,
        url:site.origin,httpOnly:true,sameSite:"Lax"}]);
      const page=await context.newPage();
      await page.goto(site.origin+"/?ai_agent_dev=1&ai_agent_trusted_dev=1&trusted_relay_port="+
        new URL(relay.origin).port,{waitUntil:"load"});
      await page.waitForFunction(()=>Boolean(window.YTStreamerMediaAgent));
      await page.addScriptTag({url:site.origin+"/ai-media-agent-trusted-dev.js"});
      await page.locator("#aiAccessDevConnect").click();
      await page.waitForFunction(()=>document.querySelector("#aiAccessDevStatus")?.textContent.includes("Signed browser paired"));
      assert.equal(await page.evaluate(()=>document.cookie.includes("CF_Authorization")),false,
        "JWT cookie stays HttpOnly and invisible to browser JS");
      const devices=await mcp(gateway,"list_devices",{},token);
      assert.equal(devices.devices.length,1);
      const device=devices.devices[0].device_id;
      const request=await mcp(gateway,"request_browser_approval",
        {device_id:device,actions:["get_player_state","pause"]},token);
      assert.equal(request.status,"pending_browser_approval");
      await page.locator("#aiAccessDevApprove").waitFor();
      assert.equal((await mcp(gateway,"claim_browser_approval",
        {request_id:request.request_id},token)).status,"pending_browser_approval");
      await page.locator("#aiAccessDevApprove").click(); // real Chrome trusted gesture
      let grant;
      for(let i=0;i<20;i++){
        grant=await mcp(gateway,"claim_browser_approval",{request_id:request.request_id},token);
        if(grant.status==="approved")break;
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      assert.equal(grant.status,"approved");
      const state=await mcp(gateway,"get_player_state",
        {device_id:device,approval_id:grant.approval_id},token);
      assert.equal(state.status,"completed");
      assert.equal((await mcp(gateway,"next",
        {device_id:device,approval_id:grant.approval_id},token)).status,"unauthorized");
      await page.evaluate(()=>{
        replayFn=()=>{};
        document.querySelector("#screen").classList.add("playing","mjpeg-mode");
        document.querySelector("#pauseBtn").disabled=false;
      });
      const pause=await mcp(gateway,"pause",
        {device_id:device,approval_id:grant.approval_id},token);
      assert.equal(pause.status,"completed");
      assert.equal(await page.evaluate(()=>playbackPaused),true);
      await page.close();
      assert.equal((await mcp(gateway,"get_player_state",
        {device_id:device,approval_id:grant.approval_id},token)).status,"unauthorized");
    }finally{
      await browser?.close();await gateway.close();await relay.close();await site.close();
    }
  });
