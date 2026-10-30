// Isolated Chrome Aura/pet integration; no production auth, microphone or media.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public');
let fixtureScenario='ha_done';
const fixtureBootstrap=()=>{
  window.__fixturePlayback='idle';
  window.__fixtureSpeechText='turn on office lights';
  window.__fixtureCalls={search:0,play:0};
  window.__fixtureMicRequests=0;
  window.__fixturePlanResponses=0;
  window.__fixturePlanRequests=0;
  if(!window.AudioContext&&!window.webkitAudioContext)window.AudioContext=function(){};
  if(!window.AudioWorkletNode)window.AudioWorkletNode=function(){};
  if(!window.MediaRecorder)window.MediaRecorder=function(){};
  if(!window.Worker)window.Worker=function(){};
  window.YTStreamerMediaAgent={
    execute:async(action)=>{
      if(action==='pause_for_voice'){window.__fixturePlayback='paused';return {status:'completed'};}
      if(action==='get_player_state')return {status:'completed',state:{playback_phase:window.__fixturePlayback,fullscreen_kind:'none'}};
      if(action==='search_media'){window.__fixtureCalls.search++;return {status:'completed',result:{results:[{media_id:'abcdefghijk',title:'Fixture video'}]}};}
      if(action==='play_media'){window.__fixtureCalls.play++;window.__fixturePlayback='buffering';return {status:'accepted'};}
      if(action==='request_fullscreen')return {status:'unsupported'};
      return {status:'completed'};
    },
    get_player_state:()=>({playback_phase:window.__fixturePlayback,fullscreen_kind:'none',
      media_id:'abcdefghijk',rendered_frames:0,mode:'native'}),
  };
  navigator.mediaDevices.getUserMedia=async()=>{window.__fixtureMicRequests++;throw new Error('Fixture must not request microphone');};
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(...args)=>{
    const url=typeof args[0]==='string'?args[0]:args[0]?.url||'';
    const isPlan=new URL(url,location.href).pathname==='/api/teslamon/plan';
    if(isPlan)window.__fixturePlanRequests++;
    const response=await nativeFetch(...args);
    if(isPlan)window.__fixturePlanResponses++;
    return response;
  };
};
const fixtureBootstrapScript='<script>('+fixtureBootstrap.toString()+')();</script>';
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript',
  '.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.wasm':'application/wasm'};
const fakeHandsFree=String.raw`
export function createTeslaMonHandsFree({onState,onAudio}={}){
  let enabled=false,state='off',invocation=0,activeController=null;
  const emit=update=>{state=update.state;globalThis.__fixtureWakeState=state;onState?.(update);};
  globalThis.__auraWake=keyword=>{
    if(!enabled||state!=='listening')return;
    let selected=['hey_jarvis','alexa','hey_mycroft','hey_rhasspy'];
    try{const stored=JSON.parse(localStorage.getItem('ytStreamerTeslaMonWakePhrasesV1')||'null');if(Array.isArray(stored))selected=stored;}catch{}
    if(!selected.includes(keyword))return;
    globalThis.__fixturePlayback='paused';
    const invocationId=++invocation;
    emit({state:'preparing',keyword,invocationId,message:'Pausing before recording'});
    emit({state:'recording',keyword,invocationId,message:'Recording one command'});
  };
  // Test-only fresh accepted wake. Used solely to model B arriving while A's
  // already-dispatched planner request is pending; it never submits audio.
  globalThis.__auraNewInvocation=keyword=>{
    if(!enabled)return false;
    let selected=['hey_jarvis','alexa','hey_mycroft','hey_rhasspy'];
    try{const stored=JSON.parse(localStorage.getItem('ytStreamerTeslaMonWakePhrasesV1')||'null');if(Array.isArray(stored))selected=stored;}catch{}
    if(!selected.includes(keyword))return false;
    globalThis.__fixturePlayback='paused';
    const invocationId=++invocation;
    emit({state:'preparing',keyword,invocationId,message:'Fixture accepted a new wake'});
    emit({state:'recording',keyword,invocationId,message:'Fixture wake ready; no second command submitted'});
    return invocationId;
  };
  globalThis.__auraProcessing=()=>emit({state:'processing',invocationId:invocation,message:'Processing'});
  globalThis.__auraRecover=()=>{
    emit({state:'recovering',invocationId:invocation,message:'Pause failed'});
    emit({state:'cooldown',invocationId:invocation,message:'Pause timed out · rearming…'});
  };
  globalThis.__auraVoiceSubmit=async()=>{
    if(!enabled||state!=='recording')return false;
    const submittedInvocation=invocation;
    const controller=new AbortController();
    activeController=controller;
    globalThis.__fixturePendingVoice=null;
    emit({state:'processing',invocationId:submittedInvocation,message:'Transcribing'});
    try{await onAudio(new Blob(['fixture-command'],{type:'audio/webm'}),{
      signal:controller.signal,invocationId:submittedInvocation,
      isCurrent:()=>enabled&&!controller.signal.aborted,
    });}finally{
      if(activeController===controller)activeController=null;
      if(enabled){emit({state:'cooldown',invocationId:submittedInvocation,message:'Rearming'});
        emit({state:'listening',invocationId:submittedInvocation,message:'Wake ready'});}
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
      return {text:globalThis.__fixtureSpeechText??'turn on office lights'};
    },
    async setModel(value){selectedModelId=value;},cancelPending(){},dispose(){}};
}
`;
const server=http.createServer(async(req,res)=>{
  const requestUrl=new URL(req.url,'http://127.0.0.1');
  const pathname=requestUrl.pathname;
  if(pathname==='/__fixture/config'&&req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    try{fixtureScenario=JSON.parse(body).scenario||'ha_done';}catch{fixtureScenario='ha_done';}
    res.writeHead(204);res.end();return;
  }
  if(pathname==='/__fixture'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aura fixture controls</title>
      <style>body{font:16px system-ui;margin:16px}button{min-height:48px;margin:4px;padding:8px 14px}iframe{width:100%;height:75vh;border:1px solid #888}</style>
      <h1>Aura browser fixture</h1><p>Test-only controls. The framed page uses synthetic STT, media and planner responses; no microphone, HA or real playback.</p>
      <button data-action="mic">mockmicon</button><button data-action="wake">mockwake</button><button data-action="voice">mockvoice</button><button data-action="playing">mockplaying</button>
      <button data-action="search">mocksearch</button><button data-action="ha">mockha</button><button data-action="error">mockerror</button><button data-action="uncertain">mockuncertain</button>
      <button data-action="nospeech">mocknospeech</button><button data-action="cooldown">mockcooldown</button><button data-action="dismiss">mockdismiss</button>
      <output id="fixture-state" aria-live="polite">Waiting for the isolated app…</output>
      <iframe title="TeslaMon Aura fixture" src="/?ui=${requestUrl.searchParams.get('ui')==='new'?'new':'classic'}&fixture=1"></iframe>
      <script>const frame=document.querySelector('iframe');let scenario='ha_done';
      const set=async value=>{scenario=value;await fetch('/__fixture/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:value})});};
      document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{const w=frame.contentWindow;
        switch(button.dataset.action){case 'mic':w.document.querySelector('#tmWakeToggle')?.click();break;case 'wake':w.__auraWake('hey_jarvis');break;case 'voice':w.__fixtureSpeechText=scenario==='no_speech'?'':'play a video';w.__fixturePendingVoice=w.__auraVoiceSubmit();break;
        case 'playing':w.__fixturePlayback='playing';break;case 'search':await set('search_play');break;case 'ha':await set('ha_done');break;case 'error':await set('error');break;
        case 'uncertain':await set('uncertain');break;case 'nospeech':await set('no_speech');break;case 'cooldown':w.__auraStandby();break;case 'dismiss':w.document.querySelector('#tmAura')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));break;}
      });
      setInterval(()=>{try{const w=frame.contentWindow,d=w.document,a=d.querySelector('#tmAura'),rect=a?.getBoundingClientRect();
        document.querySelector('#fixture-state').textContent=['Aura visible: '+Boolean(a&&!a.hidden&&rect?.width>0),
          'phase: '+(a?.dataset.phase||'closed'),'status: '+(d.querySelector('#tmState')?.textContent||'loading'),
          'wake: '+(d.querySelector('#tmWakeState')?.textContent||'loading'),'playback: '+(w.__fixturePlayback||'idle'),
          'search/play: '+(w.__fixtureCalls?.search||0)+'/'+(w.__fixtureCalls?.play||0),'mic requests: '+(w.__fixtureMicRequests||0)].join(' · ');
      }catch{}} ,250);</script>`);return;
  }
  if(pathname==='/teslamon-handsfree.js'){
    res.writeHead(200,{'content-type':'text/javascript'});res.end(fakeHandsFree);return;
  }
  if(pathname==='/teslamon-local-stt.js'){
    res.writeHead(200,{'content-type':'text/javascript'});res.end(fakeLocalStt);return;
  }
  if(pathname.startsWith('/api/')){
    res.writeHead(200,{'content-type':'application/json'});
    const payload=pathname==='/api/teslamon/capabilities'?{codexAvailable:true,localTranscription:true}:
      pathname==='/api/teslamon/plan'?(['search_play','slow_play'].includes(fixtureScenario)?{status:'ok',tool:'search_and_play',args:{query:'fixture video'}}:
        ['error','slow_error'].includes(fixtureScenario)?{status:'failed',code:'codex_unavailable'}:
        fixtureScenario==='uncertain'?{status:'uncertain',code:'invalid_codex_reply'}:
        fixtureScenario==='slow_ha'?{status:'ha_done',action:'light_checked'}:
        fixtureScenario==='no_speech'?{status:'failed',code:'no_speech_detected'}:{status:'ha_done',action:'light_checked'}):
      pathname==='/api/teslamon/select-candidate'?{status:'selected',index:0}:
      pathname==='/api/playlists'?[]:{ok:true,items:[]};
    const respond=()=>res.end(JSON.stringify(payload));
    if(pathname==='/api/teslamon/plan'&&fixtureScenario.startsWith('slow_'))setTimeout(respond,1800);
    else respond();
    return;
  }
  const target=path.resolve(root,decodeURIComponent(pathname==='/'?'index.html':pathname.slice(1)));
  if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{
    let bytes=await fs.readFile(target);
    if((pathname==='/'||pathname==='/index.html')&&requestUrl.searchParams.get('fixture')==='1')
      bytes=Buffer.from(bytes.toString('utf8').replace('</head>',fixtureBootstrapScript+'</head>'));
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
if(process.env.TESLAMON_AURA_FIXTURE_ONLY==='1'){
  console.log('Aura test fixture ready at '+origin+'/__fixture');
  await new Promise(resolve=>{
    const stop=()=>server.close(()=>resolve());
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  });
  process.exit(0);
}
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
      await page.addInitScript(fixtureBootstrap);
      const plans=[];
      page.on('request',req=>{if(new URL(req.url()).pathname==='/api/teslamon/plan')plans.push(req.postDataJSON());});
      await fetch(origin+'/__fixture/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:'ha_done'})});
      await page.goto(origin+'/?ui='+ui,{waitUntil:'domcontentloaded'});
      await page.locator('#tmAuraToggle').waitFor({state:'attached'});
      await page.waitForFunction(()=>typeof window.__auraWake==='function');
      assert.equal(await page.locator('#tmAuraToggle').isChecked(),true);
      assert.equal(await page.locator('#tmAura').isHidden(),true);
      // Aura preference arms future wakes without taking over the screen.
      await page.locator('#tmFace').click();
      if(await page.locator('#tmWakeToggle').getAttribute('aria-pressed')==='true')
        await page.locator('#tmWakeToggle').click();
      assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'false');
      await page.locator('#tmAuraToggle').uncheck();
      await page.locator('#tmAuraToggle').check();
      assert.equal(await page.locator('#tmAura').isHidden(),true,'Aura On arms the overlay without taking over the screen');
      if(await page.locator('#tmAuraPreview').count()){
        await page.locator('#tmAuraPreview').click();
        assert.equal(await page.locator('#tmAura').isHidden(),true,'only an accepted selected wake may enter Aura');
      }
      assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'false');
      await page.locator('#tmWakeToggle').click();
      assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true');
      await page.evaluate(()=>window.__auraWake('unselected_fixture_phrase'));
      assert.equal(await page.locator('#tmAura').isHidden(),true,'unselected wake cannot open Aura');
      await page.evaluate(()=>window.__auraWake('hey_jarvis'));
      await page.locator('#tmAura').waitFor({state:'visible'});
      assert.notEqual(await page.evaluate(()=>document.activeElement?.id),'tmText','wake takeover never focuses the command field');
      assert.equal(await page.evaluate(()=>window.__fixtureMicRequests),0,'fixture wake uses no browser microphone capture');
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
      // Only a selected wake phrase enters Aura; a rejected phrase does not.
      assert.equal(await page.locator('#tmAura .ta-title').innerText(),'I am listening');
      assert.equal(await page.locator('#tmAura .ta-hint').innerText(),'What would you like me to do?');
      assert.equal(await page.locator('#tmAura .ta-header, #tmAura .ta-footer, #tmAura .ta-transcript').count(),0);
      if(width===390)assert.equal(measure.reducedMotion,'none');
      if(process.env.TESLAMON_AURA_SCREENSHOTS==='1'){
        await page.screenshot({path:'/tmp/teslamon-aura-'+ui+'-'+width+'x'+height+'.jpg',type:'jpeg',quality:60});
      }
      await page.locator('#tmAura').tap({position:{x:Math.min(30,width/4),y:Math.min(30,height/4)}});
      assert.equal(await page.locator('#tmAura').isHidden(),true);
      await page.evaluate(()=>window.__auraStandby());
      assert.equal(await page.locator('#tmAura').isHidden(),true,'standby cannot reopen a dismissed takeover');
      if(await page.locator('#tmPanel').isHidden())await page.locator('#tmFace').click();
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
      // A later selected wake reopens after presentation-only dismissal.
      await page.evaluate(()=>window.__auraWake('hey_jarvis'));
      await page.locator('#tmAura').waitFor({state:'visible'});
      assert.equal(await page.locator('#tmAura').getAttribute('data-phase'),'listening');
      await page.evaluate(()=>window.__auraProcessing());
      assert.equal(await page.locator('#tmAura').isVisible(),true,'Aura stays during request processing');
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
        const scenario=async value=>page.evaluate(async value=>{
          await fetch('/__fixture/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:value})});
        },value);
        const submitVoice=async text=>page.evaluate(async text=>{
          window.__fixtureSpeechText=text;
          if(window.__fixtureWakeState!=='listening')throw new Error('Fixture voice case started before wake rearmed: '+window.__fixtureWakeState);
          window.__auraWake('hey_jarvis');
          window.__fixturePendingVoice=window.__auraVoiceSubmit();
          return true;
        },text);
        const waitForVoiceReady=async()=>{
          await page.evaluate(()=>window.__fixturePendingVoice);
          await page.waitForFunction(()=>window.__fixtureWakeState==='listening',null,{timeout:5000});
        };
        // Accepted search-and-play handoff closes Aura while the player is
        // still buffering. It never waits for a playing frame to restore UI.
        await scenario('search_play');
        await submitVoice('play a fixture video');
        await page.waitForFunction(()=>document.querySelector('#tmText')?.value==='play a fixture video');
        await page.waitForFunction(()=>document.querySelector('#tmState')?.textContent?.includes('Video selected'),null,{timeout:7000});
        await page.locator('#tmAura').waitFor({state:'hidden',timeout:4000});
        assert.equal(await page.evaluate(()=>window.__fixturePlayback),'buffering');
        assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true','accepted handoff keeps mic enabled');
        assert.equal(await page.evaluate(()=>window.__fixtureCalls.search),1,'one media search per accepted transcript');
        assert.equal(await page.evaluate(()=>window.__fixtureCalls.play),1,'one play dispatch per accepted transcript');
        if(process.env.TESLAMON_AURA_SCREENSHOTS==='1')
          await page.screenshot({path:'/tmp/teslamon-aura-handoff-buffering.jpg',type:'jpeg',quality:70});
        await page.waitForTimeout(2200);
        assert.equal(plans.length,2,'accepted handoff does not duplicate planner request');
        assert.equal(await page.evaluate(()=>window.__fixtureCalls.play),1,'buffering observation does not replay media');
        await waitForVoiceReady();

        // Terminal non-player outcomes, no speech, and cooldown all release
        // takeover. They leave Aura armed so a later accepted wake can return.
        for(const [mode,text] of [['ha_done','turn on office lights'],['error','turn on office lights'],
          ['uncertain','turn on office lights'],['no_speech','']]){
          await scenario(mode);
          await submitVoice(text);
          const terminalStatus={ha_done:'Home Assistant light',error:'Codex CLI is unavailable',
            uncertain:'Result uncertain',no_speech:'No words recognized'}[mode];
          await page.waitForFunction(status=>document.querySelector('#tmState')?.textContent?.includes(status),terminalStatus,{timeout:9000});
          await page.locator('#tmAura').waitFor({state:'hidden',timeout:9000});
          assert.equal(await page.locator('#tmWakeToggle').getAttribute('aria-pressed'),'true',mode+' keeps wake enabled');
          await waitForVoiceReady();
        }
        await page.evaluate(()=>{window.__auraWake('hey_jarvis');window.__auraProcessing();window.__auraStandby();});
        await page.locator('#tmAura').waitFor({state:'hidden',timeout:4000});
        await page.evaluate(()=>window.__auraWake('alexa'));
        await page.locator('#tmAura').waitFor({state:'visible'});
        await page.locator('#tmAura').tap();
        await page.evaluate(()=>window.__auraStandby());
        assert.equal(await page.locator('#tmAura').isHidden(),true,'dismissal leaves wake armed for the next wake');

        // A delayed completion for A must not close the fresh B wake screen.
        for(const mode of ['slow_ha','slow_play','slow_error']){
          await scenario(mode);
          const beforeA=await page.evaluate(()=>({responses:window.__fixturePlanResponses,
            requests:window.__fixturePlanRequests,plays:window.__fixtureCalls.play}));
          await submitVoice('turn on hallway lights');
          await page.waitForFunction(count=>window.__fixturePlanRequests>count,beforeA.requests,{timeout:7000});
          const invocationB=await page.evaluate(()=>window.__auraNewInvocation('alexa'));
          assert.ok(invocationB>0,'fresh B invocation created while A planner response is pending');
          await page.locator('#tmAura').waitFor({state:'visible'});
          await page.waitForFunction(count=>window.__fixturePlanResponses>count,beforeA.responses,{timeout:5000});
          await waitForVoiceReady();
          assert.equal(await page.locator('#tmAura').isVisible(),true,mode+': late A cannot close B');
          assert.equal(await page.locator('#tmAura').getAttribute('data-phase'),'listening','B keeps its own phase');
          assert.equal(await page.evaluate(()=>window.__fixtureCalls.play),beforeA.plays,mode+': stale A cannot dispatch playback');
          assert.equal(await page.locator('#tmText').inputValue(),'turn on hallway lights',mode+': stale A cannot clear the newer same-text draft');
          await page.evaluate(()=>{window.__auraStandby();document.querySelector('#tmText').value='';});
          await page.locator('#tmAura').waitFor({state:'hidden',timeout:4000});
        }
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
    const destination=path.resolve(root,'../docs/teslamon-aura-completion-evidence-20261029/layout.json');
    await fs.mkdir(path.dirname(destination),{recursive:true});
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
