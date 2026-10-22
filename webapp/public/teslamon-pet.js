import {interpretTeslaMon} from './teslamon-intent.js';
import {createTeslaMonLocalPlayer} from './teslamon-local-player.js';
import {createTeslaMonCapture} from './teslamon-capture.js';
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
        ' placeholder="Play a video, pause, resume…" />',
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
      '<div id="tmChoices" role="group" aria-label="Video results" hidden></div>',
      '<p id="tmHelp">TeslaMon controls only this page. No remote tab selection,',
        ' device pairing, or separate Cloudflare login is required.</p>',
    '</section>'
  ].join('');
  document.body.append(pet);
  const $=id=>pet.querySelector(id);
  const face=$('#tmFace'),handle=$('#tmHandle'),panel=$('#tmPanel'),
    state=$('#tmState'),mic=$('#tmMic'),
    input=$('#tmText'),choices=$('#tmChoices'),
    modelLabel=$('#tmModelLabel'),modelOptIn=$('#tmModelOptIn');
  const KEY='ytStreamerTeslaMonPetPositionV1';
  const localPlayer=createTeslaMonLocalPlayer();
  let selected=null,enabled=false,busy=false,modelBusy=false,opened=false,
    captureBinding=null,speech=null,speechMode=null,generation=0,micEpoch=0;

  function status(message,type='info'){
    state.textContent=message;state.dataset.kind=type;face.dataset.state=type;
  }
  function clearChoices(){choices.replaceChildren();choices.hidden=true;}
  function report(response){
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
      if(response.fullscreenMode==='in_page'||response.fullscreenMode==='native'){
        status('Fullscreen enabled in this tab.','ok');return;
      }
      status(phase==='playing'?'Playing in this tab':
        phase==='paused'?'Paused':('Player state: '+(phase||'available')),'ok');
    }else if(response?.status==='accepted')status('Command sent. Confirm playback on the player.');
    else if(response?.status==='uncertain')status('Result uncertain. Check player before retrying.','warn');
    else if(response?.status==='needs_user_gesture')status('Tap Fullscreen directly in this tab.','warn');
    else if(response?.status==='offline')status('This tab player is unavailable. Reload the page.','warn');
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
      if(epoch===generation)report(result);
    }catch{
      if(epoch===generation)status('Playback failed unexpectedly. Check the player.','warn');
    }finally{busy=false;}
  }
  async function interpret(text){
    const command=interpretTeslaMon(text);
    if(!command.error){input.value='';void issue(command);return;}
    if(!modelOptIn.checked||modelLabel.hidden){
      status(command.error,'warn');return;
    }
    if(modelBusy||busy){status('A command is already being processed.','warn');return;}
    modelBusy=true;const target=selected,epoch=micEpoch;
    status('Interpreting command with optional AI…');
    try{
      const result=await post('/api/teslamon/interpret',{text,optIn:true});
      if(target!==selected||epoch!==micEpoch||!opened)return;
      if(result.status==='ok'&&typeof result.tool==='string'){
        input.value='';void issue({tool:result.tool,args:result.args});
      }else report(result);
    }catch{status('Model interpretation unavailable. Use a direct playback command.','warn');}
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
      modelLabel.hidden=result.modelConfigured!==true;
      if(modelLabel.hidden)modelOptIn.checked=false;
      if(result.localTranscription)setupRecorder();
      else setupNativeSpeech();
    }catch{
      modelLabel.hidden=true;
      modelOptIn.checked=false;
      setupNativeSpeech();
    }
  }
  function setupRecorder(){
    if(speechMode==='local')return;
    if(speech){speech.cancelled=true;try{speech.abort();}catch{}speech=null;}
    speechMode='local';
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){
      speechMode=null;setupNativeSpeech();return;
    }
    mic.disabled=false;mic.textContent='Hold to talk';
    const capture=createTeslaMonCapture({
      getUserMedia:c=>navigator.mediaDevices.getUserMedia(c),
      MediaRecorder:window.MediaRecorder,
      onState:value=>{
        if(value.state==='recording')status('Listening… release to transcribe.','ok');
        else if(value.state==='stopping')status('Transcribing locally…');
      },
      onAudio:blob=>{
        if(!localPlayer.ready)return;
        const before=selected,epoch=micEpoch;
        void(async()=>{
          try{
            const reply=await post('/api/teslamon/transcribe',blob,blob.type);
            if(before!==selected||epoch!==micEpoch||!opened)return;
            if(reply.status==='ok'&&typeof reply.text==='string'){
              input.value=reply.text;interpret(reply.text);
            }else report(reply);
          }catch{status('Transcription failed. Type a command.','warn');}
        })();
      },
      onError:()=>status('Microphone error. Type a command or retry.','warn')
    });
    captureBinding?.dispose();
    captureBinding=bindTeslaMonCaptureButton({button:mic,capture,document,window,
      onError:()=>status('Microphone unavailable.','warn')});
  }
  function setupNativeSpeech(){
    if(speechMode==='native')return;
    if(captureBinding){captureBinding.dispose();captureBinding=null;}
    speechMode='native';
    const Engine=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Engine){
      mic.disabled=true;mic.title='Speech input unsupported here. Type a command.';
      return;
    }
    mic.disabled=false;mic.textContent='Tap to speak';
    mic.addEventListener('click',()=>{
      if(speechMode!=='native'||!localPlayer.ready)return;
      if(speech){try{speech.stop();}catch{}return;}
      let transcript='';
      const before=selected,epoch=micEpoch;
      const session=new Engine();speech=session;
      session.lang='en-US';session.continuous=false;session.interimResults=false;
      session.onresult=event=>{
        transcript=event.results?.[0]?.[0]?.transcript?.trim()||'';
      };
      session.onerror=()=>status('Speech input failed. Type a command or retry.','warn');
      session.onend=()=>{
        if(speech===session)speech=null;
        if(session.cancelled)return;
        if(transcript&&before===selected&&epoch===micEpoch&&opened)interpret(transcript);
        else status('No speech recognized. Try again or type.','warn');
      };
      try{session.start();status('Listening… tap again to stop.','ok');}
      catch{speech=null;status('Speech recognition unavailable.','warn');}
    });
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
    event.preventDefault();interpret(input.value);
  });
  pet.querySelectorAll('[data-tm]').forEach(button=>
    button.addEventListener('click',()=>void issue({
      tool:button.dataset.tm,args:{}
    })));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)cancelMic();
    else if(opened)void refresh();
  });
  window.addEventListener('pagehide',()=>{
    captureBinding?.dispose();try{speech?.abort();}catch{}
  });
}
