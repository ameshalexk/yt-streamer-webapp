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
   if(u.pathname==='/api/playlists')return res.end('[]');
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
const setup=async(viewport,ui,reducedMotion=false,simulateWake=false,hasTouch=false)=>{
 const ctx=await browser.newContext({viewport,hasTouch,serviceWorkers:'block',reducedMotion:reducedMotion?'reduce':'no-preference'});
 if(simulateWake)await ctx.addInitScript(()=>{
   // A synthetic live audio track and detector callback test only DOM wiring,
   // not recognition accuracy or real Tesla microphone permissions.
   navigator.mediaDevices.getUserMedia=async()=>{
     const context=new AudioContext();
     return context.createMediaStreamDestination().stream;
   };
 });
 const page=await ctx.newPage();
 const unexpected=[];
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
   if(simulateWake&&url.pathname==='/api/teslamon/capabilities')return route.fulfill({
     status:200,contentType:'application/json',body:JSON.stringify({codexAvailable:true})
   });
   if(simulateWake&&url.pathname==='/teslamon-wake-engine.js')return route.fulfill({
     status:200,contentType:'text/javascript',
     body:'export function createTeslaMonWakeDetector({onWake}){return {async start(){window.__testWake=onWake;return true},pause(){},resume(){},async stop(){}}}'
   });
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
 await page.locator('#tmPanel').waitFor({state:'hidden'});
 assert.equal(await page.locator('#teslamonPet').isVisible(),true,'mic off keeps touch fallback visible');
 await page.locator('#tmFace').click();
 await page.locator('#tmPanel').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'tmText','opened puppy focuses command');
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
 // Fullscreen must hide the entire pet, including its handle and MIC badge.
 // With wake OFF, leaving fullscreen must restore the touch fallback.
 const fullscreen=await setup({width:390,height:844},'classic');
 try{
  await clickOpen(fullscreen.page);
  await fullscreen.page.evaluate(()=>globalThis.YTStreamerTeslaMonFullscreen.enter());
  await fullscreen.page.waitForFunction(()=>document.querySelector('#teslamonPet')?.hidden===true);
  assert.equal(await fullscreen.page.locator('#teslamonPet').isVisible(),false);
  await fullscreen.page.evaluate(()=>globalThis.YTStreamerTeslaMonFullscreen.exit());
  await fullscreen.page.waitForFunction(()=>document.querySelector('#teslamonPet')?.hidden===false);
  assert.equal(await fullscreen.page.locator('#teslamonPet').isVisible(),true);
  assert.deepEqual(fullscreen.unexpected,[],'fullscreen attempted unrelated network requests');
  results.push({scenario:{width:390,height:844,ui:'classic',fullscreen:true},
   checks:{petHiddenFullscreen:true,micOffFallbackRestored:true}});
  console.log('PASS fullscreen hides pet entirely and returns mic-off touch fallback');
 }finally{await fullscreen.ctx.close();}
 // Simulate the wake callback while the assistant is fully hidden.
 // The production detector/model is untouched; real recognition is a device check.
 const wake=await setup({width:390,height:844},'classic',false,true);
 try{
  await wake.page.waitForFunction(()=>document.querySelector('#teslamonPet')?.dataset.wake==='listening',null,{timeout:8000});
  await wake.page.locator('#tmFace').click();
  await wake.page.locator('button[data-tm="get_playback_state"]').click();
  await wake.page.waitForFunction(()=>document.querySelector('#teslamonPet')?.hidden===true,null,{timeout:7000});
  assert.equal(await wake.page.locator('#tmPanel').isVisible(),false);
  assert.equal(await wake.page.locator('#teslamonPet').isVisible(),false);
  await wake.page.evaluate(()=>window.__testWake());
  await wake.page.waitForFunction(()=>document.querySelector('#tmAura')?.hidden===false,null,{timeout:7000});
  assert.equal(await wake.page.locator('#tmAura').isVisible(),true,'Aura replaces the pet panel on wake');
  assert.equal(await wake.page.locator('#tmPanel').isVisible(),false,'pet controls remain closed during Aura');
  assert.equal(await wake.page.locator('#teslamonPet').isVisible(),false,'puppy stays hidden behind Aura');
  await wake.page.locator('#tmAura').click();
  assert.equal(await wake.page.locator('#tmAura').isVisible(),false,'tap exits Aura');
  assert.equal(await wake.page.locator('#teslamonPet').isVisible(),true,'puppy returns after Aura exit');
  assert.equal(await wake.page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true','Aura dismissal keeps mic on');
  assert.deepEqual(wake.unexpected,[],'wake test attempted unrelated network requests');
  results.push({scenario:{width:390,height:844,ui:'classic',syntheticWake:true},
   checks:{successFullyHides:true,auraReplacesPanel:true,tapReturnsToPet:true,micRemainsOn:true}});
  console.log('PASS synthetic Hey Jarvis opens Aura; dismiss returns puppy without stopping mic');
 }finally{await wake.ctx.close();}
 // Exercise real touch events rather than mouse-drag emulation on the disabled paw.
 const pawTouch=await setup({width:390,height:844},'classic',false,false,true);
 try{
  await pawTouch.page.locator('#tmFace').click();
  await pawTouch.page.locator('#tmDisable').click();
  assert.equal(await pawTouch.page.locator('#teslamonPet').getAttribute('data-disabled'),'true','touch scenario: assistant should be disabled');
  const initial=await pawTouch.page.locator('#tmRestore').boundingBox();
  assert.ok(initial.x>=300&&initial.y>=730,'touch scenario: default paw not near bottom right '+JSON.stringify(initial));
  const cdp=await pawTouch.ctx.newCDPSession(pawTouch.page);
  const start={x:Math.round(initial.x+initial.width/2),y:Math.round(initial.y+initial.height/2),id:1};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
  for(let i=1;i<=12;i++){
   const point={x:Math.round(start.x+(110-start.x)*i/12),y:Math.round(start.y+(190-start.y)*i/12),id:1};
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const moved=await pawTouch.page.locator('#tmRestore').boundingBox();
  assert.ok(moved.x<200&&moved.y<280,'touch scenario: paw did not follow finger '+JSON.stringify({initial,moved}));
  assert.equal(await pawTouch.page.locator('#teslamonPet').getAttribute('data-disabled'),'true','touch scenario: dragging paw accidentally enabled assistant');
  const saved=JSON.parse(await pawTouch.page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPawPositionV1')));
  assert.ok(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y),'touch scenario: paw position not persisted');
  await pawTouch.page.reload({waitUntil:'domcontentloaded'});
  await pawTouch.page.locator('#tmRestore').waitFor({state:'visible'});
  const restored=await pawTouch.page.locator('#tmRestore').boundingBox();
  assert.ok(Math.abs(restored.x-moved.x)<=2&&Math.abs(restored.y-moved.y)<=2,'touch scenario: saved paw position did not restore');
  assert.equal(await pawTouch.page.locator('#teslamonPet').getAttribute('data-disabled'),'true','touch scenario: disabled state not persisted');
  await pawTouch.page.touchscreen.tap(restored.x+restored.width/2,restored.y+restored.height/2);
  // Linux Chrome may deliver the synthetic touch-generated click on the next task.
  await pawTouch.page.waitForFunction(()=>document.querySelector('#teslamonPet')?.dataset.disabled==='false',null,{timeout:5000});
  assert.equal(await pawTouch.page.locator('#teslamonPet').getAttribute('data-disabled'),'false','touch scenario: tapping paw did not re-enable assistant');
  assert.deepEqual(pawTouch.unexpected,[],'touch scenario attempted unrelated network requests');
  results.push({scenario:{width:390,height:844,ui:'classic',touchPaw:true},initial,moved,restored,checks:{touchDrag:true,dragDoesNotReactivate:true,pawPersistence:true,tapRestores:true,syntheticNetwork:true}});
  console.log('PASS touch drag: paw bottom-right by default, movable without reactivation, persists, and touch tap restores');
 }finally{await pawTouch.ctx.close();}
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
