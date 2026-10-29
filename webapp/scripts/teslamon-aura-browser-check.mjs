// Isolated Chrome Aura/pet integration; no production auth, microphone or media.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript',
  '.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.wasm':'application/wasm'};
const fakeHandsFree=String.raw`
export function createTeslaMonHandsFree({onState,onAudio}={}){
  let enabled=false,state='off',invocation=0,activeController=null;
  const emit=update=>{state=update.state;onState?.(update);};
  globalThis.__auraWake=keyword=>{
    if(!enabled||state!=='listening')return;
    globalThis.__fixturePlayback='paused';
    const invocationId=++invocation;
    emit({state:'preparing',keyword,invocationId,message:'Pausing before recording'});
    emit({state:'recording',keyword,invocationId,message:'Recording one command'});
  };
  globalThis.__auraProcessing=()=>emit({state:'processing',invocationId:invocation,message:'Processing'});
  globalThis.__auraRecover=()=>{
    emit({state:'recovering',invocationId:invocation,message:'Pause failed'});
    emit({state:'cooldown',invocationId:invocation,message:'Pause timed out · rearming…'});
  };
  globalThis.__auraVoiceSubmit=async()=>{
    if(!enabled||state!=='recording')return false;
    const controller=new AbortController();
    activeController=controller;
    emit({state:'processing',invocationId:invocation,message:'Transcribing'});
    try{await onAudio(new Blob(['fixture-command'],{type:'audio/webm'}),{
      signal:controller.signal,invocationId:invocation,
      isCurrent:()=>enabled&&!controller.signal.aborted,
    });}finally{
      if(activeController===controller)activeController=null;
      if(enabled){emit({state:'cooldown',invocationId:invocation,message:'Rearming'});
        emit({state:'listening',invocationId:invocation,message:'Wake ready'});}
    }
    return true;
  };
  globalThis.__auraStandby=()=>{
    emit({state:'cooldown',invocationId:invocation,message:'Rearming'});
    emit({state:'listening',invocationId:invocation,message:'Listening for a wake phrase'});
  };
  return {enable(){enabled=true;emit({state:'listening',message:'Waiting for wake phrase'});return Promise.resolve(true);},
    disable(){enabled=false;activeController?.abort();activeController=null;emit({state:'off',message:'Off'});},
    suspend(){return false;},resume(){return true;},
    get enabled(){return enabled;},get state(){return state;}};
}
`;
const fakeLocalStt=String.raw`
export function createTeslaMonLocalStt({modelId}={}){
  let selectedModelId=modelId||'whisper-tiny.en';
  return {getState(){return {selectedModelId,selectedModel:{label:'Tiny English'},loaded:true};},
    async transcribe(_blob,{signal,onPhase}={}){
      onPhase?.({phase:'transcribing',message:'Fake local transcription'});
      await Promise.resolve();
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      return {text:globalThis.__fixtureSpeechText||'turn on office lights'};
    },
    async setModel(value){selectedModelId=value;},cancelPending(){},dispose(){}};
}
`;
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(pathname==='/teslamon-handsfree.js'){
    res.writeHead(200,{'content-type':'text/javascript'});res.end(fakeHandsFree);return;
  }
  if(pathname==='/teslamon-local-stt.js'){
    res.writeHead(200,{'content-type':'text/javascript'});res.end(fakeLocalStt);return;
  }
  if(pathname.startsWith('/api/')){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(pathname==='/api/teslamon/capabilities'?{codexAvailable:true,localTranscription:true}:
      pathname==='/api/teslamon/plan'?{status:'ha_done',action:'light_checked'}:
      pathname==='/api/playlists'?[]:{ok:true,items:[]}));
    return;
  }
  const target=path.resolve(root,decodeURIComponent(pathname==='/'?'index.html':pathname.slice(1)));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{
    let bytes=await fs.readFile(target);
    if(pathname==='/teslamon-pet.js')bytes=Buffer.from(bytes.toString('utf8').replace(
      "['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'",
      "['stream.ameshalex.com','teslamon-stage.ameshalex.com','127.0.0.1'].includes(location.hostname)&&['https:','http:'].includes(location.protocol)"
    ));
    res.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream'});
    res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--no-first-run','--use-fake-ui-for-media-stream']});
const viewports=process.env.TESLAMON_AURA_FAST==='1'?[[390,844]]:[[320,568],[375,667],[390,844],[430,932],[768,1024],[844,390],[1280,800],[1920,1080]];
const results=[],errors=[];
try{
  for(const [width,height] of viewports){
    for(const ui of (process.env.TESLAMON_AURA_FAST==='1'?['classic']:['classic','new'])){
      console.log('checking',ui,width,height);
      const context=await browser.newContext({viewport:{width,height},isMobile:width<900,hasTouch:true,
        reducedMotion:(width===390?'reduce':'no-preference')});
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(ui+' '+width+' '+error.message));
      await page.addInitScript(()=>{
        window.__fixturePlayback='idle';
        window.YTStreamerMediaAgent={
          execute:async()=>({status:'completed',state:{playback_phase:window.__fixturePlayback}}),
          get_player_state:()=>({playback_phase:window.__fixturePlayback,fullscreen_kind:'none'}),
        };
        navigator.mediaDevices.getUserMedia=async()=>{throw new Error('Fixture must not request microphone');};
      });
      const plans=[];
      page.on('request',req=>{if(new URL(req.url()).pathname==='/api/teslamon/plan')plans.push(req.postDataJSON());});
      await page.goto(origin+'/?ui='+ui,{waitUntil:'domcontentloaded'});
      await page.locator('#tmAuraToggle').waitFor({state:'attached'});
      await page.waitForFunction(()=>typeof window.__auraWake==='function');
      assert.equal(await page.locator('#tmAuraToggle').isChecked(),true);
      assert.equal(await page.locator('#tmAura').isHidden(),true);
      // Local toggle On enters immediately without requesting a microphone.
      await page.locator('#tmFace').click();
      await page.locator('#tmWakeToggle').click(); // Mic Off is separate.
      assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'false');
      await page.locator('#tmAuraToggle').uncheck();
      await page.locator('#tmAuraToggle').check();
      await page.locator('#tmAura').waitFor({state:'visible'});
      assert.match(await page.locator('#tmAuraDetail').innerText(),/Mic off/);
      assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'false');
      const measure=await page.evaluate(()=>{
        const root=document.querySelector('#tmAura'),rect=root.getBoundingClientRect();
        const title=root.querySelector('.ta-title').getBoundingClientRect();
        const caption=root.querySelector('.ta-caption').getBoundingClientRect();
        return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
          titleInside:title.left>=-1&&title.right<=innerWidth+1,
          captionInside:caption.left>=-1&&caption.right<=innerWidth+1,
          overflow:document.documentElement.scrollWidth-innerWidth,
          reducedMotion:getComputedStyle(root.querySelector('.ta-orb')).animationName};
      });
      assert.ok(Math.abs(measure.rect.x)<=1&&Math.abs(measure.rect.y)<=1);
      assert.ok(Math.abs(measure.rect.width-width)<=1&&Math.abs(measure.rect.height-height)<=1);
      assert.ok(measure.titleInside&&measure.captionInside,ui+' '+width+' text clipped');
      assert.ok(measure.overflow<=2,ui+' '+width+' horizontal overflow '+measure.overflow);
      assert.equal(await page.locator('#tmAura .ta-title').innerText(),'I am listening');
      assert.equal(await page.locator('#tmAura .ta-hint').innerText(),'What would you like me to do?');
      assert.equal(await page.locator('#tmAura .ta-header, #tmAura .ta-footer, #tmAura .ta-transcript').count(),0);
      if(width===390)assert.equal(measure.reducedMotion,'none');
      if(process.env.TESLAMON_AURA_SCREENSHOTS==='1'){
        await page.screenshot({path:'/tmp/teslamon-aura-'+ui+'-'+width+'x'+height+'.jpg',type:'jpeg',quality:60});
      }
      await page.locator('#tmAura').tap({position:{x:Math.min(30,width/4),y:Math.min(30,height/4)}});
      assert.equal(await page.locator('#tmAura').isHidden(),true);
      const controls=await page.evaluate(()=>{
        const wake=document.querySelector('#tmWakeToggle')?.getBoundingClientRect();
        const toggle=document.querySelector('#tmAuraToggle')?.closest('label')?.getBoundingClientRect();
        if(!wake||!toggle)return {missing:true,html:document.body.innerHTML.slice(0,200)};
        return {wakeWidth:wake.width,wakeHeight:wake.height,toggleHeight:toggle.height};
      });
      assert.ok(!controls.missing,ui+' '+width+' controls missing '+JSON.stringify(controls));
      assert.ok(Math.min(controls.wakeWidth,controls.wakeHeight,controls.toggleHeight)>=44,
        ui+' '+width+' control <44px '+JSON.stringify(controls));
      // Storage change from another tab updates preference without opening here.
      await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{
        key:'ytStreamerTeslaMonAuraEnabledV1',newValue:'1'})));
      assert.equal(await page.locator('#tmAura').isHidden(),true);
      // Re-enable mic, then repeated wake cycles retain presentation and exit on playing.
      await page.locator('#tmWakeToggle').click();
      await page.evaluate(()=>window.__auraWake('hey_jarvis'));
      await page.locator('#tmAura').waitFor({state:'visible'});
      assert.equal(await page.locator('#tmAura').getAttribute('data-phase'),'listening');
      await page.evaluate(()=>{window.__auraProcessing();window.__auraStandby();});
      assert.equal(await page.locator('#tmAura').isVisible(),true,'non-video completion retains Aura');
      assert.match(await page.locator('#tmAuraDetail').innerText(),/wake phrase/);
      await page.evaluate(()=>window.__fixturePlayback='playing');
      await page.locator('#tmAura').waitFor({state:'hidden',timeout:4000});
      assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true','video exit preserves mic');
      await page.evaluate(()=>window.__auraWake('alexa'));
      await page.locator('#tmAura').waitFor({state:'visible'});
      await page.locator('#tmAura').press('Escape');
      assert.equal(await page.locator('#tmAura').isHidden(),true,'Escape is presentation only');
      await page.evaluate(()=>window.__auraStandby());
      assert.equal(await page.locator('#tmAura').isHidden(),true,'late event cannot reopen dismissed Aura');
      // Voice-origin typed fallback still dispatches once after visual dismissal.
      await page.evaluate(()=>{
        const input=document.querySelector('#tmText');
        input.value='turn on the kitchen lights';
        input.dispatchEvent(new Event('input',{bubbles:true}));
      });
      await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent?.includes('Home Assistant light'),null,{timeout:7000});
      assert.equal(plans.length,1,'one command after dismiss');
      if(width===390&&ui==='classic'){
        // Real pet -> composed final-STT -> voice grace -> planner dispatch.
        await page.evaluate(()=>{
          window.__fixturePlayback='paused';
          window.__fixtureSpeechText='turn on office lights';
          window.__auraWake('hey_jarvis');
          void window.__auraVoiceSubmit();
        });
        await page.waitForFunction(()=>document.querySelector('#tmText')?.value==='turn on office lights');
        await page.waitForTimeout(1550);
        await page.evaluate(()=>window.__auraWake('alexa')); // rejected while processing
        await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent?.includes('Home Assistant light'),
          null,{timeout:6500});
        assert.equal(plans.length,2,'first accepted voice transcript survives rearm boundary');
        await page.waitForFunction(()=>document.querySelector('#tmWakeState')?.textContent?.includes('Wake ready'));
        // Presentation B is a fresh local toggle while A is in its grace.
        // A's eventual HA completion must not overwrite or close B.
        await page.evaluate(()=>{
          window.__fixtureSpeechText='turn on hallway lights';
          window.__auraWake('hey_jarvis');
          void window.__auraVoiceSubmit();
        });
        await page.waitForFunction(()=>document.querySelector('#tmText')?.value==='turn on hallway lights');
        await page.locator('#tmAura').tap();
        await page.locator('#tmFace').click();
        await page.locator('#tmAuraToggle').uncheck();
        await page.locator('#tmAuraToggle').check();
        assert.equal(await page.locator('#tmAura').isVisible(),true);
        await page.waitForFunction(()=>document.querySelector('#tmAuraDetail')?.textContent==='Say a wake phrase',
          null,{timeout:6500});
        assert.equal(await page.locator('#tmAura').getAttribute('data-phase'),'standby',
          'A late completion cannot set a newer presentation to complete');
        assert.equal(plans.length,3,'presentation toggles preserve A dispatch once');
        // The second invocation is accepted, but Mic Off cancels its staged
        // transcript before the two-second timer initiates a command.
        await page.evaluate(()=>{
          window.__fixtureSpeechText='turn off bedroom lights';
          window.__auraWake('alexa');
          void window.__auraVoiceSubmit();
        });
        await page.waitForFunction(()=>document.querySelector('#tmText')?.value==='turn off bedroom lights');
        await page.locator('#tmAura').tap();
        await page.locator('#tmFace').click();
        await page.locator('#tmWakeToggle').click();
        await page.waitForTimeout(2250);
        assert.equal(plans.length,3,'Mic Off must cancel unsent voice transcript');
        assert.equal(await page.locator('#tmText').inputValue(),'','cancelled voice-only draft cleared');
        await page.locator('#tmWakeToggle').click(); // allow later wake again
        await page.evaluate(()=>{
          window.__fixturePlayback='paused';
          window.__auraWake('hey_jarvis');
          window.__fixturePlayback='playing';
          window.__auraRecover();
        });
        await page.locator('#tmAura').waitFor({state:'hidden',timeout:4000});
        assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true',
          'recovering after failed pause must not disable mic');
        await page.evaluate(()=>window.__auraStandby());
      }
      // Existing playback wins when a local toggle On overlaps real playback.
      await page.evaluate(()=>window.__fixturePlayback='playing');
      if(await page.locator('#tmPanel').isHidden())await page.locator('#tmFace').click();
      await page.locator('#tmAuraToggle').uncheck();
      await page.locator('#tmAuraToggle').check();
      assert.equal(await page.locator('#tmAura').isHidden(),true,'playing takes precedence over local toggle');
      results.push({ui,width,height,measure,plans:plans.length});
      await context.close();
    }
  }
  assert.deepEqual(errors,[],'browser errors');
  if(process.env.TESLAMON_AURA_SCREENSHOTS==='1'){
    const destination=path.resolve(root,'../docs/teslamon-aura-reliability-evidence-20261028/layout.json');
    await fs.writeFile(destination,JSON.stringify({
      recordedAt:new Date().toISOString(),fixture:'isolated Chrome; synthetic STT, no real mic/media/HA',
      scenarios:results.length,allNoHorizontalOverflow:results.every(x=>x.measure.overflow<=2),
      bothUiModes:true,results,
    },null,2)+'\n');
  }
  console.log(JSON.stringify({passed:results.length,results},null,2));
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
