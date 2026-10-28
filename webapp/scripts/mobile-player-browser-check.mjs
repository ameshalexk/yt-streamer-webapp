// Local-only Chrome iPhone-size layout test; never contacts production.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const type={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://127.0.0.1");
 if(url.pathname.startsWith("/api/")){
  res.writeHead(200,{"content-type":"application/json"});
  if(url.pathname==="/api/playlists"){res.end("[]");return;}
  res.end(JSON.stringify({ok:true,playlists:[],items:[],sessions:[],data:[]}));
  return;
 }
 const wanted=url.pathname==="/" ? "/index.html" : decodeURIComponent(url.pathname);
 const full=path.resolve(root,"."+wanted);
 if(!full.startsWith(root+path.sep) && full!==root){res.writeHead(403);res.end();return;}
 try{
  const content=await fs.readFile(full);
  res.writeHead(200,{"content-type":type[path.extname(full)]||"application/octet-stream","cache-control":"no-store"});
  res.end(content);
 }catch {res.writeHead(404);res.end();}
});
const sockets=new Set();
server.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({
 executablePath:process.env.MOBILE_TEST_CHROME||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 headless:true,args:["--no-sandbox"]
});
const url="http://127.0.0.1:"+server.address().port+"/";
let passed=0;
try{
 for(const [width,height] of [[320,568],[375,812],[390,844],[430,932],[768,1024],[844,390]]){
  for(const style of ["classic","new"]){
   const page=await browser.newPage({
    viewport:{width,height},deviceScaleFactor:3,isMobile:true,hasTouch:true,
    userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
   });
   await page.goto(url+"?ui="+style,{waitUntil:"domcontentloaded"});
   await page.waitForFunction(()=>typeof window.beginNewPlaybackQuality==="function" && typeof window.setMode==="function",{timeout:14000});
   if(width===320 && style==="classic"){
    const transitions=await page.evaluate(()=>{
     diagnosticsQualityReason="recovery";
     requestQualityProfile("low");
     const manualReason=playbackDiagnosticsSnapshot().qualityReason;
     resetStreamSettings({persist:false});
     diagnosticsQualityReason="recovery";
     const screen=document.querySelector("#screen");
     screen.classList.add("playing","browser-mode");
     setBrowserStreamActive(true);
     updatePlayerQualityAccess();
     const source=playbackDiagnosticsSnapshot();
     setBrowserStreamActive(false);
     screen.classList.remove("playing","browser-mode");
     diagnosticsError="playback-failed";
     diagnosticsMethod="mjpeg";
     updateBufferedMjpegDebug({queueSeconds:9,receiveFps:48,renderedFps:24,renderedFrames:24,receivedFrames:48});
     const lateCallback=playbackDiagnosticsSnapshot();
     diagnosticsError=null;diagnosticsMethod=null;diagnosticsQualityReason=null;diagnosticsStats=null;
     updateBufferedMjpegDebug(null);
     resetStreamSettings({persist:false});
     return {manualReason,sourceQuality:source.quality,sourceReason:source.qualityReason,
      sourceButton:document.querySelector("#playerQualityBtn").textContent,lateStats:lateCallback.stats};
    });
    assert.equal(transitions.manualReason,null,"manual profile selection should clear a prior automatic quality reason");
    assert.equal(transitions.sourceQuality,"source","browser-controlled playback should report source-managed quality");
    assert.equal(transitions.sourceReason,null,"browser-controlled playback should omit a stale automatic quality reason");
    assert.match(transitions.sourceButton,/Quality · Source/);
    assert.equal(transitions.lateStats,null,"late stats callback must not repopulate diagnostics after an error");
   }
   // The disclosure must start closed and expose a useful, URL-free idle report
   // when opened. Mock the browser clipboard API for this interaction.
   const diagnosticsIdle = await page.evaluate(()=>({
    exists:!!document.querySelector("#playbackDiagnostics"),
    open:document.querySelector("#playbackDiagnostics")?.open,
    copy:!!document.querySelector("#playbackDiagnosticsCopy")
   }));
   assert.ok(diagnosticsIdle.exists,style+" "+width+": diagnostics disclosure missing");
   assert.equal(diagnosticsIdle.open,false,style+" "+width+": diagnostics must start collapsed");
   await page.locator("#playbackDiagnostics > summary").click();
   await page.waitForFunction(()=>document.querySelector("#playbackDiagnosticsContent")?.textContent.includes("Status"));
   const diagnostics = await page.evaluate(()=>{
    const panel=document.querySelector("#playbackDiagnostics"), copy=document.querySelector("#playbackDiagnosticsCopy");
    const r=copy.getBoundingClientRect();
    return {open:panel.open,text:document.querySelector("#playbackDiagnosticsContent").innerText,
      copyWidth:r.width,copyHeight:r.height,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.ok(diagnostics.open,style+" "+width+": disclosure did not open");
   assert.match(diagnostics.text,/Status\s+Idle/i,style+" "+width+": idle status missing");
   assert.ok(diagnostics.copyWidth>=44 && diagnostics.copyHeight>=44,
     style+" "+width+": copy target under 44x44 "+JSON.stringify(diagnostics));
   assert.ok(diagnostics.overflow<=2,style+" "+width+": diagnostics overflow "+JSON.stringify(diagnostics));
   await page.evaluate(()=>{
    window.__copiedPlaybackReport="";
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__copiedPlaybackReport=text;}}});
   });
   await page.locator("#playbackDiagnosticsCopy").click();
   await page.waitForFunction(()=>document.querySelector("#playbackDiagnosticsCopyStatus")?.textContent.includes("copied"));
   const report=await page.evaluate(()=>window.__copiedPlaybackReport);
   assert.match(report,/Method: Unavailable[\s\S]*Status: Idle/);
   assert.ok(!/https?:\/\//i.test(report),style+" "+width+": copied report contains a URL");
   await page.locator("#playbackDiagnostics > summary").click();
   assert.equal(await page.locator("#playbackDiagnostics").evaluate(el=>el.open),false,
     style+" "+width+": disclosure did not close");
   await page.evaluate(()=>{
    window.setMode("recommended");
    document.querySelector("#recommendationsView").style.minHeight="1800px";
    document.querySelector("#recommendationsView").scrollIntoView({block:"end"});
    window.beginNewPlaybackQuality();
    document.querySelector("#nowPlaying").textContent="A video chosen from recommendations with a long title";
    document.querySelector("#screen").classList.add("playing","mjpeg-buffered-mode");
   });
   await page.waitForTimeout(300);
   const before=await page.evaluate(()=>{
    const screen=document.querySelector("#screen"), quality=document.querySelector("#playerQualityBtn"), r=screen.getBoundingClientRect();
    return {screenTop:r.top,screenWidth:r.width,screenVisible:r.bottom>0 && r.top<innerHeight,
     qualityVisible:getComputedStyle(quality).display!=="none"&&quality.getBoundingClientRect().width>0,
     docWidth:document.documentElement.scrollWidth,vw:innerWidth,
     overlayHasPresets:Boolean(document.querySelector("#videoControlsOverlay #playerQualityPresets"))};
   });
   assert.ok(before.screenTop >= -80 && before.screenTop < height * 0.55,
    style+" "+width+": didn't navigate to player after selecting a recommendation "+JSON.stringify(before));
   assert.ok(before.screenVisible,style+" "+width+": player not in viewport "+JSON.stringify(before));
   assert.ok(before.qualityVisible,style+" "+width+": quality button not visible");
   assert.ok(!before.overlayHasPresets,style+" "+width+": presets obscure video");
   assert.ok(before.docWidth<=before.vw+2,style+" "+width+": horizontal overflow "+JSON.stringify(before));
   const modeButtons = page.locator("#playerVideoModes [data-playback-method]");
   assert.equal(await modeButtons.count(), 3, style+" "+width+": missing visible video-mode buttons");
   assert.ok(await modeButtons.first().isVisible(),style+" "+width+": MJPEG hidden");
   assert.ok(await modeButtons.nth(1).isVisible(),style+" "+width+": WebCodecs hidden");
   assert.ok(await modeButtons.nth(2).isVisible(),style+" "+width+": JXL hidden");
   const modeHost = await page.locator("#playerVideoModes").evaluate(el=>({
     hidden:!el.getClientRects().length, top:el.getBoundingClientRect().top,
     inAccordion:!!el.closest(".watch-accordion"),
     width:el.getBoundingClientRect().width
   }));
   assert.ok(!modeHost.hidden && !modeHost.inAccordion && modeHost.width>0,
     style+" "+width+": playback-mode controls are hidden in accordion "+JSON.stringify(modeHost));
   await modeButtons.nth(1).click();
   assert.equal(await modeButtons.nth(1).getAttribute("aria-pressed"),"true",style+" "+width+": WebCodecs selection didn't apply");
   await modeButtons.first().click();
   assert.equal(await modeButtons.first().getAttribute("aria-pressed"),"true",style+" "+width+": MJPEG selection didn't apply");
   assert.equal(await page.locator("#playbackMethodToggle").isVisible(), true);
   await modeButtons.nth(2).click();
   assert.equal(await modeButtons.first().getAttribute("aria-pressed"),"true",
     style+" "+width+": failed JXL attempt changed the user's MJPEG mode");
   // Chrome 155+ must activate JXL when both genuine browser decoding and
   // server capability are positive. This is a UI/preflight test only; the
   // separate real-FFmpeg test validates actual transmitted frames.
   if (width === 390 && style === "classic") {
     await page.route("**/api/experimental/jxl", async route =>
       route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({available:true,reason:null})}));
     await modeButtons.nth(2).click();
     await page.waitForFunction(() => document.querySelector('[data-playback-method="jxl"]')?.getAttribute("aria-pressed") === "true", {timeout: 6000});
     assert.equal(await modeButtons.nth(2).getAttribute("aria-pressed"),"true",
       "Chrome 155 successful JXL preflight should activate opt-in JXL");
     await modeButtons.first().click();
     assert.equal(await modeButtons.first().getAttribute("aria-pressed"),"true",
       "Switch back to MJPEG after successful JXL preflight");
   }
   await page.locator("#playerQualityBtn").click();
   const after=await page.evaluate(()=>{
    const panel=document.querySelector("#playerQualityPanel");
    return {visible:!panel.hidden&&getComputedStyle(panel).display!=="none",
     count:panel.querySelectorAll("[data-stream-profile]").length,
     expanded:document.querySelector("#playerQualityBtn").getAttribute("aria-expanded"),
     overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.ok(after.visible,style+" "+width+": quality panel not visible");
   assert.equal(after.count,4);
   assert.equal(after.expanded,"true");
   assert.ok(after.overflow<=2,style+" "+width+": quality panel overflows");
   await page.locator("#playerQualityCloseBtn").click();
   assert.equal(await page.locator("#playerQualityPanel").isVisible(),false);
   for (const mode of ["browse","library","apne"]) {
     const metrics = await page.evaluate(mode => {
       window.setMode(mode);
       window.beginNewPlaybackQuality();
       const screen=document.querySelector("#screen");
       screen.classList.remove("playing");
       screen.classList.add("playing");
       return {mode,quality:document.querySelector("#playerQualityBtn").textContent};
     }, mode);
     await page.waitForTimeout(230);
     const visible = await page.locator("#screen").isVisible();
     assert.ok(visible, style+" "+width+": player invisible in "+mode);
     const top = await page.locator("#screen").evaluate(el => el.getBoundingClientRect().top);
     assert.ok(top>=-100 && top<height*.7, style+" "+width+": could not reveal from "+mode+" top="+top);
   }
   await page.evaluate(()=>{
     const screen=document.querySelector("#screen");
     screen.classList.add("browser-mode");
   });
   await page.waitForTimeout(50);
   assert.match(await page.locator("#playerQualityBtn").textContent(),/Source/);
   await page.locator("#playerQualityBtn").click();
   assert.equal(await page.locator("#playerQualitySlot").isVisible(),false);
   assert.match(await page.locator("#playerQualityContext").textContent(),/source manages its own resolution/i);
   await page.locator("#playerQualityCloseBtn").click();
   console.log("PASS "+style+" viewport "+width+"x"+height+": diagnostics and player responsive, quality accessible, no overflow");
   passed++;
   await page.close();
  }
 }
 console.log(passed+"/12 responsive scenarios passed.");
}finally{
 await browser.close();
 // Chromium can leave keep-alive requests open after its context closes;
 // stop accepting first, then destroy every remaining local fixture socket.
 const stopped=new Promise(resolve=>server.close(resolve));
 for(const socket of sockets) socket.destroy();
 server.closeAllConnections?.();
 await stopped;
}
