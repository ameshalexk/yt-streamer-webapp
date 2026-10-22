import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');
 if(u.pathname.startsWith('/api/')){
   res.writeHead(200,{'content-type':'application/json'});
   return res.end(JSON.stringify({ok:true,items:[],data:[],sessions:[]}));
 }
 const wanted=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
 const full=path.resolve(root,wanted);
 if(!full.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 try{const body=await fs.readFile(full);res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream','cache-control':'no-store'});res.end(body);}
 catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const local='http://127.0.0.1:'+server.address().port;
const origin='https://stream.ameshalex.com';
const browser=await chromium.launch({
 executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 headless:true,
 args:['--no-first-run','--no-default-browser-check']
});
let passed=0;
try{
 for(const [width,height,ui] of [
   [320,568,'classic'],[375,667,'classic'],[390,844,'classic'],
   [430,932,'new'],[768,1024,'new'],[1024,768,'classic'],
   [844,390,'new']
 ]){
  const ctx=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
  const page=await ctx.newPage();
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin)return route.abort();
   try{
    const body=await route.fetch({url:local+url.pathname+url.search,timeout:6500});
    await route.fulfill({response:body});
   }catch{
    try{await route.abort();}catch{/* navigation already settled */}
   }
  });
  await page.goto(origin+'/?ui='+ui,{waitUntil:'domcontentloaded',timeout:16000});
  await page.locator('#teslamonPet').waitFor({state:'attached',timeout:13000});
  await page.locator('#tmFace').click();
  if(await page.locator('#tmDevices').count())throw Error('remote_browser_selector_must_not_exist');
  if(!(await page.locator('.tm-self-target').innerText()).includes('this browser tab only'))
    throw Error('self_target_label_missing');
  const facade=await page.evaluate(()=>typeof globalThis.YTStreamerMediaAgent?.execute);
  if(facade!=='function')throw Error('current_page_player_facade_not_initialized');
  await page.locator('button[data-tm="get_playback_state"]').click();
  await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent?.includes('Player state:'),null,{timeout:7000});
  const reply=await page.locator('#tmState').innerText();
  if(!reply.includes('idle'))throw Error('unexpected_self_status '+reply);

  const dimensions=await page.evaluate(()=>{
   const pet=document.querySelector('#teslamonPet');
   const panel=pet.querySelector('#tmPanel');
   const box=panel.getBoundingClientRect();
   return {open:!panel.hidden,width:box.width,viewport:innerWidth,left:box.left,
    right:box.right,top:box.top,bottom:box.bottom,viewportHeight:innerHeight,
    scrollWidth:document.documentElement.scrollWidth,
    micButton:pet.querySelector('#tmMic')?.getBoundingClientRect().height};
  });
  if(!dimensions.open||dimensions.left < -1||
    dimensions.right>dimensions.viewport+1 ||
    dimensions.scrollWidth>dimensions.viewport+2 ||
    dimensions.micButton<44 || dimensions.top < -1 ||
    dimensions.bottom > dimensions.viewportHeight + 1)throw Error('bad_layout '+width+'x'+height+' '+ui+' '+JSON.stringify(dimensions));
  console.log('PASS',width+'x'+height,ui,JSON.stringify(dimensions));
  await ctx.close(); passed++;
 }
}finally{
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
if(passed!==7)process.exitCode=1;
