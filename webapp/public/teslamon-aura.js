// TeslaMon Aura is presentation only; it never owns a microphone or command.
const PHASES=new Set(['standby','preparing','listening','transcribing','thinking','acting','complete','error']);
export function createTeslaMonAura({document:doc=globalThis.document,onDismiss=()=>{},onHoldStart=()=>{},onHoldEnd=()=>{},onHoldCancel=()=>{}}={}){
  if(!doc?.body)throw new TypeError('Aura needs a document with a body');
  const root=doc.createElement('section');
  root.id='tmAura';
  root.className='tm-aura';
  root.hidden=true;
  root.tabIndex=0;
  root.setAttribute('role','dialog');
  root.setAttribute('aria-modal','true');
  root.setAttribute('aria-label','TeslaMon Aura. Double tap to dismiss. Press Escape to close.');
  root.setAttribute('aria-keyshortcuts','Escape');
  root.innerHTML=`
    <div class="ta-ambient ta-ambient-left" aria-hidden="true"></div>
    <div class="ta-ambient ta-ambient-right" aria-hidden="true"></div>
    <div class="ta-grid" aria-hidden="true"></div>
    <div class="ta-grain" aria-hidden="true"></div>
    <div class="ta-stage">
      <div class="ta-visual" aria-hidden="true">
        <div class="ta-halo ta-halo-outer"></div>
        <div class="ta-halo ta-halo-middle"></div>
        <div class="ta-halo ta-halo-inner"></div>
        <div class="ta-orb"><div class="ta-orb-shine"></div><div class="ta-orb-center"></div></div>
        <div class="ta-star ta-star-one">✦</div><div class="ta-star ta-star-two">✧</div>
      </div>
      <div class="ta-wave" aria-hidden="true">${Array.from({length:25},(_,i)=>'<i style="--i:'+i+'"></i>').join('')}</div>
      <h1 class="ta-title">I am listening</h1>
      <p class="ta-hint">What would you like me to do?</p>
      <p class="ta-caption" id="tmAuraDetail" role="status" aria-live="polite"></p>
    </div>`;
  doc.body.append(root);
  const detail=root.querySelector('#tmAuraDetail');
  const title=root.querySelector('.ta-title');
  const hint=root.querySelector('.ta-hint');
  let requestCard=null;
  const headings={
    standby:['TeslaMon Aura','Ready for a command'],
    preparing:['Getting ready','Preparing your request'],
    listening:['I am listening','What would you like me to do?'],
    transcribing:['Understanding your request','Processing your words'],
    thinking:['Working on your request','Searching for the right video'],
    acting:['Starting playback','Waiting for the player'],
    complete:['Request complete',''],
    error:['Request could not finish','You can retry your request'],
  };
  const HOLD_MS=250,DOUBLE_TAP_MS=350,MOVE_LIMIT=12,TOUCH_CLICK_WAIT_MS=180;
  let mode='standby',entry=0,pointer=null,lastTapAt=0,captureOnHold=false,keyboardHold=null;
  let touchDismissTimer=null;
  function owned(token){return token===undefined||token===entry;}
  function focusDialog(){
    try{root.focus({preventScroll:true});}catch{root.focus();}
  }
  function containFocus(event){
    if(!root.hidden&&!root.contains(event.target))focusDialog();
  }
  function handleDocumentKeydown(event){
    if(root.hidden)return;
    if(event.key==='Escape'){
      dismiss(event);
      return;
    }
    if(event.key==='Tab'){
      // Aura has no controls. Keep its visual dialog as the only tab stop.
      event.preventDefault();
      event.stopPropagation();
      focusDialog();
      return;
    }
    if(event.code==='Space'&&captureOnHold){
      event.preventDefault();
      event.stopPropagation();
      if(!event.repeat&&!keyboardHold&&!pointer&&touchDismissTimer===null){
        lastTapAt=0;
        const state=keyboardHold={entry,holding:false,timer:null};
        state.timer=setTimeout(()=>{
          if(keyboardHold!==state)return;
          state.holding=true;
          onHoldStart({entry:state.entry,event});
        },HOLD_MS);
      }
    }
  }
  function handleDocumentKeyup(event){
    if(event.code!=='Space'||!keyboardHold)return;
    event.preventDefault();event.stopPropagation();
    const state=keyboardHold;keyboardHold=null;clearTimeout(state.timer);
    if(state.holding)onHoldEnd({entry:state.entry,event});
  }
  doc.addEventListener('focusin',containFocus,true);
  doc.addEventListener('keydown',handleDocumentKeydown,true);
  doc.addEventListener('keyup',handleDocumentKeyup,true);
  doc.defaultView?.addEventListener('blur',onWindowBlur);
  function setPhase(next,{entry:token}={}){
    if(!owned(token))return false;
    mode=PHASES.has(next)?next:'standby';
    root.dataset.phase=mode;
    [title.textContent,hint.textContent]=headings[mode];
    return true;
  }
  function setStatus(value,{kind='info',entry:token}={}){
    if(!owned(token))return false;
    detail.textContent=String(value||'').slice(0,140);
    detail.dataset.kind=kind==='warn'?'warn':'info';
    return true;
  }
  function setTranscript(value,{entry:token}={}){
    if(!owned(token))return false;
    const text=String(value||'').trim().slice(0,220);
    if(!text){requestCard?.remove();requestCard=null;return true;}
    if(!requestCard){
      requestCard=doc.createElement('div');
      requestCard.className='ta-transcript';
      const label=doc.createElement('span');
      label.textContent='RECEIVED REQUEST';
      const received=doc.createElement('p');
      received.id='tmAuraTranscript';
      requestCard.append(label,received);
      detail.before(requestCard);
    }
    // Never interpret URL text as markup.
    requestCard.querySelector('p').textContent=text;
    return true;
  }
  function attachToFullscreen(){
    const host=doc.fullscreenElement||doc.webkitFullscreenElement||doc.body;
    if(root.parentElement!==host){
      host.append(root);
      if(!root.hidden)focusDialog();
    }
  }
  function open({phase='standby',status='',captureOnHold:canCapture=false}={}){
    cancelPointer('reopen');
    cancelKeyboard('reopen');
    clearTouchDismiss();
    attachToFullscreen();
    entry++;
    setTranscript('',{entry});
    lastTapAt=0;
    captureOnHold=Boolean(canCapture);
    root.setAttribute('aria-label',captureOnHold
      ?'TeslaMon Aura. Press and hold, or hold Space, to record. Release to send. Double tap or press Escape to dismiss.'
      :'TeslaMon Aura. Double tap to dismiss. Press Escape to close.');
    root.hidden=false;
    setPhase(phase);
    setStatus(status);
    focusDialog();
    return entry;
  }
  function close(){
    if(root.hidden)return;
    cancelPointer('hidden');
    cancelKeyboard('hidden');
    clearTouchDismiss();
    root.hidden=true;
    setTranscript('');
    if(doc.activeElement===root)try{root.blur();}catch{}
  }
  function dismiss(event){
    if(root.hidden)return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    close();
    onDismiss(entry,event?.type==='keydown'?'keyboard':'pointer');
  }
  function cancelPointer(reason){
    if(!pointer)return;
    const active=pointer;
    pointer=null;
    lastTapAt=0;
    clearTimeout(active.timer);
    if(active.holding)onHoldCancel({entry:active.entry,reason});
    try{root.releasePointerCapture(active.id);}catch{}
  }
  function cancelKeyboard(reason){
    if(!keyboardHold)return;
    const active=keyboardHold;
    keyboardHold=null;
    clearTimeout(active.timer);
    if(active.holding)onHoldCancel({entry:active.entry,reason});
  }
  function clearTouchDismiss(){
    clearTimeout(touchDismissTimer);
    touchDismissTimer=null;
  }
  function onWindowBlur(){
    cancelPointer('blur');
    cancelKeyboard('blur');
    clearTouchDismiss();
    lastTapAt=0;
  }
  function isolate(event){event.preventDefault();event.stopPropagation();}
  root.addEventListener('pointerdown',event=>{
    isolate(event);
    if(!event.isPrimary||event.button!==0||root.hidden||keyboardHold||touchDismissTimer!==null)return;
    cancelPointer('replaced');
    const startedAt=Date.now();
    const secondTap=lastTapAt>0&&startedAt-lastTapAt<=DOUBLE_TAP_MS;
    const state=pointer={id:event.pointerId,x:event.clientX,y:event.clientY,holding:false,entry,startedAt,secondTap};
    try{root.setPointerCapture(event.pointerId);}catch{}
    // Reserve a press that starts inside the double-tap window for dismissal.
    // A slow second touch must not accidentally turn into a mic command.
    if(captureOnHold&&!secondTap){
      state.timer=setTimeout(()=>{
        if(pointer!==state||state.moved)return;
        state.holding=true;
        lastTapAt=0;
        onHoldStart({entry:state.entry,event});
      },HOLD_MS);
    }
  },{capture:true});
  root.addEventListener('pointermove',event=>{
    if(pointer?.id!==event.pointerId)return;
    isolate(event);
    if(Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>MOVE_LIMIT){
      pointer.moved=true;
      cancelPointer('drag');
    }
  },{capture:true});
  root.addEventListener('pointercancel',event=>{
    if(pointer?.id===event.pointerId){isolate(event);cancelPointer('pointercancel');}
  },{capture:true});
  root.addEventListener('lostpointercapture',event=>{
    if(pointer?.id===event.pointerId)cancelPointer('lostpointercapture');
  },{capture:true});
  root.addEventListener('pointerup',event=>{
    if(!pointer||pointer.id!==event.pointerId)return;
    isolate(event);
    const state=pointer;
    const valid=!state.moved&&Math.hypot(event.clientX-state.x,event.clientY-state.y)<=MOVE_LIMIT;
    pointer=null;
    clearTimeout(state.timer);
    try{root.releasePointerCapture(state.id);}catch{}
    if(!valid){lastTapAt=0;if(state.holding)onHoldCancel({entry:state.entry,reason:'drag'});return;}
    if(state.holding){onHoldEnd({entry:state.entry,event});return;}
    const now=Date.now();
    if(now-state.startedAt>=HOLD_MS){lastTapAt=0;return;}
    if(state.secondTap){
      lastTapAt=0;
      // Keep the hit target visible until the synthesized click is consumed.
      // Some Tesla browsers omit that click, so also provide a short fallback.
      if(event.pointerType==='touch')touchDismissTimer=setTimeout(()=>dismiss(),TOUCH_CLICK_WAIT_MS);
      else dismiss(event);
    }else lastTapAt=now;
  },{capture:true});
  // Native and synthesized clicks must never pass through the visual to the player.
  root.addEventListener('click',event=>{
    isolate(event);
    if(touchDismissTimer!==null&&event.button===0)dismiss(event);
  },{capture:true});
  root.addEventListener('contextmenu',isolate,{capture:true});
  setPhase('standby');
  return Object.freeze({
    open,close,setPhase,setStatus,setTranscript,attachToFullscreen,
    get active(){return !root.hidden;},
    get phase(){return mode;},
    get entry(){return entry;},
    get element(){return root;},
    destroy(){
      close();
      doc.removeEventListener('focusin',containFocus,true);
      doc.removeEventListener('keydown',handleDocumentKeydown,true);
      doc.removeEventListener('keyup',handleDocumentKeyup,true);
      doc.defaultView?.removeEventListener('blur',onWindowBlur);
      root.remove();
    },
  });
}
