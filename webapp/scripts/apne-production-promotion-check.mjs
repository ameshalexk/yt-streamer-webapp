import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {chromium} from "playwright-core";
const root=path.resolve(import.meta.dirname,"../public");
const base=process.env.APNE_TEST_BASE||"http://127.0.0.1:8099";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[],writes=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("request",r=>{if(!["GET","HEAD","OPTIONS"].includes(r.method()))writes.push(r.method()+" "+r.url());});
  const staged=new Set(["/","/app.js","/index.html","/apne/","/apne/index.html",
    "/apne/app.js","/apne/styles.css","/apne/apne-mobile-browser.js"]);
  await page.route("**/*",async route=>{
    const request=route.request();
    const url=new URL(request.url());
    if(url.origin!==base||!staged.has(url.pathname))return route.continue();
    const file=url.pathname==="/"?path.join(root,"index.html"):path.join(root,url.pathname);
    const full=file.endsWith("/")?path.join(file,"index.html"):file;
    const type=full.endsWith(".js")?"text/javascript":full.endsWith(".css")?"text/css":"text/html";
    return route.fulfill({status:200,contentType:type,body:await fs.readFile(full)});
  });
  await page.goto(base+"/apne/",{waitUntil:"domcontentloaded"});
  await page.locator(".episode-row").first().waitFor({timeout:30000});
  assert.equal(await page.locator(".episode-row").count(),10);
  assert.equal(await page.locator(".show-choice").count(),8);
  assert.match(await page.title(),/APNE Stream/);
  assert.equal((await page.locator(".stage-label").innerText()).toLowerCase(),"apne daily");
  assert.equal(await page.locator(".banner").count(),0);
  const current=await page.locator(".episode-row").first().getAttribute("data-episode");
  const expected=base+"/apne/live/watch/anupamaa/"+encodeURIComponent(current);
  const image=page.locator(".episode-row .episode-art").first();
  assert.equal(await image.evaluate(e=>e.tagName),"A");
  assert.equal(await image.getAttribute("href"),new URL(expected).pathname);
  assert.ok(await page.locator("#latestPreview").getAttribute("href"));
  // Follow the real link; the protected player's HTML is asserted independently
  // without bypassing Cloudflare auth or attempting to stream/download media.
  await page.route("**/apne/live/watch/**",route=>route.fulfill({
    status:200,contentType:"text/html",
    body:"<!doctype html><title>APNE Player route</title><video id='apneLiveVideo'></video>"
  }));
  await image.click();
  await page.waitForURL(expected);
  assert.equal(await page.locator("#apneLiveVideo").count(),1);
  // Revisit /apne and check Calendar exact-day, no-results and exit.
  await page.goto(base+"/apne/",{waitUntil:"domcontentloaded"});
  await page.locator(".episode-row").first().waitFor();
  await page.locator("#calendarPanel summary").click();
  await page.locator("#episodeDate").fill("2026-10-06");
  assert.equal(await page.locator(".episode-row").count(),1);
  await page.locator("#exitCalendar").click();
  assert.equal(await page.locator(".episode-row").count(),10);
  await page.locator('[data-show-id="shayad-yahi-hai-pyaar"]').click();
  const multi=page.locator(".episode-row .episode-art").first();
  assert.match(await multi.getAttribute("href"),/\/2026-10-12-e15$/,"Numbered episode URL");
  await page.locator("#calendarPanel summary").click();
  await page.locator("#episodeDate").fill("2026-10-12");
  assert.equal(await page.locator(".episode-row").count(),5);
  await page.locator("#exitCalendar").click();
  assert.equal(await page.locator(".episode-row").count(),10);
  await page.setViewportSize({width:320,height:844});
  const widths=await page.evaluate(()=>({doc:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(widths.scroll<=widths.doc+2,"Mobile no horizontal clipping");

  await page.goto(base+"/?mode=apne",{waitUntil:"domcontentloaded"});
  await page.waitForURL(base+"/apne/",{timeout:20000});
  await page.locator(".episode-row").first().waitFor();
  await page.goto(base+"/",{waitUntil:"domcontentloaded"});
  await page.locator('#menuToggle').click();
  await page.locator('[data-mode="apne"]').click();
  await page.waitForURL(base+"/apne/",{timeout:20000});
  await page.locator(".episode-row").first().waitFor();
  await page.locator('a[href="/?mode=apne&classic=1"]').click();
  await page.waitForURL(base+"/?mode=apne&classic=1",{timeout:20000});
  await page.locator("#apneManageShowsBtn").waitFor({timeout:20000});
  assert.equal(await page.locator("#apneDailyView").isVisible(),true);
  assert.deepEqual(errors,[]);
  assert.deepEqual(writes,[]);
  console.log("PASS: production tab+bookmark redirects; 10/page all 8 shows; clickable actual player URL; multipart IDs; exact-day+clear; classic Manage Shows; mobile widths; no writes/errors");
} finally {await browser.close();}
