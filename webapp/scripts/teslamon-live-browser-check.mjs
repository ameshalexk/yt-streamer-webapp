import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(scriptDir,'../public');
const evidenceDir=path.resolve(scriptDir,'../docs/teslamon-puppy-evidence');
await fs.mkdir(evidenceDir,{recursive:true});
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
 headless:true,args:['--no-first-run','--no-default-browser-check']
});
const results=[];
const measure=async page=>page.evaluate(()=>{
 const pet=document.querySelector('#teslamonPet');
 const panel=pet.querySelector('#tmPanel');
 const face=pet.querySelector('#tmFace');
 const handle=pet.querySelector('#tmHandle');
 const box=panel.getBoundingClientRect();
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
 return {viewport:{width:innerWidth,height:innerHeight},open:!panel.hidden,panel:rect(panel),
   pet:rect(pet),face:rect(face),handle:rect(handle),svgCount:face.querySelectorAll('svg.tm-puppy').length,
   tailAnimation:getComputedStyle(pet.querySelector('.tm-tail')).animationName,
   scrollWidth:document.documentElement.scrollWidth};
});
const assertContained=(m,label)=>{
 assert.ok(m.open,label+': panel is closed');
 assert.ok(m.panel.left>=-1&&m.panel.right<=m.viewport.width+1&&m.panel.top>=-1&&m.panel.bottom<=m.viewport.height+1,label+': panel outside viewport '+JSON.stringify(m));
 assert.ok(m.scrollWidth<=m.viewport.width+2,label+': horizontal overflow '+JSON.stringify(m));
};
const setup=async(viewport,ui,reducedMotion=false)=>{
 const ctx=await browser.newContext({viewport,serviceWorkers:'block',reducedMotion:reducedMotion?'reduce':'no-preference'});
 const page=await ctx.newPage();
 const unexpected=[];
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
   try{const body=await route.fetch({url:local+url.pathname+url.search,timeout:6500});await route.fulfill({response:body});}
   catch{try{await route.abort();}catch{/* navigation settled */}}
 });
 await page.goto(origin+'/?ui='+ui,{waitUntil:'domcontentloaded',timeout:16000});
 await page.locator('#teslamonPet').waitFor({state:'attached',timeout:13000});
 assert.equal(await page.locator('#tmFace').getAttribute('aria-label'),'TeslaMon puppy — open or close controls',ui+': accessible face name');
 assert.equal(await page.locator('#tmHandle').getAttribute('aria-label'),'Drag TeslaMon to move',ui+': accessible drag handle name');
 const sizes=await page.evaluate(()=>{const f=document.querySelector('#tmFace').getBoundingClientRect(),h=document.querySelector('#tmHandle').getBoundingClientRect();return {face:{width:f.width,height:f.height},handle:{width:h.width,height:h.height},svg:document.querySelectorAll('#tmFace svg.tm-puppy').length};});
 assert.ok(sizes.face.width>=44&&sizes.face.height>=44&&sizes.handle.width>=44&&sizes.handle.height>=44,ui+': face/handle touch target under 44px '+JSON.stringify(sizes));
 assert.equal(sizes.svg,1,ui+': vector puppy SVG missing');
 return {ctx,page,unexpected};
};
const clickOpen=async page=>{
 await page.locator('#tmFace').click();
 await page.locator('#tmPanel').waitFor({state:'visible'});
 assert.equal(await page.locator('#tmFace').getAttribute('aria-expanded'),'true');
 const mic=await page.locator('#tmMic').boundingBox();
 assert.ok(mic&&mic.width>=44&&mic.height>=44,'mic touch target under 44px '+JSON.stringify(mic));
 const wake=await page.locator('#tmWakeToggle').boundingBox();
 assert.ok(wake&&wake.width>=44&&wake.height>=44,'hands-free toggle touch target under 44px '+JSON.stringify(wake));
 assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'false','wake mic must default off');
 assert.match(await page.locator('#tmWakeState').innerText(),/^Off$/,'wake mic must truthfully report Off');
 assert.equal(await page.locator('#tmDevices').count(),0,'remote device selector must not exist');
 assert.match(await page.locator('.tm-self-target').innerText(),/this browser tab only/i);
 const facade=await page.evaluate(()=>typeof globalThis.YTStreamerMediaAgent?.execute);
 assert.equal(facade,'function','current-page player facade not initialized');
 await page.locator('button[data-tm="get_playback_state"]').click();
 await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent?.includes('Player state:'),null,{timeout:7000});
 const reply=await page.locator('#tmState').innerText();
 assert.match(reply,/idle/i,'synthetic player status should be idle: '+reply);
};
const dragTo=async(page,x,y)=>{
 const handle=page.locator('#tmHandle');
 const start=await handle.boundingBox();
 await page.mouse.move(start.x+start.width/2,start.y+start.height/2);
 await page.mouse.down();await page.mouse.move(x,y,{steps:8});await page.mouse.up();
};
try{
 const scenarios=[];
 for(const [width,height] of [[320,568],[375,812],[390,844],[430,932]])
   for(const ui of ['classic','new'])scenarios.push({width,height,ui});
 for(const [width,height] of [[768,1024],[1024,768],[844,390],[1440,900]])
   for(const ui of ['classic','new'])scenarios.push({width,height,ui});
 for(const scenario of scenarios){
  const {width,height,ui}=scenario;
  const {ctx,page,unexpected}=await setup({width,height},ui);
  try{
   if(width===390&&ui==='classic')await page.screenshot({path:path.join(evidenceDir,'390-closed-puppy.png')});
   await clickOpen(page);
   let initial=await measure(page);assertContained(initial,width+'x'+height+' initial');
   if(width===320&&ui==='classic')await page.screenshot({path:path.join(evidenceDir,'320-panel-open.png')});
   if(width===1440)await page.screenshot({path:path.join(evidenceDir,'desktop-puppy-panel.png')});
   const moved=[];
   // Drag to both vertical extremes while open and verify the panel follows safely.
   for(const targetY of [4,height-6]){
    await dragTo(page,Math.max(10,width-60),targetY);
    const after=await measure(page);assertContained(after,width+'x'+height+' moved y='+targetY);
    moved.push(after);
   }
   const saved=JSON.parse(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPetPositionV1')));
   assert.ok(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y),width+'x'+height+': drag position not persisted');
   await page.reload({waitUntil:'domcontentloaded'});await page.locator('#teslamonPet').waitFor({state:'attached'});
   const restored=await page.locator('#teslamonPet').evaluate(el=>({x:el.offsetLeft,y:el.offsetTop}));
   assert.ok(Math.abs(restored.x-saved.x)<=1&&Math.abs(restored.y-saved.y)<=1,width+'x'+height+': drag position did not restore');
   await page.locator('#tmHandle').focus();
   await page.keyboard.press('ArrowLeft');
   const afterKeyboard=await page.locator('#teslamonPet').evaluate(el=>({x:el.offsetLeft,y:el.offsetTop}));
   assert.ok(afterKeyboard.x<restored.x,width+'x'+height+': ArrowLeft did not move puppy');
   const keyboardSaved=JSON.parse(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPetPositionV1')));
   assert.ok(keyboardSaved&&keyboardSaved.x===afterKeyboard.x&&keyboardSaved.y===afterKeyboard.y,width+'x'+height+': keyboard position was not persisted');
   await page.reload({waitUntil:'domcontentloaded'});await page.locator('#teslamonPet').waitFor({state:'attached'});
   const keyboardRestored=await page.locator('#teslamonPet').evaluate(el=>({x:el.offsetLeft,y:el.offsetTop}));
   assert.ok(Math.abs(keyboardRestored.x-afterKeyboard.x)<=1&&Math.abs(keyboardRestored.y-afterKeyboard.y)<=1,width+'x'+height+': keyboard position did not restore');
   await clickOpen(page);assertContained(await measure(page),width+'x'+height+' reopened after reload');
   await page.locator('#tmClose').click();assert.equal(await page.locator('#tmPanel').isVisible(),false,width+'x'+height+': close button failed');
   assert.deepEqual(unexpected,[],width+'x'+height+': attempted non-production-origin requests');
   results.push({scenario,initial,moved,saved,restored,afterKeyboard,keyboardRestored,checks:{touchTargets:true,svg:true,accessibleNames:true,openClose:true,dragPersistence:true,keyboardMovementPersistence:true,viewportContainment:true,syntheticNetwork:true,statusFacadeIdle:true}});
   console.log('PASS',width+'x'+height,ui,'puppy controls, drag/persistence, viewport containment');
  }finally{await ctx.close();}
 }
 const {ctx,page,unexpected}=await setup({width:390,height:844},'classic',true);
 try{
  const animation=await page.locator('.tm-tail').evaluate(el=>getComputedStyle(el).animationName);
  assert.equal(animation,'none','reduced motion must disable tail animation');
  await clickOpen(page);assertContained(await measure(page),'reduced-motion panel');
  assert.deepEqual(unexpected,[],'reduced-motion attempted non-production-origin requests');
  results.push({scenario:{width:390,height:844,ui:'classic',reducedMotion:true},tailAnimation:animation,checks:{tailAnimationDisabled:true}});
  console.log('PASS prefers-reduced-motion: tail animation disabled');
 }finally{await ctx.close();}
 const safe=await setup({width:390,height:844},'classic');
 try{
  await safe.page.addStyleTag({content:'#teslamonPet{--tm-safe-left:44px;--tm-safe-right:44px;--tm-safe-top:0px;--tm-safe-bottom:21px}'});
  await clickOpen(safe.page);
  const edges=[];
  for(const targetY of [4,838]){
   await dragTo(safe.page,380,targetY);
   const m=await measure(safe.page);assertContained(m,'synthetic safe area y='+targetY);
   assert.ok(m.pet.left>=51&&m.pet.right<=339,'safe-area horizontal drag clamp failed '+JSON.stringify(m.pet));
   assert.ok(m.pet.bottom<=815,'safe-area bottom drag clamp failed '+JSON.stringify(m.pet));
   assert.ok(m.panel.left>=52&&m.panel.right<=338,'safe-area panel clamp failed '+JSON.stringify(m.panel));
   edges.push(m);
  }
  assert.deepEqual(safe.unexpected,[],'safe-area scenario attempted non-production-origin requests');
  results.push({scenario:{width:390,height:844,ui:'classic',safeArea:{left:44,right:44,bottom:21}},edges,checks:{panelContainment:true,safeAreaClamping:true,syntheticNetwork:true}});
  console.log('PASS synthetic safe-area overrides: left/right 44px, bottom 21px');
 }finally{await safe.ctx.close();}
 const report={generatedAt:new Date().toISOString(),browser:'Google Chrome via Playwright Chromium',coverage:'Chrome viewport/device emulation only; no physical iPhone Safari acceptance',network:'Synthetic loopback asset/API responses; all other origins blocked',scenarioCount:results.length,results};
 await fs.writeFile(path.join(evidenceDir,'browser-measurements.json'),JSON.stringify(report,null,2)+'\n');
 console.log('PASS',results.length+' scenarios; measurements and screenshots saved to',evidenceDir);
}finally{
 await browser.close();await new Promise(resolve=>server.close(resolve));
}
