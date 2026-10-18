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
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({
 executablePath:process.env.MOBILE_TEST_CHROME||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 headless:true,args:["--no-sandbox"]
});
const url="http://127.0.0.1:"+server.address().port+"/";
let passed=0;
try{
 for(const [width,height] of [[320,568],[375,812],[390,844],[430,932],[768,1024]]){
  for(const style of ["classic","new"]){
   const page=await browser.newPage({
    viewport:{width,height},deviceScaleFactor:3,isMobile:true,hasTouch:true,
    userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
   });
   await page.goto(url+"?ui="+style,{waitUntil:"domcontentloaded"});
   await page.waitForFunction(()=>typeof window.beginNewPlaybackQuality==="function" && typeof window.setMode==="function",{timeout:14000});
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
   console.log("PASS "+style+" iPhone "+width+"x"+height+": player visible, quality accessible, no overflow");
   passed++;
   await page.close();
  }
 }
 console.log(passed+"/10 responsive scenarios passed.");
}finally{
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
