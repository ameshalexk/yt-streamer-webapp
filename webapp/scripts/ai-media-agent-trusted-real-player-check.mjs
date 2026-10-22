// Unified signed WS and real player smoke, local only. No production effects.
// Real Google Chrome coverage for the opt-in browser adapter and the existing
// YT Streamer player. Search results and media bytes are deterministic fixtures;
// all commands, pairing, state readback, and player rendering use real pages.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {startLocalRemoteMcpGateway} from "./ai-agent-remote-mcp.mjs";
import {startTrustedAccessBrowserRelay} from "./ai-agent-trusted-access-relay.mjs";
import {TrustedBrowserRegistrationFlow} from "../src/lib/ai-media-agent-trusted-browser-flow.js";
import {generateKeyPairSync,sign,randomUUID} from "node:crypto";

const WEBAPP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(WEBAPP_DIR, "src", "server.js");
const LIVE_YOUTUBE = false;
const CHROME = process.env.MOBILE_TEST_CHROME || process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const FIXTURE = {
  id: "jNQXAC9IVRw",
  title: "AI Media Agent Browser Test Fixture",
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  duration: 45,
  channelTitle: "Local fixture",
  thumbnail: null,
  isLive: false,
  isUpcoming: false,
};
const LEGACY_FIXTURE = {
  id: "L1VE0000001",
  title: "AI Media Agent Live MJPEG Fixture",
  url: "https://www.youtube.com/watch?v=L1VE0000001",
  duration: null,
  channelTitle: "Local fixture",
  thumbnail: null,
  isLive: true,
  isUpcoming: false,
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function makeVideoFixture() {
  const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=royalblue:s=320x180:r=1", "-frames:v", "1", "-q:v", "7", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { timeout: 12000, maxBuffer: 1000000 });
  assert.equal(result.status, 0, result.stderr?.toString() || "ffmpeg fixture generation failed");
  return result.stdout;
}

function makeAudioFixture() {
  const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "45", "-vn", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"], { timeout: 15000, maxBuffer: 3000000 });
  assert.equal(result.status, 0, result.stderr?.toString() || "ffmpeg audio fixture generation failed");
  return result.stdout;
}

function multipartFixture(jpeg, frames = 540) {
  const boundary = "aiagentphase1";
  const partHeader = Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  const parts = [];
  for (let index = 0; index < frames; index += 1) parts.push(partHeader, jpeg, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function launchServer(port, dirs) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dirs.data,
    LIBRARY_DIR: dirs.library,
    APNE_ICLOUD_DIR: dirs.apne,
    YOUTUBE_OAUTH_TOKEN_FILE: path.join(dirs.data, "oauth.json"),
    REAL_CHROME_PROFILE_DIR: path.join(dirs.data, "real-chrome-profile"),
    CATALOG_COUNTRIES_URL: "http://127.0.0.1:1/disabled",
    CATALOG_COUNTRY_PLAYLIST_BASE_URL: "http://127.0.0.1:1/disabled",
  };
  delete env.XPC_SERVICE_NAME;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: WEBAPP_DIR, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  return { child, get stderr() { return stderr; } };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

async function waitForServer(server, origin) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`webapp exited before ready: ${server.stderr}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`webapp startup timed out: ${server.stderr}`);
}

const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const issuer="https://phase3-render.cloudflareaccess.com";
const audience="yt-trusted-real-renderer";
const jwk=publicKey.export({format:"jwk"});
const jwks={issuer,get:async()=>({keys:[{...jwk,kid:"phase3-render-key",use:"sig",alg:"RS256"}]})};
const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(){
  const at=Math.floor(Date.now()/1000),head=encode({kid:"phase3-render-key",alg:"RS256"});
  const body=encode({sub:"owner",aud:audience,iss:issuer,iat:at-10,exp:at+300});
  return head+"."+body+"."+sign("RSA-SHA256",Buffer.from(head+"."+body),privateKey).toString("base64url");
}
async function mcp(gateway,access,action,args){
  const res=await fetch(gateway.origin+"/remote/mcp",{
    method:"POST",
    headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
      "cf-access-jwt-assertion":access,"x-ai-request-id":randomUUID()},
    body:JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:"tools/call",
      params:{name:action,arguments:args}})
  });
  const json=await res.json();
  assert.equal(res.status,200,action+" "+JSON.stringify(json));
  return json.result.structuredContent;
}
const root=await fs.mkdtemp(path.join(os.tmpdir(),"yt-ai-agent-trusted-render-"));
const dirs={data:path.join(root,"data"),library:path.join(root,"library"),apne:path.join(root,"apne")};
await Promise.all(Object.values(dirs).map(dir=>fs.mkdir(dir,{recursive:true})));
let server,relay,gateway,browser;
try {
  const jpeg=makeVideoFixture(),mp3=makeAudioFixture(),multipart=multipartFixture(jpeg);
  const port=await freePort(),origin="http://127.0.0.1:"+port;
  server=launchServer(port,dirs);
  await waitForServer(server,origin);
  const access=jwt();
  const trusted=new TrustedBrowserRegistrationFlow({
    jwksProvider:jwks,audience,allowedSubjects:["owner"],allowedOrigins:[origin]
  });
  relay=await startTrustedAccessBrowserRelay({
    trustedBrowserFlow:trusted,ttlMs:10000,timeoutMs:3500
  });
  gateway=await startLocalRemoteMcpGateway({
    relay,jwksProvider:jwks,audience,allowedSubjects:["owner"]
  });
  browser=await chromium.launch({executablePath:CHROME,headless:true,
    args:["--no-sandbox","--autoplay-policy=no-user-gesture-required"]});
  const context=await browser.newContext({viewport:{width:390,height:844},
    isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await context.addCookies([{
    name:"CF_Authorization",value:access,domain:"127.0.0.1",path:"/",
    httpOnly:true,secure:false,sameSite:"Lax"
  }]);
  let audioRequests=0;
  async function targetPage(mode){
    const page=await context.newPage();
    await page.route("**/api/youtube/search**",route=>route.fulfill({
      status:200,contentType:"application/json",body:JSON.stringify({
        query:"phase3 secure test",items:[FIXTURE]
      })
    }));
    await page.route("**/stream/youtube**",route=>route.fulfill({
      status:200,headers:{"content-type":"multipart/x-mixed-replace; boundary="+multipart.boundary,
        "x-mjpeg-fps":"12","cache-control":"no-store"},body:multipart.body
    }));
    await page.route("**/stream/audio/youtube**",route=>{
      audioRequests++;
      return route.fulfill({status:200,headers:{"content-type":"audio/mpeg",
        "cache-control":"no-store"},body:mp3});
    });
    await page.goto(origin+"/?ai_agent_trusted_dev=1&ui="+mode,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>typeof globalThis.YTStreamerMediaAgent?.execute==="function",null,{timeout:10000});
    if(mode==="new")await page.waitForFunction(()=>document.documentElement.dataset.ui==="new",null,{timeout:10000});
    await page.locator("#aiAgentTrustedPort").fill(new URL(relay.origin).port);
    await page.locator("#aiAgentTrustedConnect").click();
    await page.waitForFunction(()=>document.querySelector("#aiAgentTrustedStatus")
      ?.textContent?.includes("Authenticated browser paired:"),null,{timeout:10000});
    return page;
  }
  const selected=await targetPage("classic"),decoy=await targetPage("classic");
  const devices=(await mcp(gateway,access,"list_devices",{})).devices;
  assert.equal(devices.length,2);
  const target=devices[0].device_id,other=devices[1].device_id;
  const actions=["search_media","play_media","pause","resume","stop","get_player_state"];
  const request=await mcp(gateway,access,"request_browser_approval",{
    device_id:target,actions
  });
  assert.equal(request.status,"pending_browser_approval");
  await selected.locator("#aiAgentTrustedRequests [data-ai-action=approve]").click();
  const claimed=await mcp(gateway,access,"claim_browser_approval",{request_id:request.request_id});
  assert.equal(claimed.status,"approved");
  const scoped={device_id:target,approval_id:claimed.approval_id};
  const search=await mcp(gateway,access,"search_media",{...scoped,
    query:"phase3 secure test",limit:5});
  assert.equal(search.status,"completed");
  assert.equal(search.result.results[0].media_id,FIXTURE.id);
  assert.equal((await mcp(gateway,access,"play_media",{
    ...scoped,media_id:FIXTURE.id
  })).status,"accepted");
  async function observe(expected,timeout=20000){
    const deadline=Date.now()+timeout;
    let state;
    while(Date.now()<deadline){
      state=(await mcp(gateway,access,"get_player_state",scoped)).state;
      if(state?.playback_phase===expected)return state;
      await new Promise(resolve=>setTimeout(resolve,900));
    }
    throw Error("Expected "+expected+"; got "+JSON.stringify(state));
  }
  const playing=await observe("playing",25000);
  assert.equal(playing.media_id,FIXTURE.id);
  assert.ok(playing.rendered_frames>=1,"real video frames must render");
  const startFrames=playing.rendered_frames;
  assert.equal((await mcp(gateway,access,"pause",scoped)).status,"completed");
  const paused=await observe("paused",6000);
  assert.equal(paused.paused,true);
  assert.ok(["accepted","completed"].includes((await mcp(gateway,access,"resume",scoped)).status));
  const resumed=await observe("playing",20000);
  assert.ok(resumed.rendered_frames>startFrames,
    "resume must produce NEW rendered frame evidence");
  assert.equal((await mcp(gateway,access,"stop",scoped)).status,"completed");
  assert.equal((await observe("idle",6000)).playback_phase,"idle");
  const decoyState=await decoy.evaluate(()=>YTStreamerMediaAgent.get_player_state());
  assert.equal(decoyState.playback_phase,"idle");
  const cross=await mcp(gateway,access,"pause",{
    device_id:other,approval_id:claimed.approval_id
  });
  assert.equal(cross.status,"unauthorized");
  await selected.locator("#aiAgentTrustedDisconnect").click();
  const revoked=await mcp(gateway,access,"pause",scoped);
  assert.equal(revoked.status,"unauthorized");
  console.log(JSON.stringify({
    result:"PASS",browser:await browser.version(),media:"real YT Streamer buffered MJPEG renderer with deterministic local JPEG+MP3",
    security:"signed JWT cookie + real trusted click + selected-tab authorization and disconnect revoke",
    playback:["search","playing frames","paused","resumed with increased frame count","stopped"],
    renderedAtPlay:startFrames,renderedAfterResume:resumed.rendered_frames,
    audioFixtureRequests:audioRequests,decoy:"idle"
  },null,2));
  await context.close();
}finally{
  await browser?.close().catch(()=>{});
  await gateway?.close().catch(()=>{});
  await relay?.close().catch(()=>{});
  await stopServer(server);
  await fs.rm(root,{recursive:true,force:true});
}
