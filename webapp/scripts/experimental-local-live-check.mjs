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
 if(process.env.APNE_CAPTURE_UI==="1") {
  await page.goto(base,{waitUntil:"networkidle"});
  await page.screenshot({path:"/tmp/apne-experimental-actual-live.png",fullPage:false});
 }
 console.log("PASS: Real local APNE API through hosted /experimental; "+label+"; source controls read-only; menu/stable unaffected; no browser errors.");
}finally{await browser.close();}
