// TeslaMon Aura: a browser-viewport presentation layer, not a second voice engine.
// No microphone, network, vehicle, or playback operations originate here.
const MODES=Object.freeze({
  standby:{eyebrow:'READY WHEN YOU ARE',title:'Your voice. Your space.',hint:'Say a wake phrase to begin'},
  listening:{eyebrow:'VOICE DETECTED',title:"I'm listening.",hint:'Say one command'},
  transcribing:{eyebrow:'VOICE IN MOTION',title:'Turning sound into sense.',hint:'Processing locally in this browser'},
  thinking:{eyebrow:'UNDERSTANDING',title:'Finding the right answer.',hint:'Working on your request'},
  acting:{eyebrow:'IN PROGRESS',title:'Making it happen.',hint:'Only this browser tab is in control'},
  complete:{eyebrow:'DONE',title:'All set.',hint:'Tap anywhere to return'},
  error:{eyebrow:'ONE MORE TRY',title:"Let's try again.",hint:'Tap anywhere to return'},
});
const MODE_NAMES=Object.keys(MODES);

export function createTeslaMonAura({document:doc=globalThis.document,onDismiss=()=>{}}={}){
  if(!doc?.body)throw new TypeError('Aura needs a document with a body');
  const root=doc.createElement('section');
  root.id='tmAura';
  root.className='tm-aura';
  root.hidden=true;
  root.tabIndex=-1;
  root.setAttribute('role','dialog');
  root.setAttribute('aria-modal','true');
  root.setAttribute('aria-label','TeslaMon Aura full-screen voice experience');
  root.innerHTML=`
    <div class="ta-ambient ta-ambient-left" aria-hidden="true"></div>
    <div class="ta-ambient ta-ambient-right" aria-hidden="true"></div>
    <div class="ta-grid" aria-hidden="true"></div>
    <div class="ta-grain" aria-hidden="true"></div>
    <header class="ta-header">
      <div class="ta-logo"><span class="ta-logo-mark" aria-hidden="true">✦</span><span>TESLAMON <b>AURA</b></span></div>
      <span class="ta-live"><i aria-hidden="true"></i> VOICE INTERFACE</span>
    </header>
    <div class="ta-stage">
      <div class="ta-kicker" id="tmAuraEyebrow">READY WHEN YOU ARE</div>
      <div class="ta-visual" aria-hidden="true">
        <div class="ta-halo ta-halo-outer"></div>
        <div class="ta-halo ta-halo-middle"></div>
        <div class="ta-halo ta-halo-inner"></div>
        <div class="ta-orb"><div class="ta-orb-shine"></div><div class="ta-orb-center"></div></div>
        <div class="ta-star ta-star-one">✦</div>
        <div class="ta-star ta-star-two">✧</div>
      </div>
      <div class="ta-wave" aria-hidden="true">${Array.from({length:25},(_,i)=>'<i style="--i:'+i+'"></i>').join('')}</div>
      <h1 class="ta-title" id="tmAuraTitle">Your voice. Your space.</h1>
      <p class="ta-hint" id="tmAuraHint">Say a wake phrase to begin</p>
      <p class="ta-caption" id="tmAuraDetail" role="status" aria-live="polite"></p>
      <div class="ta-transcript" id="tmAuraTranscript" hidden><span>YOU SAID</span><p id="tmAuraTranscriptText"></p></div>
    </div>
    <footer class="ta-footer"><span>INTELLIGENCE, IN THE MOMENT <i>·</i> SAME TAB ONLY</span><span class="ta-tap">TAP ANYWHERE TO RETURN <b>↗</b></span></footer>
  `;
  doc.body.append(root);
  const eyebrow=root.querySelector('#tmAuraEyebrow');
  const title=root.querySelector('#tmAuraTitle');
  const hint=root.querySelector('#tmAuraHint');
  const detail=root.querySelector('#tmAuraDetail');
  const transcript=root.querySelector('#tmAuraTranscript');
  const transcriptText=root.querySelector('#tmAuraTranscriptText');
  let mode='standby';
  let previousFocus=null;
  function setPhase(next){
    mode=MODE_NAMES.includes(next)?next:'standby';
    const copy=MODES[mode];
    root.dataset.phase=mode;
    eyebrow.textContent=copy.eyebrow;
    title.textContent=copy.title;
    hint.textContent=copy.hint;
  }
  function setStatus(value,{kind='info'}={}){
    detail.textContent=String(value||'').slice(0,170);
    detail.dataset.kind=kind==='warn'?'warn':'info';
  }
  function setTranscript(value){
    const words=String(value||'').trim().slice(0,140);
    transcript.hidden=!words;
    transcriptText.textContent=words;
  }
  function attachToFullscreen(){
    const host=doc.fullscreenElement||doc.webkitFullscreenElement||doc.body;
    if(root.parentElement!==host)host.append(root);
  }
  function open({phase='standby',keyword=''}={}){
    attachToFullscreen();
    setPhase(phase);
    setStatus(keyword?keyword+' heard · say one command':'');
    setTranscript('');
    if(root.hidden)previousFocus=doc.activeElement;
    root.hidden=false;
    try{root.focus({preventScroll:true});}catch{root.focus();}
  }
  function close(){
    if(root.hidden)return;
    root.hidden=true;
    if(root.contains(doc.activeElement)){
      try{previousFocus?.focus?.({preventScroll:true});}catch{}
    }
    previousFocus=null;
  }
  function dismiss(){
    if(root.hidden)return;
    close();
    onDismiss();
  }
  // A touch pointerup is handled directly; some embedded browsers omit the
  // synthetic click. Click remains the mouse/keyboard fallback.
  root.addEventListener('pointerup',event=>{
    if(event.pointerType==='touch'&&event.isPrimary){
      event.preventDefault();
      dismiss();
    }
  });
  root.addEventListener('click',dismiss);
  root.addEventListener('keydown',event=>{
    if(['Escape','Enter',' '].includes(event.key)){
      event.preventDefault();
      dismiss();
    }
  });
  setPhase('standby');
  return Object.freeze({
    open,close,setPhase,setStatus,setTranscript,attachToFullscreen,
    get active(){return !root.hidden;},
    get phase(){return mode;},
    get element(){return root;},
    destroy(){close();root.remove();},
  });
}
