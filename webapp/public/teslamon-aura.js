// TeslaMon Aura is presentation only; it never owns a microphone or command.
const PHASES=new Set(['standby','preparing','listening','transcribing','thinking','acting','complete','error']);
export function createTeslaMonAura({document:doc=globalThis.document,onDismiss=()=>{}}={}){
  if(!doc?.body)throw new TypeError('Aura needs a document with a body');
  const root=doc.createElement('section');
  root.id='tmAura';
  root.className='tm-aura';
  root.hidden=true;
  root.tabIndex=0;
  root.setAttribute('role','dialog');
  root.setAttribute('aria-modal','true');
  root.setAttribute('aria-label','TeslaMon Aura. Tap anywhere or press Escape to exit the visual.');
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
  let mode='standby',entry=0,pointer=null,ignoreMouseClick=false,touchDismissTimer=null;
  function owned(token){return token===undefined||token===entry;}
  function setPhase(next,{entry:token}={}){
    if(!owned(token))return false;
    mode=PHASES.has(next)?next:'standby';
    root.dataset.phase=mode;
    return true;
  }
  function setStatus(value,{kind='info',entry:token}={}){
    if(!owned(token))return false;
    detail.textContent=String(value||'').slice(0,140);
    detail.dataset.kind=kind==='warn'?'warn':'info';
    return true;
  }
  function attachToFullscreen(){
    const host=doc.fullscreenElement||doc.webkitFullscreenElement||doc.body;
    if(root.parentElement!==host)host.append(root);
  }
  function open({phase='standby',status=''}={}){
    attachToFullscreen();
    entry++;
    ignoreMouseClick=false;
    root.hidden=false;
    setPhase(phase);
    setStatus(status);
    try{root.focus({preventScroll:true});}catch{root.focus();}
    return entry;
  }
  function close(){
    if(root.hidden)return;
    root.hidden=true;
    if(doc.activeElement===root)try{root.blur();}catch{}
    pointer=null;
    if(touchDismissTimer!==null){clearTimeout(touchDismissTimer);touchDismissTimer=null;}
  }
  function dismiss(event){
    if(root.hidden)return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    close();
    onDismiss(entry,event?.type==='keydown'?'keyboard':'pointer');
  }
  root.addEventListener('pointerdown',event=>{
    pointer=event.isPrimary&&event.button===0?
      {id:event.pointerId,x:event.clientX,y:event.clientY,moved:false}:null;
  });
  root.addEventListener('pointermove',event=>{
    if(pointer?.id===event.pointerId&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>12)
      pointer.moved=true;
  });
  root.addEventListener('pointercancel',()=>{pointer=null;});
  root.addEventListener('pointerup',event=>{
    if(!pointer||pointer.id!==event.pointerId)return;
    const valid=!pointer.moved&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)<=12;
    pointer=null;
    if(event.pointerType==='touch'&&valid){
      // Keep the overlay hit target through the browser's synthesized click.
      // Some Tesla browsers omit that click, so a short fallback closes it.
      event.preventDefault();event.stopPropagation();
      touchDismissTimer=setTimeout(()=>{touchDismissTimer=null;dismiss();},180);
    }else if(event.pointerType!=='touch')ignoreMouseClick=!valid;
  });
  root.addEventListener('click',event=>{
    if(event.button!==0)return;
    if(ignoreMouseClick){ignoreMouseClick=false;event.preventDefault();event.stopPropagation();return;}
    dismiss(event);
  });
  root.addEventListener('keydown',event=>{
    if(event.key==='Escape'){dismiss(event);}
  });
  setPhase('standby');
  return Object.freeze({
    open,close,setPhase,setStatus,attachToFullscreen,
    setTranscript(){}, // compatibility: no separate transcript card in Aura
    get active(){return !root.hidden;},
    get phase(){return mode;},
    get entry(){return entry;},
    get element(){return root;},
    destroy(){close();root.remove();},
  });
}
