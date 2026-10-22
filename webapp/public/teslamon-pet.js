import {interpretTeslaMon} from './teslamon-intent.js';
import {createTeslaMonCapture} from './teslamon-capture.js';
import {bindTeslaMonCaptureButton} from './teslamon-capture-binding.js';
import {createTeslaMonPetLifecycle} from './teslamon-pet-lifecycle.js';
import {calculateTeslaMonPetPosition} from './teslamon-pet-position.js';

if(['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'){
  const pet=document.createElement('aside');
  pet.id='teslamonPet';
  pet.setAttribute('aria-label','TeslaMon playback assistant');
  pet.innerHTML=[
    '<div class="tm-shell">',
      '<button type="button" id="tmHandle" aria-label="Move TeslaMon" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight">⠿</button>',
      '<button type="button" id="tmFace" aria-expanded="false" aria-controls="tmPanel">',
        '<span class="tm-ears" aria-hidden="true">◢ ◣</span>',
        '<span class="tm-eyes" aria-hidden="true">● ●</span>',
        '<span class="tm-mouth" aria-hidden="true">⌣</span>',
      '</button>',
    '</div>',
    '<section class="tm-panel" id="tmPanel" hidden aria-label="TeslaMon controls">',
      '<div class="tm-head"><strong>TeslaMon</strong>',
        '<button id="tmResetPosition" type="button">Reset position</button>',
        '<button id="tmClose" type="button" aria-label="Close">×</button></div>',
      '<p id="tmState" role="status" aria-live="polite">Choose a connected player.</p>',
      '<div class="tm-target"><label for="tmDevices">Playback browser</label>',
        '<select id="tmDevices"><option value="">Choose connected browser</option></select>',
        '<button id="tmRefresh" type="button" aria-label="Refresh browsers">↻</button></div>',
      '<form id="tmForm"><label class="tm-visually-hidden" for="tmText">Command</label>',
        '<input id="tmText" type="text" autocomplete="off" maxlength="220"',
        ' placeholder="Play a video, pause, resume…" />',
        '<button id="tmSend" type="submit">Send</button></form>',
      '<label id="tmModelLabel" hidden><input id="tmModelOptIn" type="checkbox" />',
        'Use optional AI for unmatched phrases (separate API charges may apply)</label>',
      '<div class="tm-actions">',
        '<button id="tmCancel" type="button">Cancel current input</button>',
        '<button id="tmMic" type="button">Hold to talk</button>',
        '<button type="button" data-tm="pause">Pause</button>',
        '<button type="button" data-tm="resume">Resume</button>',
        '<button type="button" data-tm="get_playback_state">Status</button>',
        '<button type="button" data-tm="request_fullscreen">Fullscreen</button>',
        '<button type="button" data-tm="exit_fullscreen">Exit fullscreen</button>',
      '</div>',
      '<div id="tmChoices" role="group" aria-label="Video results" hidden></div>',
      '<p id="tmHelp">Enable AI playback in the existing YT Streamer panel',
        ' on the browser you want to control. TeslaMon uses the same Cloudflare login.</p>',
    '</section>'
  ].join('');
  document.body.append(pet);
  const $=id=>pet.querySelector(id);
  const face=$('#tmFace'),handle=$('#tmHandle'),panel=$('#tmPanel'),
    state=$('#tmState'),devices=$('#tmDevices'),mic=$('#tmMic'),
    input=$('#tmText'),choices=$('#tmChoices'),
    modelLabel=$('#tmModelLabel'),modelOptIn=$('#tmModelOptIn'),cancelButton=$('#tmCancel');
  handle.setAttribute('aria-keyshortcuts','ArrowUp ArrowDown ArrowLeft ArrowRight');
  const KEY='ytStreamerTeslaMonPetPositionV1';
  let selected=null,enabled=false,busy=false,modelBusy=false,opened=false,
    captureBinding=null,speech=null,speechMode=null,generation=0,micEpoch=0,
    selectionBusy=false,selectionVersion=0,selectionQueue=Promise.resolve(),
    nativeSpeechEngine=null,nativeSpeechTimer=null,selectionInFlight=0,selectionDesired=null,
    selectionCleared=false;
  let activeCapture=null;
  const pendingInputs=new Set();
  const lifecycle=createTeslaMonPetLifecycle();

  function status(message,type='info'){
    state.textContent=message;state.dataset.kind=type;face.dataset.state=type;
  }
  function syncCancel(){cancelButton.disabled=!pendingInputs.size&&!busy&&!modelBusy;}
  function clearChoices(){choices.replaceChildren();choices.hidden=true;}
  function report(response,tool){
    clearChoices();
    if(response?.status==='needs_selection'){
      const title=document.createElement('p');title.textContent='Choose a video:';
      choices.append(title);
      for(const item of response.choices||[]){
        const button=document.createElement('button');
        button.className='tm-choice';button.type='button';
        button.textContent=item.title+(item.creator?' — '+item.creator:'');
        button.addEventListener('click',()=>void issue({
          tool:'search_and_play',args:{candidate_token:item.candidate_token}
        }));
        choices.append(button);
      }
      choices.hidden=false;
      status('Multiple matches. Choose one result.');return;
    }
    const phase=response?.playbackPhase;
    if(response?.status==='observed'){
      if(tool==='request_fullscreen'&&['in_page','native'].includes(response.fullscreenMode)){
        status('Fullscreen enabled on selected browser.','ok');return;
      }
      if(tool==='exit_fullscreen'&&response.fullscreenMode==='none'){
        status('Fullscreen exited on selected browser.','ok');return;
      }
      const title=typeof response.title==='string'?' · '+response.title:'';
      const screen=response.fullscreenStatus==='needs_user_gesture'?
        ' Use the Fullscreen button on the selected player.':
        response.fullscreenStatus==='unsupported'?' Fullscreen is unavailable on this player.':'';
      status((phase==='playing'?'Playing':phase==='paused'?'Paused':
        'Player state: '+(phase||'available'))+title+screen,'ok');
    }else if(response?.status==='accepted')status('Command sent. Confirm playback on the player.');
    else if(response?.status==='uncertain')status('Result uncertain. Check player before retrying.','warn');
    else if(response?.status==='needs_user_gesture')status('Use the Fullscreen button in the selected browser.','warn');
    else if(response?.status==='offline')status('Selected browser is offline. Reconnect and reselect it.','warn');
    else if(response?.status==='unsupported')status('Not supported by this player.','warn');
    else{
      const reasons={
        local_stt_not_configured:'Local speech transcription is not configured.',
        signed_access_required:'Open YT Streamer through your Cloudflare sign-in.',
        teslamon_unavailable:'TeslaMon is not enabled on this server.',
        unreconciled_prior_mutation:'An earlier action is uncertain. Reconcile before sending another.',
        target_busy:'Another command is running.',
        stale_or_unknown_candidate:'Selection expired. Search again.',
        no_speech_detected:'No speech detected. Try again or type your command.'
      };
      status(reasons[response?.code]||('Command failed: '+(response?.code||'unknown')),'warn');
    }
  }
  async function post(url,data,contentType='application/json',signal){
    const answer=await fetch(url,{
      method:'POST',credentials:'same-origin',mode:'same-origin',
      cache:'no-store',redirect:'error',headers:{
        'Content-Type':contentType,
        'X-Requested-With':'XMLHttpRequest'
      },
      body:contentType==='application/json'?JSON.stringify(data):data,
      ...(signal?{signal}:{})
    });
    if(answer.status===401||answer.status===403)
      return {status:'failed',code:'signed_access_required'};
    try{
      const result=await answer.json();
      if(answer.status===503&&result?.status==='unavailable')
        return result;
      return result;
    }catch{return {status:'failed',code:'invalid_server_reply'};}
  }
  async function issue(intent){
    if(busy){status('Wait for the current command.','warn');return;}
    if(!opened||document.hidden||!enabled||!selected||selectionBusy){status('Select a connected browser first.','warn');return;}
    busy=true;syncCancel();const epoch=++generation,target=selected,targetEpoch=micEpoch;
    status('Sending command…');
    try{const result=await post('/api/teslamon/command',intent);
      if(epoch===generation&&target===selected&&targetEpoch===micEpoch&&opened)report(result,intent.tool);
    }catch{
      if(epoch===generation&&target===selected&&targetEpoch===micEpoch&&opened)
        status('Network error. Playback outcome is uncertain.','warn');
    }finally{busy=false;syncCancel();}
  }
  async function interpret(text){
    if(!opened||document.hidden||!enabled||!selected||selectionBusy)return;
    const command=interpretTeslaMon(text);
    if(!command.error){input.value='';void issue(command);return;}
    if(!modelOptIn.checked||modelLabel.hidden){
      status(command.error,'warn');return;
    }
    if(modelBusy||busy){status('A command is already being processed.','warn');return;}
    modelBusy=true;const target=selected,epoch=micEpoch,request=lifecycle.begin('interpret');
    pendingInputs.add(request);syncCancel();
    status('Interpreting command with optional AI…');
    try{
      const result=await post('/api/teslamon/interpret',{text,optIn:true},'application/json',request.signal);
      if(!request.current()||target!==selected||epoch!==micEpoch||!opened)return;
      if(result.status==='ok'&&typeof result.tool==='string'){
        input.value='';void issue({tool:result.tool,args:result.args});
      }else report(result);
    }catch{if(request.current()&&target===selected&&epoch===micEpoch&&opened)
      status('Model interpretation unavailable. Use a direct playback command.','warn');}
    finally{const current=request.current();request.finish();if(current)modelBusy=false;pendingInputs.delete(request);syncCancel();}
  }
  function cancelMic(){
    micEpoch++;
    lifecycle.cancel('interpret');lifecycle.cancel('transcribe');
    modelBusy=false;
    captureBinding?.targetChanged();
    try{activeCapture?.cancel();}catch{}
    cancelNativeSpeech();
    pendingInputs.clear();syncCancel();
  }
  function cancelCurrentInput(){
    const hadPending=pendingInputs.size>0||modelBusy||Boolean(speech);
    cancelMic();
    if(busy){status('Input canceled. A playback command was already sent. Its result is uncertain; check the selected player before retrying.','warn');return;}
    status(hadPending?'Input canceled. No playback command was sent.':'No input is in progress.');
  }
  function cancelNativeSpeech(){
    if(nativeSpeechTimer!==null){clearTimeout(nativeSpeechTimer);nativeSpeechTimer=null;}
    const session=speech;
    if(!session)return;
    session.cancelled=true;speech=null;pendingInputs.delete(session);syncCancel();
    try{session.abort();}catch{try{session.stop();}catch{}}
  }
  async function refresh(){
    if(selectionBusy)return;
    cancelMic();clearChoices();selected=null;enabled=false;
    const request=lifecycle.begin('refresh');
    try{
      const result=await post('/api/teslamon/devices',{},'application/json',request.signal);
      if(!request.current()||!opened||selectionBusy)return;
      enabled=result.enabled===true;
      if(!enabled){
        if(selected!==null)cancelMic();
        selected=null;devices.replaceChildren(new Option('No available players',''));
        devices.disabled=true;mic.disabled=true;
        report(result);return;
      }
      devices.disabled=false;
      devices.replaceChildren(new Option('Choose connected browser',''),
        ...(result.devices||[]).map(v=>new Option(v.label,v.deviceKey)));
      const target=result.selectedDeviceKey;
      const nextSelected=!selectionCleared&&(result.devices||[]).some(v=>v.deviceKey===target)?target:null;
      if(nextSelected!==selected)cancelMic();
      if(nextSelected){devices.value=nextSelected;selected=nextSelected;}
      else{devices.value='';selected=null;}
      modelLabel.hidden=result.modelConfigured!==true;
      if(modelLabel.hidden)modelOptIn.checked=false;
      if(result.localTranscription)setupRecorder();
      else setupNativeSpeech();
      status(!result.devices?.length?'Enable AI playback on a browser and refresh.':
        selected?'Ready. Speak or type a playback command.':
        'Choose which connected browser to control.',selected?'ok':'info');
    }catch{if(request.current()&&opened)
      status('TeslaMon connection unavailable. Check network and sign-in.','warn');}
    finally{request.finish();}
  }
  async function choose(){
    cancelMic();clearChoices();selected=null;
    const deviceKey=devices.value;
    const version=++selectionVersion;
    selectionDesired=deviceKey||'';
    if(!deviceKey){
      selectionCleared=true;selectionBusy=selectionInFlight>0;
      status('Choose a browser.');return;
    }
    selectionCleared=false;
    selectionBusy=true;status('Selecting browser…');
    const run=selectionQueue.then(async()=>{
      if(version!==selectionVersion){
        if(selectionDesired===''&&selectionInFlight===0)selectionBusy=false;
        return;
      }
      const request=lifecycle.begin('select');
      selectionInFlight++;
      try{
        const result=await post('/api/teslamon/select',{deviceKey});
        if(version!==selectionVersion||!request.current()||!opened||devices.value!==deviceKey)return;
        if(result.status==='selected'){
          selected=deviceKey;status('Browser selected. Ready.','ok');
        }else{report(result);selectionQueue.finally(()=>{
          if(version===selectionVersion&&opened)refreshWhenReady();
        });}
      }catch{if(version===selectionVersion&&request.current()&&opened&&devices.value===deviceKey)
        status('Selection request failed.','warn');}
      finally{
        request.finish();
        selectionInFlight--;
        if(version===selectionVersion)selectionBusy=false;
        else if(selectionDesired===''&&selectionInFlight===0)selectionBusy=false;
      }
    });
    selectionQueue=run.catch(()=>{});
  }
  function refreshWhenReady(){
    if(selectionBusy){selectionQueue.finally(()=>{if(opened)void refresh();});return;}
    void refresh();
  }
  function setupRecorder(){
    if(speechMode==='local')return;
    cancelNativeSpeech();
    speechMode='local';
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){
      speechMode=null;setupNativeSpeech();return;
    }
    mic.disabled=false;mic.textContent='Hold to talk';
    const capture=createTeslaMonCapture({
      getUserMedia:c=>{
        if(!opened||document.hidden||!enabled||!selected||selectionBusy)
          return Promise.reject(new Error('Select a connected browser first.'));
        return navigator.mediaDevices.getUserMedia(c);
      },
      MediaRecorder:window.MediaRecorder,
      onState:value=>{
        if(!opened)return;
        if(['requesting','recording','stopping'].includes(value.state))pendingInputs.add(capture);
        else pendingInputs.delete(capture);syncCancel();
        if(value.state==='recording')status('Listening… release to transcribe.','ok');
        else if(value.state==='stopping')status('Transcribing locally…');
      },
      onAudio:blob=>{
        if(!selected||!enabled||!opened||document.hidden||selectionBusy)return;
        const before=selected,epoch=micEpoch,request=lifecycle.begin('transcribe');
        pendingInputs.add(request);syncCancel();
        void(async()=>{
          try{
            const reply=await post('/api/teslamon/transcribe',blob,blob.type,request.signal);
            if(!request.current()||before!==selected||epoch!==micEpoch||!opened)return;
            if(reply.status==='ok'&&typeof reply.text==='string'){
              input.value=reply.text;interpret(reply.text);
            }else report(reply);
          }catch{if(request.current()&&before===selected&&epoch===micEpoch&&opened)
            status('Transcription failed. Type a command.','warn');}
          finally{request.finish();pendingInputs.delete(request);syncCancel();}
        })();
      },
      onError:()=>{if(opened)status('Microphone error. Type a command or retry.','warn');}
    });
    activeCapture=capture;
    captureBinding?.dispose();
    captureBinding=bindTeslaMonCaptureButton({button:mic,capture,document,window,
      onError:()=>status('Microphone unavailable.','warn')});
  }
  function startNativeSpeech(){
      if(speechMode!=='native'||!selected||!enabled||!opened||document.hidden||selectionBusy)return;
      if(speech){
        const session=speech;
        try{session.stop();}
        catch{
          if(speech===session){cancelNativeSpeech();if(opened)
            status('Speech input failed. Type a command or retry.','warn');}
        }
        return;
      }
      let transcript='';
      const before=selected,epoch=micEpoch;
      let session;
      try{session=new nativeSpeechEngine();}
      catch{status('Speech recognition unavailable. Type a command or retry.','warn');return;}
      speech=session;
      session.lang='en-US';session.continuous=false;session.interimResults=false;
      session.onresult=event=>{if(speech===session&&!session.cancelled&&epoch===micEpoch&&opened&&before===selected)
        transcript=event.results?.[0]?.[0]?.transcript?.trim()||'';};
      session.onerror=()=>{if(speech===session&&!session.cancelled&&epoch===micEpoch&&opened)
        status('Speech input failed. Type a command or retry.','warn');};
      session.onend=()=>{
        if(speech!==session||session.cancelled)return;
        speech=null;
        if(nativeSpeechTimer!==null){clearTimeout(nativeSpeechTimer);nativeSpeechTimer=null;}
        pendingInputs.delete(session);syncCancel();
        if(transcript&&before===selected&&epoch===micEpoch&&opened)interpret(transcript);
        else if(before===selected&&epoch===micEpoch&&opened)status('No speech recognized. Try again or type.','warn');
      };
      try{
        session.start();
        if(speech!==session)return;
        pendingInputs.add(session);syncCancel();
        nativeSpeechTimer=setTimeout(()=>{
          if(speech!==session)return;
          cancelNativeSpeech();
          if(epoch===micEpoch&&opened&&before===selected)
            status('Speech timed out after 20 seconds. Try again or type your command.','warn');
        },20000);
        status('Listening… tap again to stop.','ok');
      }catch{
        if(speech===session)cancelNativeSpeech();
        pendingInputs.delete(session);syncCancel();
        if(epoch===micEpoch&&opened)status('Speech recognition unavailable. Type a command or retry.','warn');
      }
  }
  function setupNativeSpeech(){
    if(speechMode==='native')return;
    if(captureBinding){captureBinding.dispose();captureBinding=null;}
    speechMode='native';
    nativeSpeechEngine=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!nativeSpeechEngine){
      mic.disabled=true;mic.title='Speech input unsupported here. Type a command.';
      return;
    }
    mic.disabled=false;mic.textContent='Tap to speak';
  }
  mic.addEventListener('click',startNativeSpeech);
  function viewportMetrics(){
    const vv=window.visualViewport;
    return {width:vv?.width||innerWidth,height:vv?.height||innerHeight,
      offsetLeft:vv?.offsetLeft||0,offsetTop:vv?.offsetTop||0};
  }
  function safeInsets(){
    const style=getComputedStyle(pet);
    const read=name=>parseFloat(style.getPropertyValue(name))||0;
    return {top:read('--tm-safe-top'),right:read('--tm-safe-right'),
      bottom:read('--tm-safe-bottom'),left:read('--tm-safe-left')};
  }
  function calculatePosition(saved=null,reset=false){
    const vv=viewportMetrics(),bounds=pet.getBoundingClientRect();
    const panelWidth=Math.min(336,Math.max(200,vv.width-safeInsets().left-safeInsets().right));
    const panelHeight=Math.min(650,Math.max(150,panel.scrollHeight||420));
    return calculateTeslaMonPetPosition({viewport:vv,safeArea:safeInsets(),
      pet:{width:pet.offsetWidth||bounds.width||128,height:pet.offsetHeight||bounds.height||72},
      panel:{width:panelWidth,height:panelHeight},saved,reset});
  }
  function savePosition(){try{localStorage.setItem(KEY,JSON.stringify({x:pet.offsetLeft,y:pet.offsetTop}));}catch{}}
  function applyPosition(saved=null,reset=false,persist=false){
    const p=calculatePosition(saved,reset);
    pet.style.left=p.petLeft+'px';pet.style.top=p.petTop+'px';
    pet.style.right='auto';pet.style.bottom='auto';
    panel.style.left=(p.panelLeft-p.petLeft)+'px';panel.style.top=(p.panelTop-p.petTop)+'px';
    panel.style.right='auto';panel.style.bottom='auto';panel.style.width=p.panelWidth+'px';
    panel.style.maxHeight=Math.min(650,p.panelMaxHeight)+'px';
    if(persist)savePosition();
  }
  function alignPanel(){applyPosition({x:pet.offsetLeft,y:pet.offsetTop});}
  function setPosition(x,y,persist=false){applyPosition({x,y},false,persist);}
  let drag=null;
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const bounds=pet.getBoundingClientRect();
    drag={id:event.pointerId,dx:event.clientX-bounds.left,dy:event.clientY-bounds.top};
    try{handle.setPointerCapture(event.pointerId);}catch{}
  });
  handle.addEventListener('pointermove',event=>{
    if(drag&&drag.id===event.pointerId)
      setPosition(event.clientX-drag.dx,event.clientY-drag.dy);
  });
  handle.addEventListener('pointerup',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    drag=null;
    savePosition();
  });
  handle.addEventListener('pointercancel',()=>{drag=null;});
  handle.addEventListener('keydown',event=>{
    const amount=event.shiftKey?1:16;
    const bounds=pet.getBoundingClientRect();
    const deltas={ArrowUp:[0,-amount],ArrowDown:[0,amount],ArrowLeft:[-amount,0],ArrowRight:[amount,0]};
    if(event.key==='Home'){
      event.preventDefault();applyPosition(null,true,true);status('TeslaMon position reset.');return;
    }
    const delta=deltas[event.key];if(!delta)return;
    event.preventDefault();setPosition(bounds.left+delta[0],bounds.top+delta[1],true);
  });
  $('#tmResetPosition').addEventListener('click',()=>{applyPosition(null,true,true);status('TeslaMon position reset.');});
  cancelButton.addEventListener('click',cancelCurrentInput);
  try{
    const old=JSON.parse(localStorage.getItem(KEY)||'null');
    applyPosition(Number.isFinite(old?.x)&&Number.isFinite(old?.y)?old:null);
  }catch{}
  const reposition=()=>applyPosition({x:pet.offsetLeft,y:pet.offsetTop});
  window.addEventListener('resize',reposition);
  window.visualViewport?.addEventListener('resize',reposition);
  window.visualViewport?.addEventListener('scroll',reposition);
  // Container fullscreen excludes siblings in the top layer. Keep controls
  // with that container; video-only native fullscreen cannot host DOM overlays.
  document.addEventListener('fullscreenchange',()=>{
    const target=document.fullscreenElement;
    if(target&&!['VIDEO','AUDIO','IFRAME'].includes(target.tagName))target.append(pet);
    else document.body.append(pet);
    reposition();
  });
  window.addEventListener('blur',cancelMic);
  face.addEventListener('click',()=>{
    opened=!opened;panel.hidden=!opened;
    face.setAttribute('aria-expanded',String(opened));
    if(opened){selectionCleared=false;alignPanel();refreshWhenReady();input.focus();}
    else{cancelMic();selected=null;enabled=false;lifecycle.cancel('refresh');}
  });
  $('#tmClose').addEventListener('click',()=>{
    opened=false;panel.hidden=true;face.setAttribute('aria-expanded','false');
    cancelMic();selected=null;enabled=false;lifecycle.cancel('refresh');face.focus();
  });
  $('#tmRefresh').addEventListener('click',refreshWhenReady);
  devices.addEventListener('change',()=>void choose());
  $('#tmForm').addEventListener('submit',event=>{
    event.preventDefault();interpret(input.value);
  });
  pet.querySelectorAll('[data-tm]').forEach(button=>
    button.addEventListener('click',()=>void issue({
      tool:button.dataset.tm,args:{}
    })));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelMic();selected=null;enabled=false;lifecycle.cancel('refresh');}
    else if(opened)refreshWhenReady();
  });
  window.addEventListener('pagehide',()=>{
    opened=false;panel.hidden=true;face.setAttribute('aria-expanded','false');
    cancelMic();selected=null;enabled=false;lifecycle.cancelAll();
    captureBinding?.dispose();captureBinding=null;speechMode=null;
    cancelNativeSpeech();
  });
}
