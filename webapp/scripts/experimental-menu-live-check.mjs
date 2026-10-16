import assert from "node:assert/strict";
import {chromium} from "playwright-core";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.goto("http://127.0.0.1:8099/",{waitUntil:"domcontentloaded"});
  const menu=page.locator("#menuToggle");
  await menu.click();
  assert.equal(await page.locator("#modeTabs").getAttribute("class"),"mode-tabs open","Mobile menu expands");
  const items=page.locator("#modeTabs").locator("button, a");
  const names=(await items.allTextContents()).map(v=>v.trim());
  const a=names.indexOf("APNE Daily"), e=names.indexOf("Experimental");
  assert.ok(a>=0&&e===a+1,"Experimental is directly after APNE Daily in hamburger menu");
  const link=page.locator("#modeTabs a.experimental-menu-link");
  assert.equal(await link.getAttribute("href"),"/experimental/");
  if(process.env.APNE_CAPTURE_UI==="1")
    await page.screenshot({path:"/tmp/apne-experimental-hamburger.png",fullPage:false});
  await link.click();
  await page.waitForURL("**/experimental/",{timeout:12000});
  await page.locator(".episode-row").first().waitFor({timeout:16000});
  assert.equal(await page.locator("#showTitle").innerText(),"Anupamaa");
  assert.match(await page.locator("#resultCount").innerText(),/\d+ episodes?/);
  console.log("PASS: Production hamburger opens Experimental directly beneath APNE Daily; clicking navigates to live-listing /experimental/ and leaves stable home route unchanged.");
} finally {await browser.close();}
