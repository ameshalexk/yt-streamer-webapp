// Offline-only smoke: start a static fixture server, intercept API requests,
// and exercise the Anupamaa mobile date browser without production data.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const mime = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".webmanifest":"application/manifest+json", ".png":"image/png", ".json":"application/json" };
const fixture = {
  today:"2026-10-16", shows: [
    {id:"anupamaa",name:"Anupamaa",status:"Available",detail:"16 October 2026",
      episode:{dateKey:"2026-10-16",dateLabel:"16 October 2026",episodeNumber:1423},
      recentEpisodes: [
        {dateKey:"2026-10-16",dateLabel:"16 October 2026",status:"Available",sourceMode:"embed",episodeNumber:1423},
        {dateKey:"2026-10-15",dateLabel:"15 October 2026",status:"Saved",itemId:"saved15",episodeNumber:1422},
        {dateKey:"2026-10-14",dateLabel:"14 October 2026",status:"Saved",itemId:"saved14",episodeNumber:1421},
      ],history:{months:3,pageSize:10,total:3}},
    {id:"seher",name:"seher",status:"Listed",detail:"16 October 2026",recentEpisodes:[]},
  ]
};
const server=createServer(async (req,res)=>{
  const url=new URL(req.url,"http://localhost");
  const file=path.resolve(publicDir, "."+(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(publicDir + path.sep) && file!==publicDir) {res.writeHead(403).end();return;}
  try {
    const content=await readFile(file);
    res.writeHead(200,{"content-type":mime[path.extname(file)]||"application/octet-stream"});
    res.end(content);
  } catch {res.writeHead(404).end("Not found");}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1,hasTouch:true});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/api/**",async route=>{
    const u=new URL(route.request().url());
    let body = {};
    if (u.pathname==="/api/apne-daily") body=fixture;
    if (u.pathname==="/api/apne/progress") body={episodes:[{showId:"anupamaa",dateKey:"2026-10-14",completed:true,positionSeconds:1200,durationSeconds:1200}]};
    if (u.pathname==="/api/playlists") body={playlists:[]};
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  });
  await page.route("**/api/apne-daily/shows/**",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({status:"Listed"})}));
  await page.goto("http://127.0.0.1:"+port+"/?mode=apne",{waitUntil:"domcontentloaded",timeout:20000});
  try { await page.locator(".apne-mobile-tools").waitFor({timeout:8000}); }
  catch (error) { console.log("PAGE ERRORS",errors); console.log("PAGE DOM",await page.locator("body").innerText().then(s=>s.slice(0,1000))); console.log("STATUS",await page.evaluate(()=>({url:location.href,hasHelp:!!window.ApneMobileBrowser,hasApne:!!document.querySelector("#apneDailyView"),html:document.querySelector("#apneDailyList")?.innerHTML.slice(0,600),display:getComputedStyle(document.querySelector("#apneDailyView")).display}))); throw error; }
  const card=page.locator(".apne-mobile-featured");
  assert.equal(await card.locator(".apne-episode-tile").count(),3,"Initially lists all episodes");
  assert.equal(await card.locator(".apne-show-card").getAttribute("open"),"","Anupamaa opens on mobile");
  const display=await card.locator(".apne-episode-grid").evaluate(el=>getComputedStyle(el).gridTemplateColumns);
  assert.ok(display&&!display.includes("  "),"Mobile grid exists");
  await card.locator('[data-act="apne-date"][data-date-key="2026-10-15"]').click();
  assert.equal(await card.locator(".apne-episode-tile").count(),1,"Date jump filters list");
  assert.match(await card.locator(".apne-episode-tile").innerText(),/15 October/);
  await card.locator('[data-act="apne-date"][data-date-key=""]').click();
  await card.locator('[data-act="apne-unwatched"]').click();
  assert.equal(await card.locator(".apne-episode-tile").count(),2,"Watched episode hidden");
  await card.locator('[data-role="apne-sort"]').selectOption("oldest");
  assert.match(await card.locator(".apne-episode-tile").first().innerText(),/15 October/,"Oldest goes first");
  await card.locator('[data-role="apne-date-picker"]').fill("2026-10-14");
  assert.equal(await card.locator(".apne-episode-tile").count(),0,"Empty date + unwatched gives empty state");
  await card.locator('[data-act="apne-jump-latest"]').first().click();
  assert.equal(await card.locator(".apne-episode-tile").count(),3,"Jump latest resets filter");
  assert.equal(await page.locator(".apne-mobile-featured").count(),1);
  assert.equal(await page.locator('.apne-show-wrap[data-show-id="seher"].apne-mobile-featured').count(),0,"Other shows unchanged");
  assert.ok(!errors.some(e=>/ApneMobileBrowser|renderApneDaily|SyntaxError/.test(e)),errors.join("\n"));
  const width390=await card.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
  assert.ok(width390.scroll <= width390.client + 2, "Anupamaa must not overflow phone width");
  await page.setViewportSize({width:320,height:700});
  await page.reload();
  await page.locator(".apne-mobile-tools").waitFor();
  const width320=await page.locator(".apne-mobile-featured").evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
  assert.ok(width320.scroll <= width320.client + 2, "Anupamaa must fit 320px phones");
  await page.setViewportSize({width:850,height:900});
  await page.reload();
  await page.locator("#apneDailyList .apne-show-wrap").first().waitFor();
  assert.equal(await page.locator(".apne-mobile-featured").count(),0,"Desktop keeps existing UI");
  console.log("PASS: 320px/390px iPhone + 850px desktop fixture; date, sort, watched filter, reset; no overflow; other shows unchanged");
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
