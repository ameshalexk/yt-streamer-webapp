import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
const folder=path.resolve(import.meta.dirname,"../public/experimental");
const cache=path.join(os.homedir(),"Library/Application Support/YTStreamerWebapp/data/apne-thumbs-live/anupamaa/2026-10-16-v1.jpg");
const base="http://127.0.0.1:8099/experimental/";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try {
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[],writes=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("request",r=>{if(!["GET","HEAD","OPTIONS"].includes(r.method()))writes.push(r.method()+" "+r.url());});
  // Mount candidate assets into test browser without changing production files.
  await page.route("**/experimental/**",async route=>{
    const filename=new URL(route.request().url()).pathname.split("/").pop()||"index.html";
    if(!["index.html","app.js","apne-mobile-browser.js","styles.css"].includes(filename))return route.abort();
    const f=path.join(folder,filename);
    await route.fulfill({status:200,body:await fs.readFile(f),contentType:filename.endsWith(".js")?"text/javascript":filename.endsWith(".css")?"text/css":"text/html"});
  });
  await page.route("**/apne/live-thumb/anupamaa/2026-10-16.jpg",async route=>{
    await route.fulfill({status:200,body:await fs.readFile(cache),contentType:"image/jpeg"});
  });
  await page.goto(base,{waitUntil:"domcontentloaded",timeout:15000});
  await page.locator(".episode-row").first().waitFor({timeout:30000});
  const shows=await page.locator(".show-choice").count();
  assert.ok(shows>=8,"8 APNE shows");
  assert.equal(await page.locator(".episode-row").count(),10);
  assert.equal(await page.locator(".date-scroller").count(),0);
  assert.equal(await page.locator("#calendarPanel").evaluate(x=>x.open),false);
  assert.equal(await page.locator("#pageInfo").innerText(),"1–10 of 24");
  await page.waitForFunction(()=>document.querySelector('[data-preview-date="2026-10-16"] img'),{timeout:10000});
  assert.equal(await page.locator('[data-preview-date="2026-10-16"] img').first().evaluate(x=>x.naturalWidth>0),true);
  // Horizontal finger gestures page ten at a time without affecting vertical scroll.
  await page.evaluate(()=>{
    const el=document.querySelector("#episodeList");
    const emit=(type,x,mode)=>{
      const touch=new Touch({identifier:1,target:el,clientX:x,clientY:300});
      el.dispatchEvent(new TouchEvent(type,{bubbles:true,changedTouches:[touch],touches:mode?[touch]:[]}));
    };
    emit("touchstart",300,true);
    emit("touchend",100,false);
  });
  assert.equal(await page.locator("#pageInfo").innerText(),"11–20 of 24");
  await page.evaluate(()=>{
    const el=document.querySelector("#episodeList");
    const emit=(type,x,mode)=>{
      const touch=new Touch({identifier:1,target:el,clientX:x,clientY:300});
      el.dispatchEvent(new TouchEvent(type,{bubbles:true,changedTouches:[touch],touches:mode?[touch]:[]}));
    };
    emit("touchstart",100,true);
    emit("touchend",300,false);
  });
  assert.equal(await page.locator("#pageInfo").innerText(),"1–10 of 24");
  await page.locator("#pagerTop [data-page-move='older']").click();
  assert.equal(await page.locator(".episode-row").count(),10);
  assert.equal(await page.locator("#pageInfo").innerText(),"11–20 of 24");
  await page.locator("#pagerTop [data-page-move='older']").click();
  assert.equal(await page.locator(".episode-row").count(),4);
  assert.equal(await page.locator("#pageInfo").innerText(),"21–24 of 24");
  await page.locator("#calendarPanel summary").click();
  assert.equal(await page.locator("#calendarPanel").evaluate(x=>x.open),true);
  await page.locator("#episodeDate").fill("2026-10-06");
  assert.equal(await page.locator(".episode-row").count(),1,"Exact day filter finds one");
  assert.match(await page.locator(".episode-row").first().innerText(),/6 October 2026/);
  assert.equal(await page.locator("#calendarPanel").evaluate(x=>x.open),false,"Calendar collapses on filter");
  assert.equal(await page.locator("#calendarActive").isVisible(),true);
  assert.equal(await page.locator("#pageInfo").isVisible(),false,"No paging for one episode");
  assert.equal(await page.locator("#quickStart").isVisible(),false,"Latest-episode card hidden in date mode");
  assert.equal(await page.locator("#archiveNotice").isVisible(),false,"No archive warning in date mode");
  await page.locator("#exitCalendar").click();
  assert.equal(await page.locator(".episode-row").count(),10,"Clear restores normal page");
  assert.equal(await page.locator("#pageInfo").innerText(),"1–10 of 24");
  assert.equal(await page.locator("#calendarActive").isVisible(),false);
  assert.equal(await page.locator("#episodeDate").inputValue(),"");
  assert.equal(await page.locator("#quickStart").isVisible(),true);

  await page.locator('[data-show-id="108-base-hospital-uri"]').click();
  assert.equal(await page.locator(".episode-row").count(),6);
  await page.locator("#calendarPanel summary").click();
  await page.locator("#episodeDate").fill("2026-09-25");
  assert.equal(await page.locator(".episode-row").count(),0,"No nearest-date substitution");
  assert.match(await page.locator("#episodeList").innerText(),/No episodes listed for 25 September 2026/);
  await page.locator("#exitCalendar").click();
  assert.equal(await page.locator(".episode-row").count(),6,"Restore after zero results");

  await page.locator('[data-show-id="shayad-yahi-hai-pyaar"]').click();
  assert.equal(await page.locator(".episode-row").count(),10);
  assert.equal(await page.locator("#pageInfo").innerText(),"1–10 of 15");
  await page.locator("#calendarPanel summary").click();
  await page.locator("#episodeDate").fill("2026-10-12");
  assert.equal(await page.locator("#resultCount").innerText(),"5 episodes","Shows five actual same-day numbered episodes");
  assert.equal(await page.locator(".episode-row").count(),5);
  assert.ok(await page.locator(".episode-row").first().innerText().then(t=>t.includes("12 October 2026")));
  assert.equal(await page.locator("#pagerTop").isVisible(),false);
  assert.equal(await page.locator("#calendarActive").isVisible(),true);
  assert.equal(await page.locator("#episodeDate").inputValue(),"2026-10-12");
  await page.locator("#exitCalendar").click();
  assert.equal(await page.locator("#pageInfo").innerText(),"1–10 of 15");
  assert.equal(await page.locator("#calendarActive").isVisible(),false);
  for(const width of [320,360,390,430,850]){
    await page.setViewportSize({width,height:844});
    const sizes=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(sizes.scroll<=sizes.client+2,"No horizontal clipping at "+width+" "+JSON.stringify(sizes));
  }
  // Synthetic same-day archive test: verify selected-date pagination also
  // preserves calendar mode when >10 numbered episodes share one air date.
  const fakeEpisodes=Array.from({length:13},(_,i)=>({
    dateKey:"2026-10-12-e"+(13-i),
    airDateKey:"2026-10-12",
    episodeNumber:13-i,
    status:"Listed",
  }));
  await page.route("**/api/apne-daily",route=>route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({shows:[{id:"anupamaa",name:"Anupamaa",status:"Listed",
      episode:fakeEpisodes[0],recentEpisodes:fakeEpisodes}]}),
  }));
  await page.goto(base,{waitUntil:"domcontentloaded"});
  await page.locator(".episode-row").first().waitFor({timeout:12000});
  await page.locator("#calendarPanel summary").click();
  await page.locator("#episodeDate").fill("2026-10-12");
  assert.equal(await page.locator("#resultCount").innerText(),"13 episodes");
  assert.equal(await page.locator(".episode-row").count(),10);
  await page.locator("#pagerTop [data-page-move='older']").click();
  assert.equal(await page.locator(".episode-row").count(),3);
  assert.equal(await page.locator("#pageInfo").innerText(),"11–13 of 13");
  assert.equal(await page.locator("#calendarActive").isVisible(),true);
  assert.equal(await page.locator("#episodeDate").inputValue(),"2026-10-12");
  await page.locator("#exitCalendar").click();
  assert.equal(await page.locator("#pageInfo").innerText(),"1–10 of 13");
  assert.equal(await page.locator("#calendarActive").isVisible(),false);

  assert.deepEqual(errors,[]);
  assert.deepEqual(writes,[]);
  console.log("PASS: real show catalog, 10/page Older/Newer, exact-date filter and clear, show switch, cached JPEG displayed, widths 320–850px, GET-only");
}finally{await browser.close();}
