// Isolated Chrome fixtures: no production requests, login or device commands.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const evidence=path.resolve(root,'../docs/ai-controls-autohide-evidence-20261025');
await fs.mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
const types={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const results=[];
try{
 for(const [width,height] of [[320,568],[375,812],[390,844],[430,932],[768,1024],[844,390],[1440,900]]){
  for(const style of ['classic','new']){
   const context=await browser.newContext({viewport:{width,height},isMobile:width<1000,hasTouch:width<1000});
   const enabled=style==='classic';
   await context.addInitScript(enabled=>localStorage.setItem('ytStreamerAiMediaOptInV1',enabled?'1':'0'),enabled);
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://stream.ameshalex.com')return route.abort();
    if(url.pathname==='/api/playlists')return route.fulfill({status:200,contentType:'application/json',body:'[]'});
    if(url.pathname==='/api/ai-agent/bootstrap')return route.fulfill({status:401,contentType:'application/json',body:'{"error":"signed_access_required"}'});
    if(url.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"playlists":[],"items":[],"sessions":[],"data":[]}'});
    const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!file.startsWith(root+path.sep))return route.abort();
    try{await route.fulfill({status:200,contentType:types[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}
    catch{await route.fulfill({status:404,body:'not found'});}
   });
   const page=await context.newPage();await page.clock.install();
   await page.goto('https://stream.ameshalex.com/?ui='+style,{waitUntil:'domcontentloaded'});
   const panel=page.locator('#aiMediaProductionPanel'),reopen=page.locator('#aiMediaProductionReopen');
   await page.clock.pauseAt(await page.evaluate(()=>Date.now()+1000));
   await panel.dispatchEvent('pointerdown');
   assert.ok(await panel.isVisible());
   const metrics=await page.evaluate(()=>{
    const r=document.querySelector('#aiMediaProductionPanel').getBoundingClientRect();
    return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,panel:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},targets:['aiMediaProductionToggle','aiMediaProductionSignIn'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,width:r.width,height:r.height};})};
   });
   assert.ok(metrics.documentWidth<=width+2,JSON.stringify(metrics));
   assert.ok(metrics.panel.left>=0&&metrics.panel.right<=width&&metrics.panel.top>=0&&metrics.panel.bottom<=height);
   for(const r of metrics.targets)assert.ok(r.width>=44&&r.height>=44,JSON.stringify(r));
   if(width===390)await page.screenshot({path:path.join(evidence,style+'-expanded.png')});
   await page.clock.fastForward(4999);assert.ok(await panel.isVisible(),'visible before five seconds');
   await page.clock.fastForward(1);assert.equal(await panel.isVisible(),false);assert.ok(await reopen.isVisible());
   assert.equal(await reopen.getAttribute('aria-expanded'),'false');
   assert.equal(await page.evaluate(()=>localStorage.getItem('ytStreamerAiMediaOptInV1')),enabled?'1':'0','hiding preserves AI consent');
   const launcher=await reopen.boundingBox();assert.ok(launcher.width>=44&&launcher.height>=44);
   if(width===390)await page.screenshot({path:path.join(evidence,style+'-collapsed.png')});
   await reopen.click();assert.ok(await panel.isVisible());assert.equal(await reopen.isVisible(),false);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'aiMediaProductionToggle');
   await page.clock.fastForward(4000);await page.locator('#aiMediaProductionSignIn').focus();
   await page.clock.fastForward(4000);assert.ok(await panel.isVisible(),'focus resets timer');
   await page.keyboard.press('Tab');await page.clock.fastForward(4999);assert.ok(await panel.isVisible(),'keyboard resets timer');
   await page.clock.fastForward(1);assert.equal(await panel.isVisible(),false);
   await page.clock.fastForward(30000);assert.equal(await panel.isVisible(),false,'auth retries must not reopen panel');
   results.push({width,height,style,enabled,metrics,passed:true});console.log('PASS '+width+'x'+height+' '+style+' opt-in='+enabled);
   await context.close();
  }
 }
 await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify(results,null,2)+'\n');
}finally{await browser.close();}
