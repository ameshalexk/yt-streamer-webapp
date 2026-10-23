import {createTeslaMonLocalPlayer} from './teslamon-local-player.js?v=20261023-first-result1';
import {createTeslaMonCapture} from './teslamon-capture.js';
import {convertTeslaMonAudioToWav} from './teslamon-wav-fallback.js';
import {bindTeslaMonCaptureButton} from './teslamon-capture-binding.js';

if(['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'){
  const pet=document.createElement('aside');
  pet.id='teslamonPet';
  pet.setAttribute('aria-label','TeslaMon playback assistant');
  pet.innerHTML=[
    '<div class="tm-shell">',
      '<button type="button" id="tmHandle" aria-label="Drag TeslaMon to move">⠿</button>',
      '<button type="button" id="tmFace" aria-expanded="false" aria-controls="tmPanel">',
        '<span class="tm-ears" aria-hidden="true">◢ ◣</span>',
        '<span class="tm-eyes" aria-hidden="true">● ●</span>',
        '<span class="tm-mouth" aria-hidden="true">⌣</span>',
      '</button>',
    '</div>',
    '<section class="tm-panel" id="tmPanel" hidden aria-label="TeslaMon controls">',
      '<div class="tm-head"><strong>TeslaMon</strong>',
        '<button id="tmClose" type="button" aria-label="Close">×</button></div>',
      '<p id="tmState" role="status" aria-live="polite">Connecting to this tab…</p>',
      '<div class="tm-target tm-self-target" aria-label="Playback target">',
        '<span>Controls this browser tab only</span></div>',
      '<form id="tmForm"><label class="tm-visually-hidden" for="tmText">Command</label>',
        '<input id="tmText" type="text" autocomplete="off" maxlength="220"',
        ' placeholder="Play video or control lights…" />',
        '<button id="tmSend" type="submit">Send</button></form>',
      '<label id="tmModelLabel" hidden><input id="tmModelOptIn" type="checkbox" />',
        'Use optional AI for unmatched phrases (separate API charges may apply)</label>',
      '<div class="tm-actions">',
        '<button id="tmMic" type="button">Hold to talk</button>',
        '<button type="button" data-tm="pause">Pause</button>',
        '<button type="button" data-tm="resume">Resume</button>',
        '<button type="button" data-tm="get_playback_state">Status</button>',
        '<button type="button" data-tm="request_fullscreen">Fullscreen</button>',
        '<button type="button" data-tm="exit_fullscreen">Exit fullscreen</button>',
      '</div>',
      '<p id="tmHelp">Codex handles video requests in this tab and Home Assistant lights. No remote tab selection,',
        ' device pairing, or separate Cloudflare login is required.</p>',
    '</section>'
  ].join('');
  document.body.append(pet);
  const $=id=>pet.querySelector(id);
  const face=$('#tmFace'),handle=$('#tmHandle'),panel=$('#tmPanel'),
    state=$('#tmState'),mic=$('#tmMic'),
    input=$('#tmText'),
    modelLabel=$('#tmModelLabel'),modelOptIn=$('#tmModelOptIn');
  const KEY='ytStreamerTeslaMonPetPositionV1';
  // Secure per-page session, never stored or shared with another tab.
  const tabSession=typeof crypto.randomUUID==='function'?crypto.randomUUID():
    (()=>{const b=crypto.getRandomValues(new Uint8Array(16));
      b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
      const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
      return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');})();
  const localPlayer=createTeslaMonLocalPlayer();
  let selected=null,enabled=false,busy=false,modelBusy=false,opened=false,
    captureBinding=null,speech=null,speechMode=null,generation=0,micEpoch=0;

  function status(message,type='info'){
    state.textContent=message;state.dataset.kind=type;face.dataset.state=type;
  }
  function report(response,action){
    const phase=response?.playbackPhase;
    if(response?.status==='observed'){
      if(action==='request_fullscreen'||action==='exit_fullscreen'){
        status(response.fullscreenMode==='none'?'Fullscreen exited.':
          'Fullscreen enabled in this tab.','ok');return;
      }
      const playback=phase==='playing'?'Playing in this tab':
        phase==='paused'?'Paused':('Player state: '+(phase||'available'));
      const fullscreen=response.fullscreenAttempt==='needs_user_gesture'?
        ' Tap Fullscreen directly in this tab.':
        response.fullscreenAttempt==='observed'?' Fullscreen enabled.':'';
      status(playback+fullscreen,'ok');
    }else if(response?.status==='accepted'){
      status('Command sent. Confirm playback on the player.'+
        (response.fullscreenAttempt==='needs_user_gesture'?
          ' Tap Fullscreen directly in this tab.':''));
    }
    else if(response?.status==='uncertain')status('Result uncertain. Check player before retrying.','warn');
    else if(response?.status==='needs_user_gesture')status('Tap Fullscreen directly in this tab.','warn');
    else if(response?.status==='offline')status('This tab player is unavailable. Reload the page.','warn');
    else if(response?.status==='unsupported')
      status(response.code==='unsupported_voice_command'?
        'TeslaMon controls this tab and Home Assistant lights.':'Not supported by this player.','warn');
    else{
      const reasons={
        poweralx_worker_not_configured:'PowerALX transcription is not configured.',
        poweralx_worker_unavailable:'PowerALX worker did not finish the recording. Try voice again.',
        audio_normalization_failed:'iPhone audio could not be prepared for PowerALX. Try again.',
        normalized_audio_invalid:'The prepared iPhone recording was empty or too large.',
        normalized_audio_duration_mismatch:'PowerALX audio duration could not be verified.',
        poweralx_transcription_failed:'PowerALX could not transcribe this clip. Try again.',
        poweralx_timeout_or_cancelled:'PowerALX took too long. Try a shorter voice command.',
        poweralx_result_incomplete:'The transcript was incomplete. Please try again.',
        signed_access_required:'Open YT Streamer through your Cloudflare sign-in.',
        teslamon_unavailable:'TeslaMon is not enabled on this server.',
        unreconciled_prior_mutation:'An earlier action is uncertain. Reconcile before sending another.',
        target_busy:'Another command is running.',
        invalid_audio_payload:'Recording was empty or incomplete. Hold to talk for 2–3 seconds.',
        invalid_audio_container:'iPhone sent an unreadable audio recording. Try again or type a command.',
        invalid_audio_timing:'iPhone recording had no valid audio timing. Try again.',
        invalid_audio_duration:'Recording was too short or too long. Hold for 2–3 seconds.',
        iphone_wav_fallback_failed:'Safari sent unreadable MP4 audio and WAV conversion failed. Try again.',
        no_speech_detected:'No speech detected. Try again or type your command.',
        codex_busy:'Codex is processing another playback request.',
        codex_unavailable:'Codex CLI is unavailable. Quick buttons still work.',
        codex_timeout_or_cancelled:'Codex took too long. Try the request again.',
        codex_disallowed_tool:'Codex tried an unsupported tool. Nothing was executed.',
        unsupported_voice_command:'TeslaMon supports video playback and Home Assistant lights only.',
        invalid_codex_plan:'Codex returned an invalid playback command.',
        invalid_codex_reply:'Codex could not interpret that command.',
        ha_mcp_not_called:'Codex did not complete a Home Assistant light tool call.',
        home_assistant_unavailable:'Home Assistant light service is unavailable.'
      };
      status(reasons[response?.code]||('Command failed: '+(response?.code||'unknown')),'warn');
    }
  }
  async function post(url,data,contentType='application/json'){
    const answer=await fetch(url,{
      method:'POST',credentials:'same-origin',mode:'same-origin',
      cache:'no-store',redirect:'error',headers:{
        'Content-Type':contentType,
        'X-Requested-With':'XMLHttpRequest'
      },
      body:contentType==='application/json'?JSON.stringify(data):data
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
    if(!enabled||!localPlayer.ready){status('This page player is still loading.','warn');return;}
    busy=true;const epoch=++generation;
    status('Sending command…');
    try{const result=await localPlayer.run(intent);
      if(epoch===generation)report(result,intent.tool);
    }catch{
      if(epoch===generation)status('Playback failed unexpectedly. Check the player.','warn');
    }finally{busy=false;}
  }
  // Natural language (both typed and PowerALX voice transcript) always goes
  // through the signed Codex CLI planner. Direct buttons skip reasoning.
  async function interpret(text){
    const request=String(text||'').trim();
    if(request.length<1||request.length>220){
      status('Enter a playback request under 220 characters.','warn');return;
    }
    if(modelBusy||busy){status('A playback request is already running.','warn');return;}
    modelBusy=true;
    const target=selected,epoch=micEpoch;
    status('Codex is understanding your request…');
    try{
      const result=await post('/api/teslamon/plan',{text:request,session:tabSession});
      if(target!==selected||epoch!==micEpoch||!opened)return;
      if(result.status==='ok'&&typeof result.tool==='string'){
        input.value='';await issue({tool:result.tool,args:result.args||{}});
      }else if(result.status==='ha_done'){
        input.value='';
        status(result.action==='light_changed'?
          'Home Assistant light command completed.':'Home Assistant light state checked.','ok');
      }else report(result);
    }catch{status('Codex is unavailable. Quick controls still work.','warn');}
    finally{modelBusy=false;}
  }
  function cancelMic(){
    micEpoch++;
    captureBinding?.targetChanged();
    if(speech){speech.cancelled=true;try{speech.abort();}catch{}speech=null;}
  }
  async function refresh(){
    enabled=localPlayer.ready;
    // The current document's player is the only playback target.
    selected=enabled?'this_tab':null;
    if(!enabled){
      mic.disabled=true;
      status('This page player is loading. Refresh the page if it stays unavailable.','warn');
      return;
    }
    status('Ready to control this browser tab.','ok');
    // These are optional signed server capabilities, never remote targeting.
    try{
      const result=await post('/api/teslamon/capabilities',{});
      modelLabel.hidden=true;
      modelOptIn.checked=false;
      if(!result.codexAvailable){
        mic.disabled=true;mic.textContent='Codex unavailable';
        status('Codex CLI is unavailable. Quick controls still work.','warn');
        return;
      }
      if(result.localTranscription)setupRecorder();
      else {mic.disabled=true;mic.textContent='PowerALX unavailable';
        status('PowerALX transcription is not configured. Use typed commands.','warn');}
    }catch{
      modelLabel.hidden=true;
      modelOptIn.checked=false;
      mic.disabled=true;mic.textContent='Voice unavailable';
      status('Could not verify the PowerALX voice service. Use typed commands.','warn');
    }
  }
  function setupRecorder(){
    if(speechMode==='local')return;
    if(speech){speech.cancelled=true;try{speech.abort();}catch{}speech=null;}
    speechMode='local';
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){
      speechMode=null;mic.disabled=true;mic.textContent='Voice unavailable';
      status('Microphone capture is unsupported here. Use typed commands.','warn');return;
    }
    mic.disabled=false;mic.textContent='Hold to talk';
    const capture=createTeslaMonCapture({
      getUserMedia:c=>navigator.mediaDevices.getUserMedia(c),
      MediaRecorder:window.MediaRecorder,
      onState:value=>{
        if(value.state==='requesting')status('Requesting microphone access…');
        else if(value.state==='recording')status('Recording audio… release to finish.','ok');
        else if(value.state==='stopping')status('Finishing recording…');
        else if(value.state==='empty')status('No audio was captured. Hold the mic a little longer.','warn');
      },
      onAudio:blob=>{
        if(!localPlayer.ready)return;
        status('Audio captured. Sending to PowerALX…');
        const before=selected,epoch=micEpoch;
        void(async()=>{
          try{
            let reply=await post('/api/teslamon/transcribe',blob,blob.type);
            // Safari WebKit sometimes records MP4 with unusable container
            // metadata. Repair in the iPhone browser without re-recording,
            // cloud services or putting decoding/transcription on the Mac.
            if(blob.type?.split(';')[0]==='audio/mp4' &&
               ['invalid_audio','invalid_audio_container','invalid_audio_timing','invalid_audio_duration'].includes(reply?.code)){
              try{
                const wav=await convertTeslaMonAudioToWav(blob);
                if(before!==selected||epoch!==micEpoch||!opened)return;
                status('Converting iPhone audio for PowerALX…');
                reply=await post('/api/teslamon/transcribe',wav,wav.type);
              }catch{reply={status:'failed',code:'iphone_wav_fallback_failed'};}
            }
            if(before!==selected||epoch!==micEpoch||!opened)return;
            if(reply.status==='ok'&&typeof reply.text==='string'){
              input.value=reply.text;interpret(reply.text);
            }else report(reply);
          }catch{status('Transcription failed. Type a command.','warn');}
        })();
      },
      onError:error=>{
        const detail=String(error?.message||'').toLowerCase();
        const code=String(error?.name||'').toLowerCase();
        if(code==='notallowederror'||detail.includes('permission')||detail.includes('denied'))
          status('Microphone permission was denied or interrupted. Check browser permissions.','warn');
        else if(detail.includes('stop')||detail.includes('recorder'))
          status('iPhone could not finish the recording. Try holding the mic for 2–3 seconds.','warn');
        else if(detail.includes('format'))
          status('This browser cannot record a supported audio format.','warn');
        else status('Audio capture failed before sending to PowerALX. Try again.','warn');
      }
    });
    captureBinding?.dispose();
    captureBinding=bindTeslaMonCaptureButton({button:mic,capture,document,window,
      onError:error=>{
        const name=String(error?.name||'').toLowerCase();
        if(name==='notallowederror')status('Microphone access was blocked by the browser.','warn');
        else status('Microphone input was interrupted. Try holding to record again.','warn');
      }});
  }
  function alignPanel(){
    const bounds=pet.getBoundingClientRect();
    // Mobile CSS uses a wider panel than desktop. Measure the actual box to
    // keep it within viewport safe edges after opening, dragging or rotation.
    const width=panel.getBoundingClientRect().width||Math.min(336,Math.max(200,innerWidth-16));
    const desired=bounds.right-width;
    const left=Math.max(8,Math.min(innerWidth-width-8,desired));
    panel.style.left=(left-bounds.left)+'px';
    panel.style.right='auto';
    const above=Math.max(0,bounds.top-88);
    const below=Math.max(0,innerHeight-bounds.bottom-12);
    if(below>above){
      panel.style.top='75px';panel.style.bottom='auto';
    }else{
      panel.style.top='auto';panel.style.bottom='80px';
    }
    panel.style.maxHeight=Math.max(110,Math.min(650,Math.max(above,below)))+'px';
  }
  function setPosition(x,y){
    pet.style.left=Math.max(0,Math.min(innerWidth-pet.offsetWidth,x))+'px';
    pet.style.top=Math.max(0,Math.min(innerHeight-pet.offsetHeight,y))+'px';
    pet.style.right='auto';pet.style.bottom='auto';
    alignPanel();
  }
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
    try{localStorage.setItem(KEY,JSON.stringify({x:pet.offsetLeft,y:pet.offsetTop}));}catch{}
  });
  handle.addEventListener('pointercancel',()=>{drag=null;});
  try{
    const old=JSON.parse(localStorage.getItem(KEY)||'null');
    if(Number.isFinite(old?.x)&&Number.isFinite(old?.y))setPosition(old.x,old.y);
  }catch{}
  window.addEventListener('resize',()=>{
    if(pet.style.left)setPosition(pet.offsetLeft,pet.offsetTop);
    else alignPanel();
  });
  face.addEventListener('click',()=>{
    opened=!opened;panel.hidden=!opened;
    face.setAttribute('aria-expanded',String(opened));
    if(opened){alignPanel();void refresh();input.focus();}
    else cancelMic();
  });
  $('#tmClose').addEventListener('click',()=>{
    opened=false;panel.hidden=true;face.setAttribute('aria-expanded','false');
    cancelMic();face.focus();
  });
  // Only the current document can receive TeslaMon playback commands.
  $('#tmForm').addEventListener('submit',event=>{
    event.preventDefault();cancelMic();interpret(input.value);
  });
  pet.querySelectorAll('[data-tm]').forEach(button=>
    button.addEventListener('click',()=>{cancelMic();return void issue({
      tool:button.dataset.tm,args:{}
    });}));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)cancelMic();
    else if(opened)void refresh();
  });
  window.addEventListener('pagehide',()=>{
    captureBinding?.dispose();try{speech?.abort();}catch{}
  });
}
