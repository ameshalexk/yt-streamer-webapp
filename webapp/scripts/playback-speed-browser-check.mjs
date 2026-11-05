#!/usr/bin/env node
// Isolated Chrome regression for the app's Cyberdash speed-change path.
// Creates a local FFmpeg DASH fixture and mocks only session API responses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCyberdashDashArgs, parseDashManifest } from "../src/lib/cyberdash-dash.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(app, "public");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "yt-speed-check-"));
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const chromePath = process.env.MOBILE_TEST_CHROME || process.env.PLAYBACK_SPEED_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const source = path.join(temp,"source.mp4");
const generated = spawnSync(ffmpeg, ["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=320x180:rate=15","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","18","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-g","15","-c:a","aac","-movflags","+faststart",source], { encoding:"utf8",timeout:30000 });
assert.equal(generated.status,0,generated.stderr);
const fixtureDirs=new Map();
for (const rate of [1,2]) { const dir=path.join(temp,`rate-${rate}`);await fs.mkdir(dir);const args=buildCyberdashDashArgs({videoInput:source,height:240,fps:15,playbackRate:rate,encoder:"libx264",initialBurstSupported:false,manifestPath:path.join(dir,"manifest.mpd")});
  // Synthetic fixture generation is offline, not a live read-rate test.
  // Remove the real-time input throttle while preserving production DASH parameters.
  const throttle=args.indexOf("-readrate");if(throttle>=0)args.splice(throttle,2);
  args.splice(args.indexOf("-c:v"),0,"-preset","ultrafast");
  const result=spawnSync(ffmpeg,args,{encoding:"utf8",timeout:45000});assert.equal(result.status,0,result.stderr);fixtureDirs.set(rate,dir); }
let starts = [], stoppedIds = [], mediaRequests = 0, server;
let nextSession = 0;
const sessionRates=new Map();
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".mpd": "application/dash+xml", ".m4s": "video/iso.segment" };
server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/api/experimental/cyberdash/start") {
    const body = JSON.parse(await new Promise(resolve => { let s=""; req.on("data",c=>s+=c); req.on("end",()=>resolve(s)); }));
    const id=`fixture-${++nextSession}`;
    const rate=Number(body.playbackRate)===2?2:1;
    if (rate===2) await new Promise(resolve=>setTimeout(resolve,1200));
    sessionRates.set(id,rate);
    starts.push({ id, at: Date.now(), playbackRate: body.playbackRate, startAt: body.startAt, height: body.height, fps: body.fps });
    res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ id, resolveMs:0 })); return;
  }
  const sessionMatch=u.pathname.match(/^\/api\/experimental\/cyberdash\/([^/]+)\/status$/);
  if (sessionMatch) {
    const id=sessionMatch[1], rate=sessionRates.get(id)||1,dir=fixtureDirs.get(rate),manifestText=await fs.readFile(path.join(dir,"manifest.mpd"),"utf8"),manifest=parseDashManifest(manifestText),files=await fs.readdir(dir);
    const video=files.filter(x=>x.startsWith(`chunk-${manifest.video.id}-`)).sort(), audio=files.filter(x=>x.startsWith(`chunk-${manifest.audio.id}-`)).sort();
    res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({manifestReady:true,manifest,init:{video:`init-${manifest.video.id}.m4s`,audio:`init-${manifest.audio.id}.m4s`},available:{video,audio},done:false})); return;
  }
  if (u.pathname.startsWith("/api/experimental/cyberdash/") && u.pathname.endsWith("/stop")) { stoppedIds.push(u.pathname.split("/").at(-2));res.writeHead(200,{"content-type":"application/json"});res.end('{"stopped":true}');return; }
  if (u.pathname.startsWith("/stream/experimental/cyberdash/fixture-")) {
    mediaRequests++;
    const id=u.pathname.split("/")[4],rate=sessionRates.get(id)||1,name=path.basename(u.pathname); try { const b=await fs.readFile(path.join(fixtureDirs.get(rate),name)); res.writeHead(200,{"content-type":name.endsWith("mpd")?"application/dash+xml":"video/iso.segment","cache-control":"no-store"});res.end(b); } catch {res.writeHead(404);res.end();} return;
  }
  if (u.pathname.startsWith("/api/")) { res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,playlists:[],items:[],sessions:[],data:[]}));return; }
  const rel=decodeURIComponent(u.pathname==="/"?"index.html":u.pathname.slice(1)), target=path.resolve(pub,rel);
  if (!target.startsWith(pub+path.sep)) {res.writeHead(403);res.end();return;}
  try { const b=await fs.readFile(target); res.writeHead(200,{"content-type":types[path.extname(target)]||"application/octet-stream","cache-control":"no-store"});res.end(b); } catch {res.writeHead(404);res.end();}
});
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const browser=await chromium.launch({executablePath:chromePath,headless:true,args:["--no-sandbox","--autoplay-policy=no-user-gesture-required"]});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}); page.on("pageerror",e=>console.error("PAGEERROR",e.stack||e.message)); page.on("requestfailed",r=>console.error("REQUESTFAILED",r.url(),r.failure()?.errorText)); page.on("console",m=>{if(m.type()==="error")console.error("CONSOLE",m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:"domcontentloaded"});
 await page.waitForFunction(()=>typeof playCyberdashStream==="function" && document.querySelector("#playbackSpeedSelect"),{timeout:12000});
 // Enter through the same application playback function used by production UI.
 await page.evaluate(()=>{ youtubePlaybackMethod="webcodecs"; renderYoutubePlaybackMethod(); resetStreamSettings(); activeYoutubeSourceUrl="https://fixture.invalid/video"; replayFn=(startAt=0)=>playCyberdashStream("https://fixture.invalid/video","Local FFmpeg fixture",{startAt,seekable:true,duration:18}); void playCyberdashStream("https://fixture.invalid/video","Local FFmpeg fixture",{seekable:true,duration:18}); });
 await page.waitForFunction(()=>cyberdashPlayer?.currentTime?.()>0 && !document.querySelector("#screen")?.classList.contains("loading"),{timeout:15000});
 const before=await page.evaluate(()=>({time:cyberdashPlayer?.currentTime?.(),badge:document.querySelector("#statusBadge")?.textContent}));
 const t0=Date.now();
 const twoXBaseline=await page.evaluate(()=>({attempt:streamAttempt,time:cyberdashPlayer.currentTime()}));
 await page.locator("#playbackSpeedSelect").selectOption("2");
 await page.waitForFunction(({attempt,time})=>streamAttempt>attempt && !document.querySelector("#screen")?.classList.contains("loading") && cyberdashPlayer?.currentTime?.()>time+0.1,twoXBaseline,{timeout:15000}).catch(async()=>{throw new Error(`2x did not reach first frame: ${JSON.stringify(await page.evaluate(()=>({attempt:streamAttempt,time:cyberdashPlayer?.currentTime?.(),screen:document.querySelector("#screen")?.className})))}, starts=${JSON.stringify(starts)}, media=${mediaRequests}`);});
 const after2=await page.evaluate(()=>cyberdashPlayer?.currentTime?.());
 await page.waitForTimeout(2000);
 const later2=await page.evaluate(()=>cyberdashPlayer?.currentTime?.());
 const elapsed=(Date.now()-t0)/1000;
 const lowRequest = page.waitForRequest(request => {
   if (!request.url().endsWith("/api/experimental/cyberdash/start")) return false;
   const body = request.postDataJSON();
   return body.playbackRate === 2 && body.height === 360;
 });
 // Drive the same transition that follows a confirmed Auto downgrade.
 await page.evaluate(() => {
   const decision = autoQualityController.switchTo("low", "rebuffer", performance.now());
   requestAutoQualityTier(decision, diagnosticsStats);
 });
 const lowSettings = (await lowRequest).postDataJSON();
 assert.equal(lowSettings.fps, 12, "Auto Low must reduce source FPS even at 2x");
 assert.ok(lowSettings.startAt >= later2 - 0.5, "Auto must keep the movie position");
 const oneXAttempt=await page.evaluate(()=>streamAttempt);
 await page.locator("#playbackSpeedSelect").selectOption("1");
 await page.waitForFunction(attempt=>streamAttempt>attempt && !document.querySelector("#screen")?.classList.contains("loading") && cyberdashPlayer?.currentTime?.()>0.2,oneXAttempt,{timeout:15000});
 await page.locator("#pauseBtn").click();
 await page.waitForTimeout(650);
 const pausedAt=await page.evaluate(()=>cyberdashPlayer?.currentTime?.());
 await page.waitForTimeout(450);
 const remainedPausedAt=await page.evaluate(()=>cyberdashPlayer?.currentTime?.());
 await page.locator("#pauseBtn").click();
 await page.waitForTimeout(900);
 const after1=await page.evaluate(()=>cyberdashPlayer?.currentTime?.());
 // Change 1x->2x->1x quickly while the 2x start response is delayed. Every
 // accepted server start, including a stale late response, must be stopped.
 await page.locator("#playbackSpeedSelect").selectOption("2"); await page.waitForTimeout(100); await page.locator("#playbackSpeedSelect").selectOption("1"); await page.waitForTimeout(2200);
 const evidence={ ffmpegFixture:"18s H.264/AAC source; DASH generated using production buildCyberdashDashArgs atempo=1x and 2x", mediaRequests, initialTime:before.time, initialBadge:before.badge, starts, stoppedIds, twoXSwitchWallSeconds:elapsed, timeAtTwoX:after2, laterAtTwoX:later2, twoXSourceAdvance:Number.isFinite(after2)&&Number.isFinite(later2)?later2-after2:null, pausedAt, remainedPausedAt, timeAfterReturnOneX:after1 };
 console.log(JSON.stringify(evidence,null,2));
 assert.ok(starts.some(x=>x.playbackRate===2 && x.height===480 && x.fps===15),"2x Auto Medium must request 480p at 15 source fps");
 assert.ok(starts.some(x=>x.playbackRate===1),"1x selection must restore normal session");
 assert.ok(Number.isFinite(later2),"Cyberdash must report progressing media time at 2x");
 assert.ok(later2-after2>2.5,"2x media clock should advance at approximately twice wall time after startup");
 assert.ok(Math.abs(remainedPausedAt-pausedAt)<0.2,"Pause must hold the media clock");
 assert.ok(starts.filter(x=>x.playbackRate===2).every(x=>stoppedIds.includes(x.id)),"All 2x server sessions, including a delayed stale start, must be stopped");
} finally { await browser.close(); await new Promise(ok=>server.close(ok)); await fs.rm(temp,{recursive:true,force:true}); }
