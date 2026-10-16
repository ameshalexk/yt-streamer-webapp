import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
const root=path.resolve("public");
const fixture={
  shows:[{id:"anupamaa",name:"Anupamaa",status:"Available",episode:{dateKey:"2026-10-16"},
    history:{months:3},recentEpisodes:Array.from({length:13},(_,i)=>({
      dateKey:"2026-10-"+String(16-i).padStart(2,"0"),status:i===1?"Saved":"Available",episodeNumber:1423-i
    }))},
    {id:"seher-hone-ko-hai",name:"Seher",status:"Listed",episode:{dateKey:"2026-10-16"},
      history:{months:3},recentEpisodes:[
        {dateKey:"2026-10-16",status:"Listed"},
        {dateKey:"2026-10-13",status:"Available"}]},
    {id:"shayad-yahi-hai-pyaar",name:"Shayad Yahi Hai Pyaar",status:"Listed",
      episode:{dateKey:"2026-10-12-e2"},history:{months:3},
      recentEpisodes:[{dateKey:"2026-10-12-e2",status:"Listed"},
        {dateKey:"2026-10-12-e1",status:"Listed"}]}
  ]
};
let wrote=false;
let previewHeads=0;
let previewGets=0;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1/");
  if(url.pathname==="/api/apne-daily"||url.pathname==="/api/apne/progress"){
    if(req.method!=="GET"){wrote=true;res.writeHead(405).end();return;}
    const body=url.pathname.endsWith("progress")?{episodes:[{showId:"anupamaa",dateKey:"2026-10-15",completed:true,durationSeconds:1200,positionSeconds:1200}]}:fixture;
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(body));return;
  }
  if(url.pathname.startsWith("/apne/live-thumb/")||url.pathname.startsWith("/apne/thumb/")){
    if(!["GET","HEAD"].includes(req.method)){wrote=true;res.writeHead(405).end();return;}
    if(req.method==="HEAD"){previewHeads++;res.writeHead(previewHeads===1?202:200).end();return;}
    previewGets++;
    const photo=await readFile(path.resolve(root,"icons/apple-touch-icon.png"));
    res.writeHead(200,{"content-type":"image/png"}).end(photo);return;
  }
  if(!["GET","HEAD"].includes(req.method)){wrote=true;res.writeHead(405).end();return;}
  const route=url.pathname==="/experimental/"?"/experimental/index.html":url.pathname;
  const file=path.resolve(root,"."+route);
  if(!file.startsWith(root+"/")){res.writeHead(403).end();return;}
  try{
    const bytes=await readFile(file);
    res.writeHead(200,{"content-type":file.endsWith(".css")?"text/css":file.endsWith(".js")?"text/javascript":"text/html"});
    res.end(bytes);
  }catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  const base="http://127.0.0.1:"+server.address().port+"/experimental/";
  await page.goto(base,{waitUntil:"networkidle"});
  assert.equal(await page.locator(".episode-row").count(),10,"Shows ten per page");
  assert.equal(await page.locator("#resultCount").innerText(),"13 episodes");
  assert.equal(await page.locator("#showTitle").innerText(),"Anupamaa");
  assert.equal(await page.locator(".show-choice").count(),3,"Lists all configured shows");
  await page.locator('[data-show-id="seher-hone-ko-hai"]').click();
  assert.equal(await page.locator("#showTitle").innerText(),"Seher");
  assert.equal(await page.locator("#resultCount").innerText(),"2 episodes");
  await page.locator('[data-show-id="shayad-yahi-hai-pyaar"]').click();
  assert.equal(await page.locator("#resultCount").innerText(),"2 episodes");
  await page.locator('[data-date="2026-10-12"]').click();
  assert.equal(await page.locator("#resultCount").innerText(),"2 episodes","Same-day multipart episodes filter by air date");
  await page.locator('[data-show-id="anupamaa"]').click();
  assert.equal(await page.locator("#resultCount").innerText(),"13 episodes");
  await page.locator("#older").click();
  assert.equal(await page.locator(".episode-row").count(),3,"Older page");
  await page.locator("#newer").click();
  await page.locator("[data-date='2026-10-15']").click();
  assert.equal(await page.locator(".episode-row").count(),1,"Recent date chip");
  assert.match(await page.locator(".episode-row").innerText(),/15 October/);
  await page.locator("#clearFilters").click();
  await page.locator("#unwatched").click();
  assert.equal(await page.locator("#resultCount").innerText(),"12 episodes","Exclude completed");
  await page.locator("#episodeOrder").selectOption("oldest");
  assert.match(await page.locator(".episode-row").first().innerText(),/4 October/);
  await page.locator("#episodeDate").fill("2026-10-15");
  assert.equal(await page.locator(".episode-row").count(),0,"Watched-only empty date state");
  await page.locator("#latestButton").click();
  assert.equal(await page.locator("#resultCount").innerText(),"13 episodes");
  await page.locator(".episode-row [data-detail]").first().click();
  assert.equal(await page.locator(".row-details:not([hidden])").count(),1);
  await page.locator(".episode-art.has-image").first().waitFor({timeout:10000});
  assert.ok(previewHeads>=2,"Preview worker polled existing thumbnail endpoint");
  assert.ok(previewGets>=1,"Generated preview image was fetched and displayed");
  assert.ok(!wrote,"Never wrote API data");
  assert.deepEqual(errors,[],"No browser errors");
  for(const width of [320,390,430,850]){
    await page.setViewportSize({width,height:844});
    const dim=await page.evaluate(()=>({w:document.documentElement.clientWidth,sw:document.documentElement.scrollWidth}));
    assert.ok(dim.sw<=dim.w+2,"No horizontal overflow at "+width+": "+JSON.stringify(dim));
  }
  await page.setViewportSize({width:390,height:844});
  await page.goto(base,{waitUntil:"networkidle"});
  if(process.env.APNE_CAPTURE_UI==="1") {
    await page.screenshot({path:"/tmp/apne-experimental-home.png",fullPage:false});
    await page.locator(".episode-row").first().scrollIntoViewIfNeeded();
    await page.screenshot({path:"/tmp/apne-experimental-episodes.png",fullPage:false});
  }
  console.log("PASS: All-show Experimental: date filtering incl multipart, preview generation/caching, pagination, sorting, filters, touch layout 320/390/430/850, read-only API");
} finally {
  await browser?.close();
  await new Promise(r=>server.close(r));
}
