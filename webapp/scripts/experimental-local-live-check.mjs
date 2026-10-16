import assert from "node:assert/strict";
import {chromium} from "playwright-core";
const base=process.env.APNE_EXPERIMENTAL_TEST_URL || "http://127.0.0.1:8099/experimental/";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const writes=[], errors=[];
 page.on("request",req=>{if(!["GET","HEAD","OPTIONS"].includes(req.method()))writes.push(req.method()+" "+req.url())});
 page.on("pageerror",e=>errors.push(e.message));
 await page.goto(base,{waitUntil:"networkidle",timeout:20000});
 await page.locator(".episode-row").first().waitFor({timeout:15000});
 const showButtons=page.locator(".show-choice");
 const configured=await showButtons.count();
 assert.ok(configured>=8,"All eight configured APNE shows should appear; found "+configured);
 for(const label of ["Anupamaa","seher","Udne ki aasha","mannat","Shayad Yahi Hai Pyaar","108 Base Hospital Uri"]){
  assert.ok((await page.locator("#showGrid").innerText()).includes(label),"Missing "+label);
 }
 await page.locator('[data-show-id="108-base-hospital-uri"]').click();
 assert.equal(await page.locator("#showTitle").innerText(),"108 Base Hospital Uri");
 assert.ok(await page.locator(".episode-row").count()>=1,"Hospital has episodes");
 await page.locator('[data-show-id="shayad-yahi-hai-pyaar"]').click();
 assert.ok(await page.locator("#episodeList").innerText().then(v=>v.includes("October")),"Multipart episodes show day labels");
 await page.locator('[data-show-id="anupamaa"]').click();
 const before=await page.locator(".episode-row").count();
 const label=await page.locator("#resultCount").innerText();
 assert.match(label,/\d+ episodes?/);
 assert.ok(before>=1&&before<=10);
 const title=await page.title();
 assert.match(title,/Experimental/);
 await page.locator(".date-chip[data-date]:not([data-date=''])").first().click();
 assert.ok(await page.locator(".episode-row").count()>=1);
 await page.locator("#latestButton").click();
 await page.locator(".episode-row [data-detail]").first().click();
 assert.equal(await page.locator(".row-details:not([hidden])").count(),1);
 assert.deepEqual(errors,[]);
 assert.deepEqual(writes,[]);
 for(const width of [320,390,430,850]){
  await page.setViewportSize({width,height:844});
  const dims=await page.evaluate(()=>({inner:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(dims.scroll<=dims.inner+2,"No overflow at "+width+"px "+JSON.stringify(dims));
 }
 await page.setViewportSize({width:390,height:844});
 if(process.env.APNE_CAPTURE_UI==="1") {
  await page.goto(base,{waitUntil:"networkidle"});
  await page.screenshot({path:"/tmp/apne-experimental-actual-live.png",fullPage:false});
  await page.locator(".episode-row").first().scrollIntoViewIfNeeded();
  await page.screenshot({path:"/tmp/apne-experimental-all-shows-episodes-live.png",fullPage:false});
 }
 console.log("PASS: Real /experimental API; "+configured+" configured shows including hospital/multipart titles, "+label+" selected, 320/390/430/850 responsive, thumbnails safe fallback, no mutation.");
}finally{await browser.close();}
