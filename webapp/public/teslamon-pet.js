import {createTeslaMonLocalPlayer} from './teslamon-local-player.js?v=20261024-auto-collapse1';
import {createTeslaMonAutoSend} from './teslamon-auto-send.js';
import {createTeslaMonCapture} from './teslamon-capture.js';
import {convertTeslaMonAudioToWav} from './teslamon-wav-fallback.js';
import {bindTeslaMonCaptureButton} from './teslamon-capture-binding.js';
import {createTeslaMonHandsFree} from './teslamon-handsfree.js';
import {createTeslaMonSilenceMonitor} from './teslamon-silence-monitor.js';
import {getTeslaMonPetMotion} from './teslamon-pet-motion.js?v=20261024-poses1';
import {shouldAutoCollapseTeslaMonPanel} from './teslamon-collapse.js';

if(['stream.ameshalex.com','teslamon-stage.ameshalex.com'].includes(location.hostname)&&location.protocol==='https:'){
  const pet=document.createElement('aside');
  pet.id='teslamonPet';
  pet.setAttribute('aria-label','TeslaMon playback assistant');
  pet.innerHTML=[
    '<div class="tm-shell">',
      '<button type="button" id="tmHandle" aria-label="Drag TeslaMon to move" title="Drag to move, or use arrow keys when focused">⠿</button>',
      '<button type="button" id="tmFace" aria-label="TeslaMon puppy — open or close controls" aria-expanded="false" aria-controls="tmPanel">',
        // Original vector puppy: crisp at icon size, with no font or image request.
        `<svg class="tm-puppy" viewBox="0 0 104 100" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="53" cy="94" rx="33" ry="4" fill="#07121c" opacity=".28"/>
          <g stroke="#593522" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <g class="tm-pose tm-pose-sit">
              <path class="tm-tail" d="M73 79 Q94 83 94 62 Q84 66 82 73 L72 72" fill="#d99444"/>
              <path d="M35 62 Q25 72 30 87 Q35 94 52 91 Q72 95 77 85 Q80 73 69 62" fill="#eeb65d"/>
              <path d="M44 68 Q52 63 61 69 L64 87 Q52 93 40 86Z" fill="#fff0cd" stroke="none"/>
              <path d="M37 76 L36 88 M66 76 L68 88" fill="none"/>
              <ellipse cx="35" cy="89" rx="11" ry="6" fill="#fff0cd"/>
              <ellipse cx="69" cy="89" rx="11" ry="6" fill="#fff0cd"/>
              <path d="M31 89v3 M37 89v3 M66 89v3 M72 89v3" stroke-width="1.4"/>
            </g>
            <g class="tm-pose tm-pose-stand">
              <g class="tm-speed-lines" stroke="#ffdd87" stroke-width="3" fill="none" stroke-linecap="round">
                <path d="M8 72 H22 M4 82 H20 M84 62 H98"/>
              </g>
              <path class="tm-tail-stand" d="M75 66 Q91 65 95 52 Q100 58 95 71 Q89 80 75 78Z" fill="#d99444"/>
              <path d="M31 56 Q24 62 27 73 Q32 80 52 80 Q74 80 78 72 Q81 61 70 56Z" fill="#eeb65d"/>
              <path d="M43 60 Q52 57 62 60 L65 75 Q53 81 42 75Z" fill="#fff0cd" stroke="none"/>
              <g class="tm-run-leg tm-run-leg-back">
                <path d="M30 73 L28 93 Q31 98 40 95 L42 74Z" fill="#d99a4d"/>
                <ellipse cx="33" cy="95" rx="9" ry="4" fill="#fff0cd"/>
              </g>
              <g class="tm-run-leg tm-run-leg-front">
                <path d="M66 73 L71 93 Q75 99 81 94 L77 72Z" fill="#eeb65d"/>
                <ellipse cx="76" cy="95" rx="9" ry="4" fill="#fff0cd"/>
              </g>
              <path d="M43 74 L41 94 M60 74 L61 94" fill="none"/>
              <ellipse cx="41" cy="95" rx="8" ry="4" fill="#fff0cd"/>
              <ellipse cx="62" cy="95" rx="8" ry="4" fill="#fff0cd"/>
            </g>
            <g class="tm-head">
              <path d="M33 61 Q51 71 71 61 L70 69 Q51 77 34 69Z" fill="#55b7b0"/>
              <circle class="tm-tag" cx="52" cy="72" r="5" fill="#ffe190"/>
              <path d="M24 28 Q26 13 43 14 L49 8 L51 14 Q72 10 81 28 L81 46 Q78 66 53 68 Q27 66 23 49Z" fill="#f5c674"/>
              <path d="M26 24 Q15 17 10 34 Q4 53 17 59 Q25 61 27 46 L32 29Z" fill="#a76635"/>
              <path d="M77 24 Q88 17 94 34 Q100 53 87 59 Q79 61 77 46 L72 29Z" fill="#a76635"/>
              <path d="M18 30 Q13 40 16 48 M86 30 Q91 40 88 48" stroke="#ce914d" stroke-width="3" fill="none"/>
              <path d="M49 20 Q45 35 46 45 L58 45 Q59 33 54 20Z" fill="#fff0cd" stroke="none"/>
              <ellipse cx="38" cy="39" rx="6.5" ry="9" fill="#2c2422" stroke="none"/>
              <ellipse cx="66" cy="39" rx="6.5" ry="9" fill="#2c2422" stroke="none"/>
              <circle cx="36" cy="36" r="2.4" fill="white" stroke="none"/>
              <circle cx="64" cy="36" r="2.4" fill="white" stroke="none"/>
              <path d="M33 26 Q37 23 42 26 M62 26 Q67 23 71 26" fill="none"/>
              <path d="M40 52 Q52 47 64 52 Q62 65 52 65 Q42 65 40 52Z" fill="#593522"/>
              <path d="M47 58 Q52 55 57 58 L57 63 Q52 70 47 63Z" fill="#ee8e91" stroke-width="1.5"/>
              <path d="M52 59v4" stroke="#bf5e70" stroke-width="1.2"/>
              <path d="M52 46 C34 39 27 51 35 57 Q44 63 52 54 Q60 63 69 57 C77 51 70 39 52 46Z" fill="#fff0cd" stroke="none"/>
              <path d="M45 46 Q52 42 59 46 Q60 50 52 53 Q44 50 45 46Z" fill="#2c2422" stroke="none"/>
              <path d="M49 46h4" stroke="#fff" stroke-width="1.5"/>
              <path d="M52 53v2 Q47 60 41 56 M52 55 Q57 60 63 56" fill="none" stroke-width="1.7"/>
            </g>
          </g>
        </svg>`,
      '</button>',
    '</div>',
    '<section class="tm-panel" id="tmPanel" hidden aria-label="TeslaMon controls">',
      '<div class="tm-head"><strong>TeslaMon</strong>',
        '<button id="tmClose" type="button" aria-label="Close">×</button></div>',
      '<p id="tmState" role="status" aria-live="polite">Connecting to this tab…</p>',
      '<div class="tm-wake-control" id="tmWakeControl" role="group" aria-label="Hands-free microphone">',
        '<div class="tm-wake-copy"><strong>Hands-free microphone</strong>',
          '<span id="tmWakeState" role="status" aria-live="polite">Off</span></div>',
        '<button id="tmWakeToggle" type="button" aria-pressed="false" aria-label="Turn hands-free microphone on">Mic Off</button>',
      '</div>',
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
        ' device pairing, or separate Cloudflare login is required. Text sends automatically after 2 seconds of no changes.</p>',
    '</section>'
  ].join('');
  document.body.append(pet);
  const $=id=>pet.querySelector(id);
  const face=$('#tmFace'),handle=$('#tmHandle'),panel=$('#tmPanel'),
    state=$('#tmState'),mic=$('#tmMic'),
    wakeControl=$('#tmWakeControl'),wakeToggle=$('#tmWakeToggle'),wakeState=$('#tmWakeState'),
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
    captureBinding=null,speech=null,speechMode=null,generation=0,micEpoch=0,voiceAvailable=false,
    wakeInputChanged=false,wakeHandled=false,autoWakeWanted=true,autoWakeBlocked=false,panelRevision=0;

  function status(message,type='info'){
    state.textContent=message;state.dataset.kind=type;face.dataset.state=type;
  }
  // Keep the puppy seated during passive wake-word scanning; a recognized
  // wake word stands it up, and active work runs it in place.
  function syncPetMotion(){
    pet.dataset.motion=getTeslaMonPetMotion({
      wakeState:pet.dataset.wake,modelBusy,busy
    });
  }
  function focusCommand({requestKeyboard=false}={}){
    if(!opened){opened=true;panel.hidden=false;face.setAttribute('aria-expanded','true');}
    alignPanel();
    try{input.focus({preventScroll:true});}catch{input.focus();}
    // Only a real user tap may allow opening the virtual keyboard. A wake-word
    // callback can still focus the field even when Tesla blocks the keyboard.
    if(requestKeyboard){
      try{const attempt=navigator.virtualKeyboard?.show?.();attempt?.catch?.(()=>{});}catch{}
    }
  }
  function collapsePanel({focusFace=false}={}){
    opened=false;
    panel.hidden=true;
    face.setAttribute('aria-expanded','false');
    autoSend.cancel();
    if(document.activeElement===input)input.blur();
    if(focusFace)face.focus();
  }
  function collapseAfterSuccess(response,requestRevision){
    if(!shouldAutoCollapseTeslaMonPanel({
      response,opened,requestRevision,panelRevision,hasDraft:Boolean(input.value.trim())
    }))return;
    // Hide controls, but keep the puppy, wake mic and media playback alive.
    collapsePanel();
  }
  // Tesla's native keyboard dictation, paste and typing all arrive as text.
  // Never assume input events identify their actual source.
  const autoSend=createTeslaMonAutoSend({
    readText:()=>input.value,
    canSend:()=>opened&&enabled&&localPlayer.ready&&!modelBusy&&!busy&&!document.hidden,
    send:text=>{
      // One wake invocation can produce BOTH native keyboard text and a
      // PowerALX transcript. The first source to dispatch wins that wake.
      if(wakeInputChanged&&wakeHandled){
        wakeInputChanged=false;
        if(input.value.trim()===text)input.value='';
        status('This wake command was already sent.','ok');
        return;
      }
      if(wakeInputChanged){
        wakeHandled=true;
        if(['recording','processing'].includes(handsFree.state))micEpoch++;
      }
      void interpret(text,{allowClosed:true});
    },
  });
  // Attempt foreground wake listening on each page load, using ordinary
  // browser microphone permission. Off stays off until re-enabled this visit.
  function updateWakeUI({state:phase='off',message}={}){
    const isOn=handsFree?.enabled??phase==='starting';
    wakeControl.dataset.active=String(isOn);
    wakeControl.dataset.error=String(phase==='error');
    pet.dataset.wake=phase;
    pet.dataset.mic=isOn&&phase!=='error'?'on':'off';
    syncPetMotion();
    face.setAttribute('aria-description', 'Hands-free microphone: '+(message||phase));
    wakeToggle.textContent=isOn?'Mic On':'Mic Off';
    wakeToggle.setAttribute('aria-pressed',String(isOn));
    wakeToggle.setAttribute('aria-label',isOn?
      'Turn hands-free microphone off':'Turn hands-free microphone on');
    wakeState.textContent=message||(
      phase==='listening'?'Listening for “Hey Jarvis”':
      phase==='recording'?'Recording command':
      phase==='processing'?'Processing command':
      phase==='starting'?'Requesting microphone permission…':'Off');
    if(speechMode==='local')mic.disabled=!voiceAvailable||['starting','recording','processing'].includes(phase);
    if(phase==='recording'){
      wakeInputChanged=false;wakeHandled=false;
      focusCommand({requestKeyboard:true});
    }
    if(phase==='error')status(wakeState.textContent,'warn');
    else if(phase==='recording')status('Hey Jarvis detected. Say one command.','ok');
    else if(phase==='processing')status('Processing hands-free command…');
  }
  function lowerPlaybackDuringCommand(){
    const changed=[];
    for(const media of document.querySelectorAll('video,audio')){
      try{
        if(media.paused||media.muted||media.volume<=0)continue;
        const prior=media.volume,next=Math.min(prior,0.12);
        media.volume=next;
        if(Math.abs(media.volume-next)<0.005)changed.push([media,prior,next]);
      }catch{/* Safari can ignore programmatic media volume changes. */}
    }
    return ()=>{
      for(const [media,prior,temporary] of changed){
        try{if(Math.abs(media.volume-temporary)<0.005)media.volume=prior;}catch{}
      }
    };
  }
  const handsFree=createTeslaMonHandsFree({
    getUserMedia:options=>navigator.mediaDevices.getUserMedia(options),
    createDetector:async options=>{
      // Loading the ONNX runtime and weights only happens after Mic On.
      const module=await import('./teslamon-wake-engine.js');
      return module.createTeslaMonWakeDetector(options);
    },
    createCapture:options=>createTeslaMonCapture({
      ...options, MediaRecorder:window.MediaRecorder,
    }),
    createSilenceMonitor:options=>createTeslaMonSilenceMonitor(options),
    onAudio:(blob,{signal})=>processCapturedAudio(blob,{allowClosed:true,signal}),
    onState:updateWakeUI,
    onError:error=>{
      autoWakeBlocked=true;
      const name=String(error?.name||'');
      if(name==='NotAllowedError')
        status('Microphone permission denied. Allow access in browser settings.','warn');
    },
    duckPlayback:lowerPlaybackDuringCommand,
  });
  wakeToggle.disabled=true;
  wakeToggle.addEventListener('click',()=>{
    if(handsFree.enabled){
      autoWakeWanted=false;
      handsFree.disable();
      micEpoch++; // Invalidates any older voice plan before dispatch.
    }else if(voiceAvailable){
      autoWakeWanted=true;autoWakeBlocked=false;
      // getUserMedia is invoked synchronously on this trusted click.
      void handsFree.enable();
    }
  });
  updateWakeUI({state:'off',message:'Off'});
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
        codex_usage_limit:response?.retryAt?
          'Codex usage limit reached. Try again at '+response.retryAt+'.':
          'Codex usage limit reached. Try again after your allowance resets.',
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
  async function post(url,data,contentType='application/json',signal){
    const answer=await fetch(url,{
      method:'POST',credentials:'same-origin',mode:'same-origin',
      cache:'no-store',redirect:'error',signal,headers:{
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
  async function issue(intent,requestRevision=panelRevision){
    if(busy){status('Wait for the current command.','warn');return;}
    if(!enabled||!localPlayer.ready){status('This page player is still loading.','warn');return;}
    busy=true;syncPetMotion();const epoch=++generation;
    status('Sending command…');
    try{const result=await localPlayer.run(intent);
      if(epoch===generation){
        report(result,intent.tool);
        collapseAfterSuccess(result,requestRevision);
        if(intent.tool==='search_and_play'&&result.status==='accepted'&&result.mediaId){
          status('Video selected. Waiting for video frames…');
          void localPlayer.observe(result.mediaId,{
            isCurrent:()=>epoch===generation&&requestRevision===panelRevision&&opened&&!document.hidden
          }).then(confirmed=>{
            if(epoch!==generation)return;
            if(confirmed.status==='observed'){
              status('Video playing in this tab.','ok');
              collapseAfterSuccess(confirmed,requestRevision);
            }else if(confirmed.code==='playback_stream_failed')
              status('Video stream failed to load. Try another video.','warn');
            else if(confirmed.code==='playback_not_confirmed')
              status('Video has not started after 12 seconds. Check the player.','warn');
          }).catch(()=>{if(epoch===generation)
            status('Could not confirm video playback.','warn');});
        }
      }
    }catch{
      if(epoch===generation)status('Playback failed unexpectedly. Check the player.','warn');
    }finally{busy=false;syncPetMotion();autoSend.flush();}
  }
  // Natural language (both typed and PowerALX voice transcript) always goes
  // through the signed Codex CLI planner. Direct buttons skip reasoning.
  async function interpret(text,{allowClosed=false,signal}={}){
    if(signal?.aborted)return;
    const request=String(text||'').trim();
    if(request.length<1||request.length>220){
      status('Enter a playback request under 220 characters.','warn');return;
    }
    if(modelBusy||busy){status('A playback request is already running.','warn');return;}
    modelBusy=true;syncPetMotion();
    const target=selected,epoch=micEpoch,requestRevision=panelRevision;
    status('Codex is understanding your request…');
    try{
      const result=await post('/api/teslamon/plan',{text:request,session:tabSession},'application/json',signal);
      if(signal?.aborted||target!==selected||epoch!==micEpoch||(!opened&&!allowClosed))return;
      if(result.status==='ok'&&typeof result.tool==='string'){
        if(input.value.trim()===request)input.value='';
        await issue({tool:result.tool,args:result.args||{}},requestRevision);
      }else if(result.status==='ha_done'){
        if(input.value.trim()===request)input.value='';
        status(result.action==='light_changed'?
          'Home Assistant light command completed.':'Home Assistant light state checked.','ok');
        collapseAfterSuccess(result,requestRevision);
      }else report(result);
    }catch{status('Codex is unavailable. Quick controls still work.','warn');}
    finally{modelBusy=false;syncPetMotion();autoSend.flush();}
  }
  function cancelMic({preserveWake=false}={}){
    if(!preserveWake)micEpoch++;
    captureBinding?.targetChanged();
    if(speech){speech.cancelled=true;try{speech.abort();}catch{}speech=null;}
  }
  async function refresh(){
    enabled=localPlayer.ready;
    // The current document's player is the only playback target.
    selected=enabled?'this_tab':null;
    if(!enabled){
      mic.disabled=true;voiceAvailable=false;wakeToggle.disabled=true;
      handsFree.disable();
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
        voiceAvailable=false;wakeToggle.disabled=true;handsFree.disable();
        status('Codex CLI is unavailable. Quick controls still work.','warn');
        return;
      }
      if(result.localTranscription){
        setupRecorder();
        voiceAvailable=speechMode==='local';
        const wakeSupported=Boolean(window.AudioWorkletNode&&
          (window.AudioContext||window.webkitAudioContext)&&navigator.mediaDevices?.getUserMedia);
        wakeToggle.disabled=!voiceAvailable||!wakeSupported;
        if(!wakeSupported&&voiceAvailable&&!handsFree.enabled)
          updateWakeUI({state:'error',message:'Error: Hands-free wake detection unsupported in this browser'});
        if(wakeSupported&&voiceAvailable&&autoWakeWanted&&!autoWakeBlocked&&
           !handsFree.enabled&&!document.hidden)
          void handsFree.enable().then(started=>{if(!started)autoWakeBlocked=true;});
      }
      else {mic.disabled=true;mic.textContent='PowerALX unavailable';
        voiceAvailable=false;wakeToggle.disabled=true;handsFree.disable();
        status('PowerALX transcription is not configured. Use typed commands.','warn');}
    }catch{
      modelLabel.hidden=true;
      modelOptIn.checked=false;
      mic.disabled=true;mic.textContent='Voice unavailable';
      voiceAvailable=false;wakeToggle.disabled=true;handsFree.disable();
      status('Could not verify the PowerALX voice service. Use typed commands.','warn');
    }
  }
  // Both hold-to-talk and wake-command clips use the existing authenticated
  // PowerALX transcription and bounded Codex planner path.
  async function processCapturedAudio(blob,{allowClosed=false,signal}={}){
    if(!localPlayer.ready||signal?.aborted)return;
    const before=selected,epoch=micEpoch;
    const current=()=>!signal?.aborted&&before===selected&&
      epoch===micEpoch&&(opened||allowClosed);
    if(!current())return;
    status('Audio captured. Sending to PowerALX…');
    try{
      let reply=await post('/api/teslamon/transcribe',blob,blob.type,signal);
      // Safari can produce MP4 recordings with invalid timing metadata.
      // The fallback repairs only this one command clip in the browser.
      if(blob.type?.split(';')[0]==='audio/mp4'&&
        ['invalid_audio','invalid_audio_container','invalid_audio_timing','invalid_audio_duration'].includes(reply?.code)){
        try{
          const wav=await convertTeslaMonAudioToWav(blob);
          if(!current())return;
          status('Converting iPhone audio for PowerALX…');
          reply=await post('/api/teslamon/transcribe',wav,wav.type,signal);
        }catch{
          if(!current())return;
          reply={status:'failed',code:'iphone_wav_fallback_failed'};
        }
      }
      if(!current())return;
      if(reply.status==='ok'&&typeof reply.text==='string'){
        // Native keyboard text takes precedence over the same wake clip.
        if(allowClosed&&(wakeInputChanged||wakeHandled))return;
        autoSend.cancel();
        // The classifier detects the activation phrase, not the command;
        // strip a possible leading wake phrase before Codex interpretation.
        const command=reply.text.replace(/^\\s*hey[\\s,.!]*jarvis[\\s,.!:-]*/i,'').trim()||reply.text;
        input.value=command;
        // PowerALX and Tesla keyboard text use exactly the same quiet-time
        // auto-send path; do not submit to Codex before the user can correct it.
        autoSend.changed();
        status('Transcribed. Sending after 2 seconds without edits…','ok');
      }else if(!wakeInputChanged)report(reply);
    }catch{
      if(current()&&!wakeInputChanged)status('Transcription failed. Type a command.','warn');
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
      getUserMedia:async c=>{
        if(handsFree.enabled){
          const suspended=handsFree.suspend();
          if(!suspended&&!handsFree.suspended)throw new Error('Hands-free command is active');
        }
        return navigator.mediaDevices.getUserMedia(c);
      },
      MediaRecorder:window.MediaRecorder,
      onState:value=>{
        if(value.state==='requesting')status('Requesting microphone access…');
        else if(value.state==='recording')status('Recording audio… release to finish.','ok');
        else if(value.state==='stopping')status('Finishing recording…');
        else if(value.state==='empty')status('No audio was captured. Hold the mic a little longer.','warn');
        if(['empty','cancelled','error'].includes(value.state))handsFree.resume();
      },
      onAudio:blob=>{
        void processCapturedAudio(blob).finally(()=>{handsFree.resume();});
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
  function safeInsets(){
    const css=getComputedStyle(pet);
    return Object.fromEntries(['top','right','bottom','left'].map(side=>
      [side,parseFloat(css.getPropertyValue('--tm-safe-'+side))||0]));
  }
  function alignPanel(){
    const safe=safeInsets();
    const bounds=pet.getBoundingClientRect();
    // Mobile CSS uses a wider panel than desktop. Measure the actual box to
    // keep it within viewport safe edges after opening, dragging or rotation.
    const width=panel.getBoundingClientRect().width||Math.min(336,Math.max(200,innerWidth-16));
    const desired=bounds.right-width;
    const left=Math.max(safe.left+8,Math.min(innerWidth-safe.right-width-8,desired));
    panel.style.left=(left-bounds.left)+'px';
    panel.style.right='auto';
    const above=Math.max(0,bounds.top-safe.top-16);
    const below=Math.max(0,innerHeight-safe.bottom-bounds.bottom-16);
    if(below>above){
      panel.style.top=(bounds.height+8)+'px';panel.style.bottom='auto';
    }else{
      panel.style.top='auto';panel.style.bottom=(bounds.height+8)+'px';
    }
    panel.style.maxHeight=Math.max(110,Math.min(650,Math.max(above,below)))+'px';
  }
  function setPosition(x,y){
    const safe=safeInsets();
    pet.style.left=Math.max(safe.left+8,Math.min(innerWidth-safe.right-pet.offsetWidth-8,x))+'px';
    pet.style.top=Math.max(safe.top+8,Math.min(innerHeight-safe.bottom-pet.offsetHeight-8,y))+'px';
    pet.style.right='auto';pet.style.bottom='auto';
    alignPanel();
  }
  let drag=null;
  function savePosition(){
    try{localStorage.setItem(KEY,JSON.stringify({x:pet.offsetLeft,y:pet.offsetTop}));}catch{}
  }
  handle.addEventListener('keydown',event=>{
    const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!direction)return;
    event.preventDefault();
    const step=event.shiftKey?4:20;
    setPosition(pet.offsetLeft+direction[0]*step,pet.offsetTop+direction[1]*step);
    savePosition();
  });
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
  try{
    const old=JSON.parse(localStorage.getItem(KEY)||'null');
    if(Number.isFinite(old?.x)&&Number.isFinite(old?.y))setPosition(old.x,old.y);
  }catch{}
  window.addEventListener('resize',()=>{
    if(pet.style.left)setPosition(pet.offsetLeft,pet.offsetTop);
    else alignPanel();
  });
  face.addEventListener('click',()=>{
    panelRevision++;
    if(opened){
      collapsePanel();
      cancelMic({preserveWake:true});
    }else{
      focusCommand({requestKeyboard:true});
      void refresh();
    }
  });
  $('#tmClose').addEventListener('click',()=>{
    panelRevision++;
    collapsePanel({focusFace:true});
    cancelMic({preserveWake:true});
  });
  // A single text insertion (Tesla dictation/paste) and ordinary typing share
  // this path. The last edit wins; the Send button remains an immediate override.
  input.addEventListener('input',()=>{
    panelRevision++;
    if(['recording','processing'].includes(handsFree.state))wakeInputChanged=true;
    autoSend.changed();
  });
  input.addEventListener('compositionstart',()=>autoSend.compositionStart());
  input.addEventListener('compositionend',()=>autoSend.compositionEnd());
  // Only the current document can receive TeslaMon playback commands.
  $('#tmForm').addEventListener('submit',event=>{
    event.preventDefault();autoSend.cancel();cancelMic();void interpret(input.value);
  });
  pet.querySelectorAll('[data-tm]').forEach(button=>
    button.addEventListener('click',()=>{cancelMic();return void issue({
      tool:button.dataset.tm,args:{}
    });}));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){autoSend.cancel();handsFree.disable();micEpoch++;cancelMic();}
    else void refresh();
  });
  window.addEventListener('pagehide',()=>{
    autoSend.dispose();handsFree.disable();micEpoch++;captureBinding?.dispose();try{speech?.abort();}catch{}
  });
  // Wake listening must initialize even when the puppy panel stays closed.
  // This triggers only the browser's normal permission flow, never a bypass.
  void refresh();
}
