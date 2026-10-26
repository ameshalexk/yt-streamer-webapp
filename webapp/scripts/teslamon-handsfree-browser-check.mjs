// Synthetic Chrome UI integration: real wake models, fake Chrome mic, mocked API.
// Does not test actual speech accuracy, iPhone Safari, Tesla browser or signed-in profile.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css','.onnx':'application/octet-stream'};
const server=http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 const full=path.resolve(root,decodeURIComponent(pathname.slice(1)||'index.html'));
 if(!full.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 try{let bytes=await fs.readFile(full);if(path.basename(full)==='teslamon-pet.js')bytes=Buffer.from(bytes.toString('utf8').replace("['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'","['stream.ameshalex.com','teslamon-stage.ameshalex.com','127.0.0.1'].includes(location.hostname)&&['https:','http:'].includes(location.protocol)"));res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream'});res.end(bytes);}
 catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({
 executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 headless:true,args:['--no-first-run','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']
});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone'],serviceWorkers:'block'});
 const page=await context.newPage();
 const unexpected=[],apiUploads=[],errors=[],modelRequests=[];
 await page.addInitScript(()=>{
   window.__teslamonMicStreams=[];
   window.YTStreamerMediaAgent={execute:async()=>({status:'completed',state:{playback_phase:'idle',fullscreen_kind:'none'}})};
   const original=navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
   if(original)navigator.mediaDevices.getUserMedia=async (...args)=>{
     const stream=await original(...args);
     window.__teslamonMicStreams.push(stream);
     return stream;
   };
 });
 page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/*',async route=>{
   const requested=new URL(route.request().url());
   if(requested.pathname.startsWith('/games/models/'))modelRequests.push(requested.pathname);
   if(requested.origin!==origin){unexpected.push(requested.href);return route.abort();}
   if(requested.pathname==='/api/teslamon/capabilities'){
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({codexAvailable:true,localTranscription:true})});
   }
   if(requested.pathname.startsWith('/api/')){
     if(['/api/teslamon/transcribe','/api/teslamon/plan'].includes(requested.pathname))apiUploads.push(requested.pathname);
     return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({status:'failed'})});
   }
   const target='http://127.0.0.1:'+server.address().port+requested.pathname+requested.search;
   try{const result=await route.fetch({url:target,timeout:15000});return route.fulfill({response:result});}
   catch{return route.abort();}
 });
 await page.goto(origin+'/?ui=classic',{waitUntil:'domcontentloaded',timeout:20000});
 await page.locator('#tmFace').click();
 try{await page.waitForFunction(()=>!document.querySelector('#tmWakeToggle').disabled,null,{timeout:5000});}catch(error){console.error('INIT DEBUG',JSON.stringify(await page.evaluate(()=>({wake:document.querySelector('#tmWakeState')?.textContent,mic:document.querySelector('#tmMic')?.textContent,main:document.querySelector('#tmState')?.textContent,pet:!!document.querySelector('#teslamonPet'),toggleDisabled:document.querySelector('#tmWakeToggle')?.disabled})),null,2),'pageErrors',errors,'api',apiUploads,'unexpected',unexpected);throw error;}
 // Auto-wake is already ON after page load, subject to browser permissions.
 try { await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Listening for'),null,{timeout:12000}); }
 catch(error){console.error('AUTO-WAKE DEBUG',JSON.stringify(await page.evaluate(()=>({wake:document.querySelector('#tmWakeState')?.textContent,mic:document.querySelector('#tmWakeToggle')?.textContent,main:document.querySelector('#tmState')?.textContent,streams:window.__teslamonMicStreams?.length})),null,2),'pageErrors',errors,'api',apiUploads,'unexpected',unexpected);throw error;}
 assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true');
 assert.match(await page.locator('#tmWakeState').innerText(),/Hey Jarvis, Alexa, Hey Mycroft, Hey Rhasspy/);
 assert.equal(await page.locator('#tmWakePhraseSet').evaluate(fieldset=>fieldset.disabled),true,'phrase changes locked while listening');
 assert.equal(await page.locator('#tmSttModel').isDisabled(),true,'model choice locked while Mic On');
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.length),1,'page load obtains one mic stream');
 assert.equal(await page.locator('#teslamonPet').getAttribute('data-mic'),'on');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#tmFace'),'::after').content),'"MIC ON"');
 await page.locator('#tmWakeToggle').click();
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent==='Off',null,{timeout:10000});
 assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'false');
 assert.equal(await page.locator('#teslamonPet').getAttribute('data-mic'),'off');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#tmFace'),'::after').content),'"MIC OFF"');
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true,'Mic Off ends all tracks');
 // Select only Mycroft while Off; reject attempts to disable the last phrase.
 assert.equal(await page.locator('#tmWakePhraseSet').evaluate(fieldset=>fieldset.disabled),false);
 assert.equal(await page.locator('#tmSttModel').isDisabled(),false);
 await page.locator('#tmSttModel').selectOption('whisper-base.en');
 assert.equal(await page.locator('#tmSttModel').inputValue(),'whisper-base.en');
 await page.locator('input[value=hey_jarvis]').uncheck();
 await page.locator('input[value=alexa]').uncheck();
 await page.locator('input[value=hey_rhasspy]').uncheck();
 await page.locator('input[value=hey_mycroft]').click();
 assert.equal(await page.locator('input[value=hey_mycroft]').isChecked(),true,'last phrase stays enabled');
 assert.match(await page.locator('#tmWakePhraseHelp').innerText(),/at least one/);
 // Manual On starts a fresh stream with only Mycroft.
 await page.locator('#tmWakeToggle').click();
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Listening for'),null,{timeout:12000});
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.length),2);
 assert.equal(await page.locator('#tmWakeState').innerText(),'Listening for Hey Mycroft');
 await page.locator('#tmWakeToggle').click();
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent==='Off',null,{timeout:10000});
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
 // Reload restores only Mycroft and automatic listening uses the persisted choice.
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent==='Listening for Hey Mycroft',null,{timeout:15000});
 await page.locator('#tmFace').click();
 assert.equal(await page.locator('input[value=hey_mycroft]').isChecked(),true);
 assert.equal(await page.locator('input[value=alexa]').isChecked(),false);
 assert.equal(await page.locator('input[value=hey_jarvis]').isChecked(),false);
 assert.equal(await page.locator('#tmSttModel').inputValue(),'whisper-base.en','transcription choice survives reload');
 assert.equal(await page.locator('input[value=hey_rhasspy]').isChecked(),false);
 await page.locator('#tmWakeToggle').click();
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
 // Existing Luna-only browser choice must migrate to both replacement phrases.
 await page.evaluate(()=>localStorage.setItem('ytStreamerTeslaMonWakePhrasesV1',JSON.stringify(['hey_luna'])));
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent==='Listening for Hey Mycroft, Hey Rhasspy',null,{timeout:15000});
 await page.locator('#tmFace').click();
 assert.equal(await page.locator('input[value=hey_mycroft]').isChecked(),true);
 assert.equal(await page.locator('input[value=hey_rhasspy]').isChecked(),true);
 assert.equal(await page.locator('input[value=hey_jarvis]').isChecked(),false);
 assert.equal(await page.locator('#tmSttModel').inputValue(),'whisper-base.en','transcription choice survives reload');
 assert.equal(await page.locator('input[value=alexa]').isChecked(),false);
 await page.locator('#tmWakeToggle').click();
 await page.evaluate(()=>localStorage.setItem('ytStreamerTeslaMonSttModelV1','__proto__'));
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Listening for'),null,{timeout:15000});
 await page.locator('#tmFace').click();
 assert.equal(await page.locator('#tmSttModel').inputValue(),'whisper-tiny.en','invalid saved model falls back to Tiny');
 await page.locator('#tmWakeToggle').click();
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
 // Turn off via the small X on the puppy: this must stop the microphone,
 // survive reloads and synchronize the opt-out across same-origin tabs.
 await page.locator('#tmWakeToggle').click();
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Listening for'),null,{timeout:15000});
 const other=await context.newPage();
 await other.goto(origin+'/?ui=new',{waitUntil:'domcontentloaded'});
 await other.locator('#tmFace').waitFor({state:'visible'});
 const puppyHandle=await page.locator('#tmHandle').boundingBox();
 await page.mouse.move(puppyHandle.x+22,puppyHandle.y+22);
 await page.mouse.down();await page.mouse.move(135,225,{steps:10});await page.mouse.up();
 const dogPosition=JSON.parse(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPetPositionV1')));
 assert.ok(Number.isFinite(dogPosition?.x)&&Number.isFinite(dogPosition?.y),'dog remembers its own position');
 const closeBox=await page.locator('#tmDisable').boundingBox();
 assert.ok(closeBox&&closeBox.width>=44&&closeBox.height>=44,'puppy X needs 44px touch target');
 await page.locator('#tmDisable').click();
 await page.waitForFunction(()=>document.querySelector('#teslamonPet')?.dataset.disabled==='true');
 await other.waitForFunction(()=>document.querySelector('#teslamonPet')?.dataset.disabled==='true');
 assert.equal(await page.locator('#tmFace').isVisible(),false,'dog hides when disabled');
 assert.equal(await page.locator('#tmRestore').isVisible(),true,'restore paw stays accessible');
 assert.equal(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonDisabledV1')),'1');
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true,'puppy X must stop all tracks');
 assert.equal(await other.locator('#tmFace').isVisible(),false,'other tab hides dog as well');
 await other.close();
 const initialPaw=await page.locator('#tmRestore').boundingBox();
 const viewport=page.viewportSize();
 assert.ok(viewport.width-initialPaw.x-initialPaw.width<=20&&
   viewport.height-initialPaw.y-initialPaw.height<=20,'closed paw defaults to bottom-right');
 const pawCenter={x:initialPaw.x+initialPaw.width/2,y:initialPaw.y+initialPaw.height/2};
 await page.mouse.move(pawCenter.x,pawCenter.y);await page.mouse.down();
 await page.mouse.move(90,145,{steps:12});await page.mouse.up();
 assert.equal(await page.locator('#teslamonPet').getAttribute('data-disabled'),'true','dragging paw must not re-enable TeslaMon');
 const movedPaw=await page.locator('#tmRestore').boundingBox();
 assert.ok(movedPaw.x<150&&movedPaw.y<200,'paw moves independently to upper left');
 const pawSaved=JSON.parse(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPawPositionV1')));
 assert.ok(Number.isFinite(pawSaved?.x)&&Number.isFinite(pawSaved?.y),'paw position persists');
 assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPetPositionV1'))),dogPosition,
   'paw drag cannot overwrite the dog position');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('#tmRestore').waitFor({state:'visible'});
 const afterPawReload=await page.locator('#tmRestore').boundingBox();
 assert.ok(Math.abs(afterPawReload.x-pawSaved.x)<=1&&Math.abs(afterPawReload.y-pawSaved.y)<=1,
   'disabled paw drag position survives reload');
 await page.locator('#tmRestore').focus();
 await page.keyboard.press('ArrowDown');
 const pawKeyboardSaved=JSON.parse(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonPawPositionV1')));
 assert.ok(pawKeyboardSaved.y>pawSaved.y,'paw arrow keys move and save position');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('#tmRestore').waitFor({state:'visible'});
 const restoreBox=await page.locator('#tmRestore').boundingBox();
 assert.ok(restoreBox&&restoreBox.width>=44&&restoreBox.height>=44,'restore paw needs 44px touch target');
 assert.equal(await page.locator('#tmFace').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.length),0,'opted-out page must not request microphone on load');
 await page.locator('#tmRestore').click();
 await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Listening for'),null,{timeout:15000});
 assert.equal(await page.locator('#tmFace').isVisible(),true,'dog returns after restore');
 const restoredDog=await page.locator('#teslamonPet').evaluate(el=>({x:el.offsetLeft,y:el.offsetTop}));
 assert.ok(Math.abs(restoredDog.x-dogPosition.x)<=1&&Math.abs(restoredDog.y-dogPosition.y)<=1,
   'restoring dog uses its own saved position rather than the paw position');
 assert.equal(await page.evaluate(()=>localStorage.getItem('ytStreamerTeslaMonDisabledV1')),null,'restore clears persistent opt-out');
 await page.locator('#tmDisable').click();
 assert.equal(await page.evaluate(()=>window.__teslamonMicStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true,'second disable stops resumed mic');
 console.log('PASS puppy X stops mic; paw defaults bottom-right, drags/keyboard-moves independently, persists and restores');
 assert.deepEqual(modelRequests,[],'choosing Base never eagerly downloads transcription weights');
 assert.deepEqual(apiUploads,[],'no ambient audio uploaded to PowerALX or Codex');
 assert.deepEqual(unexpected,[],'no third-party network calls');
 assert.deepEqual(errors,[],'no page JS errors');
 console.log('PASS Chrome synthetic auto Mic On -> Off -> On -> Off with persistent badge; tracks stopped, no ambient upload');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
