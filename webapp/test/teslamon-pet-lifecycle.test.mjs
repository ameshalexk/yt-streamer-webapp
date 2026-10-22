import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createTeslaMonPetLifecycle} from '../public/teslamon-pet-lifecycle.js';
import {calculateTeslaMonPetPosition} from '../public/teslamon-pet-position.js';

const deferred=()=>{
  let resolve;
  const promise=new Promise(r=>{resolve=r;});
  return {promise,resolve};
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const answer=value=>({status:200,json:async()=>value});

test('pet position clamps the pet and panel to safe visual viewport bounds',()=>{
  const p=calculateTeslaMonPetPosition({
    viewport:{width:320,height:260,offsetLeft:12,offsetTop:180},
    safeArea:{left:4,right:8,top:12,bottom:20},
    pet:{width:128,height:72},panel:{width:300,height:400},
    saved:{x:-90,y:900},
  });
  assert.equal(p.petLeft,16);
  assert.equal(p.petTop,348);
  assert.equal(p.panelLeft,24);
  assert.equal(p.panelTop,200);
  assert.equal(p.panelMaxHeight,212);
  assert.ok(p.panelTop>=200&&p.panelTop+p.panelMaxHeight<=412);
});

test('reset position returns to the safe lower-right corner regardless of saved location',()=>{
  const p=calculateTeslaMonPetPosition({viewport:{width:390,height:844},
    safeArea:{right:8,bottom:20},pet:{width:128,height:72},
    panel:{width:336,height:420},saved:{x:10,y:10},reset:true});
  assert.equal(p.petLeft,254);
  assert.equal(p.petTop,752);
});

test('superseded pre-dispatch requests are aborted and cannot remain current',()=>{
  const lifecycle=createTeslaMonPetLifecycle();
  const old=lifecycle.begin('interpret');
  const current=lifecycle.begin('interpret');
  assert.equal(old.signal.aborted,true);
  assert.equal(old.current(),false);
  assert.equal(current.current(),true);
  lifecycle.cancelAll();
  assert.equal(current.signal.aborted,true);
  assert.equal(current.current(),false);
});

async function launchPet(fetchImpl,{local=false,speechBehavior={},interpretImpl=()=>({error:'Use optional AI'})}={}){
  let captureOptions,captureCancelCount=0;
  const speechSessions=[],timers=new Map();let nextTimer=0;
  const elements=new Map();
  class Element{
    constructor(id=''){this.id=id;this.listeners={};this.dataset={};this.style={};
      this.value='';this.hidden=false;this.disabled=false;this.children=[];this.attributes={};}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    fire(name,event={}){for(const fn of this.listeners[name]||[])fn({preventDefault(){},...event});}
    setAttribute(k,v){this.attributes[k]=v;}
    focus(){}
    replaceChildren(...nodes){this.children=nodes;}
    append(node){this.children.push(node);}
    get offsetLeft(){return parseFloat(this.style.left)||0;}
    get offsetTop(){return parseFloat(this.style.top)||0;}
    get offsetWidth(){return this.id==='#teslamonPet'?128:0;}
    get offsetHeight(){return this.id==='#teslamonPet'?72:0;}
    get scrollHeight(){return 420;}
    getBoundingClientRect(){const left=this.offsetLeft,top=this.offsetTop;return {left,top,right:left+this.offsetWidth,bottom:top+this.offsetHeight,width:this.offsetWidth,height:this.offsetHeight};}
    setPointerCapture(){}
    querySelector(selector){return elements.get(selector)||new Element(selector);}
    querySelectorAll(){return actions;}
  }
  const ids=['#tmFace','#tmHandle','#tmPanel','#tmState','#tmDevices','#tmMic',
    '#tmText','#tmChoices','#tmModelLabel','#tmModelOptIn','#tmClose','#tmRefresh','#tmForm',
    '#tmCancel','#tmResetPosition','#tmTranscript','#tmTranscriptRow','#tmEditTranscript'];
  for(const id of ids)elements.set(id,new Element(id));
  const actions=['pause','resume','get_playback_state','request_fullscreen','exit_fullscreen']
    .map(key=>{const e=new Element();e.dataset.tm=key;return e;});
  const pet=new Element('#teslamonPet');pet.querySelector=s=>elements.get(s);
  pet.querySelectorAll=()=>actions;
  const window={listeners:{},addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},
    SpeechRecognition:class{
      constructor(){if(speechBehavior.constructorThrows)throw Error('constructor failed');this.aborted=false;this.stopped=false;speechSessions.push(this);}
      start(){if(speechBehavior.startThrows)throw Error('start failed');if(speechBehavior.endOnStart)this.onend?.();}
      stop(){this.stopped=true;if(speechBehavior.endOnStop)this.onend?.();if(speechBehavior.stopThrows)throw Error('stop failed');}
      abort(){this.aborted=true;if(speechBehavior.endOnAbort)this.onend?.();}
    }};
  if(local)window.MediaRecorder=class{};
  const document={hidden:false,listeners:{},body:{append(){}},
    createElement(tag){return tag==='aside'?pet:new Element(tag);},
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}};
  const context={location:{hostname:'stream.ameshalex.com',protocol:'https:'},document,window,
    navigator:local?{mediaDevices:{getUserMedia:()=>Promise.resolve({})}}:{},innerWidth:390,innerHeight:844,localStorage:{getItem(){return null;},setItem(){}},
    Option:class{constructor(text,value){this.text=text;this.value=value;}},fetch:fetchImpl,
    interpretTeslaMon:interpretImpl,
    createTeslaMonCapture:options=>{captureOptions=options;return {cancel(){captureCancelCount++;}};},bindTeslaMonCaptureButton:()=>({dispose(){},targetChanged(){}}),
    createTeslaMonPetLifecycle,calculateTeslaMonPetPosition,AbortController,console,
    getComputedStyle:()=>({getPropertyValue:()=> '0px'}),
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);}};
  const source=(await readFile(new URL('../public/teslamon-pet.js',import.meta.url),'utf8'))
    .replace(/^import .*;\n/gm,'');
  vm.runInNewContext(source,context);
  return {elements,pet,window,document,actions,speechSessions,timers,
    fireTimers(){for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}},
    get captureCancelCount(){return captureCancelCount;},
    get captureOptions(){return captureOptions;}};
}

test('pet serializes target selections and blocks commands until the newest target is selected',async()=>{
  const calls=[],pendingSelections=[];
  const harness=await launchPet((url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'Browser A'},{deviceKey:'B',label:'Browser B'}],
      selectedDeviceKey:'',modelConfigured:false}));
    if(url.endsWith('/select')){
      const d=deferred();pendingSelections.push({d,body:JSON.parse(options.body)});return d.promise;
    }
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw new Error(`unexpected request ${url}`);
  });
  const {elements,actions}=harness;
  elements.get('#tmFace').fire('click');await tick();
  const devices=elements.get('#tmDevices');
  devices.value='A';devices.fire('change');await tick();
  devices.value='B';devices.fire('change');await tick();
  assert.equal(pendingSelections.length,1,'second select waits for first to settle');
  actions[0].fire('click');
  assert.equal(calls.some(c=>c.url.endsWith('/command')),false,'no command during selection');
  pendingSelections[0].d.resolve(answer({status:'selected'}));await tick();await tick();
  assert.equal(pendingSelections.length,2);
  assert.equal(pendingSelections[1].body.deviceKey,'B');
  pendingSelections[1].d.resolve(answer({status:'selected'}));await tick();
  actions[0].fire('click');
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,1,
    'commands resume after target B is selected');
});

test('closing TeslaMon aborts stale AI interpretation and it cannot dispatch a command',async()=>{
  const calls=[];let interpretation;
  const harness=await launchPet((url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'Browser A'}],selectedDeviceKey:'A',modelConfigured:true}));
    if(url.endsWith('/interpret')){interpretation={d:deferred(),options};return interpretation.d.promise;}
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw new Error(`unexpected request ${url}`);
  });
  const {elements}=harness;
  elements.get('#tmFace').fire('click');await tick();
  elements.get('#tmModelOptIn').checked=true;
  elements.get('#tmText').value='do something';
  elements.get('#tmForm').fire('submit');await tick();
  assert.ok(interpretation);
  elements.get('#tmClose').fire('click');
  assert.equal(interpretation.options.signal.aborted,true);
  interpretation.d.resolve(answer({status:'ok',tool:'pause',args:{}}));await tick();await tick();
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,0);
});

test('Cancel aborts pending model interpretation before it can dispatch a tool',async()=>{
  const calls=[];let interpretation;
  const {elements}=await launchPet((url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'Browser A'}],selectedDeviceKey:'A',modelConfigured:true}));
    if(url.endsWith('/interpret')){interpretation={d:deferred(),options};return interpretation.d.promise;}
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw Error(`unexpected request ${url}`);
  });
  elements.get('#tmFace').fire('click');await tick();
  elements.get('#tmModelOptIn').checked=true;elements.get('#tmText').value='do something';
  elements.get('#tmForm').fire('submit');await tick();
  elements.get('#tmCancel').fire('click');
  assert.equal(interpretation.options.signal.aborted,true);
  interpretation.d.resolve(answer({status:'ok',tool:'pause',args:{}}));await tick();await tick();
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,0);
  assert.match(elements.get('#tmState').textContent,/canceled.*no playback command was sent/i);
});

test('Cancel aborts pending transcription and never submits its late transcript',async()=>{
  const calls=[];let transcription;
  const harness=await launchPet((url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'Browser A'}],selectedDeviceKey:'A',localTranscription:true}));
    if(url.endsWith('/transcribe')){transcription={d:deferred(),options};return transcription.d.promise;}
    throw Error(`unexpected request ${url}`);
  },{local:true});
  const {elements}=harness;
  elements.get('#tmFace').fire('click');await tick();
  harness.captureOptions.onAudio({type:'audio/webm'});await tick();
  elements.get('#tmCancel').fire('click');
  assert.equal(transcription.options.signal.aborted,true);
  transcription.d.resolve(answer({status:'ok',text:'pause'}));await tick();await tick();
  assert.equal(calls.some(c=>c.url.endsWith('/interpret')||c.url.endsWith('/command')),false);
});

test('Cancel stops an active recording and aborts native speech input',async()=>{
  const localHarness=await launchPet(url=>url.endsWith('/devices')?Promise.resolve(answer({enabled:true,
    devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A',localTranscription:true})):Promise.resolve(answer({status:'accepted'})),{local:true});
  localHarness.elements.get('#tmFace').fire('click');await tick();
  localHarness.captureOptions.onState({state:'recording'});
  localHarness.elements.get('#tmCancel').fire('click');
  assert.equal(localHarness.captureCancelCount,1);

  const nativeHarness=await launchPet(url=>url.endsWith('/devices')?Promise.resolve(answer({enabled:true,
    devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'})):Promise.resolve(answer({status:'accepted'})));
  nativeHarness.elements.get('#tmFace').fire('click');await tick();
  nativeHarness.elements.get('#tmMic').fire('click');
  const session=nativeHarness.speechSessions[0];
  nativeHarness.elements.get('#tmCancel').fire('click');
  assert.equal(session.aborted,true);
  assert.equal(nativeHarness.timers.size,0);
});

test('Cancel never aborts or replays an already dispatched playback command',async()=>{
  const calls=[],command=deferred();
  const {elements,actions}=await launchPet((url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'Browser A'}],selectedDeviceKey:'A',modelConfigured:false}));
    if(url.endsWith('/command'))return command.promise;
    throw Error(`unexpected request ${url}`);
  });
  elements.get('#tmFace').fire('click');await tick();
  actions[0].fire('click');
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,1);
  elements.get('#tmCancel').fire('click');
  assert.match(elements.get('#tmState').textContent,/already sent.*uncertain/i);
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,1);
  command.resolve(answer({status:'accepted'}));await tick();
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,1);
});

test('keyboard arrows move TeslaMon and keyboard reset restores its default position',async()=>{
  const {elements,pet}=await launchPet(url=>url.endsWith('/devices')?Promise.resolve(answer({enabled:true,
    devices:[],selectedDeviceKey:''})):Promise.resolve(answer({status:'accepted'})));
  const handle=elements.get('#tmHandle');
  handle.fire('keydown',{key:'ArrowLeft'});
  assert.equal(handle.attributes['aria-keyshortcuts'],'ArrowUp ArrowDown ArrowLeft ArrowRight');
  assert.equal(pet.style.left,'246px');
  handle.fire('keydown',{key:'ArrowRight',shiftKey:true});
  assert.equal(pet.style.left,'247px','Shift+Arrow adjusts by one CSS pixel');
  handle.fire('keydown',{key:'Home'});
  assert.equal(pet.style.left,'262px');
  elements.get('#tmHandle').fire('keydown',{key:'ArrowUp'});
  elements.get('#tmResetPosition').fire('click');
  assert.equal(pet.style.top,'772px');
});

test('pagehide resets speech bindings so a restored page can open TeslaMon again',async()=>{
  const harness=await launchPet(url=>{
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'Browser A'}],selectedDeviceKey:'A',modelConfigured:false}));
    throw new Error(`unexpected request ${url}`);
  });
  const {elements,window}=harness;
  elements.get('#tmFace').fire('click');await tick();
  assert.equal(elements.get('#tmMic').listeners.click.length,1);
  for(const fn of window.listeners.pagehide||[])fn();
  assert.equal(elements.get('#tmPanel').hidden,true);
  elements.get('#tmFace').fire('click');await tick();
  assert.equal(elements.get('#tmPanel').hidden,false);
  assert.equal(elements.get('#tmMic').listeners.click.length,1,
    'reopening does not accumulate native speech click handlers');
});

test('clearing the target waits for an in-flight select and refresh cannot reselect it',async()=>{
  let deviceReads=0;const calls=[],selection=deferred();
  const harness=await launchPet((url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/devices')){
      deviceReads++;
      return Promise.resolve(answer({enabled:true,devices:[{deviceKey:'A',label:'Browser A'}],
        selectedDeviceKey:'A',modelConfigured:false}));
    }
    if(url.endsWith('/select'))return selection.promise;
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw new Error(`unexpected request ${url}`);
  });
  const {elements,actions}=harness;
  elements.get('#tmFace').fire('click');await tick();
  const devices=elements.get('#tmDevices');devices.value='A';devices.fire('change');await tick();
  devices.value='';devices.fire('change');
  elements.get('#tmRefresh').fire('click');await tick();
  assert.equal(deviceReads,1,'refresh waits while the prior select can still mutate server state');
  selection.resolve(answer({status:'selected'}));await tick();await tick();await tick();
  assert.equal(deviceReads,2);
  actions[0].fire('click');
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,0,
    'server refresh cannot restore a target the user explicitly cleared');
});


test('reopened pet blocks playback until a fresh authority response arrives',async()=>{
  let reads=0;const delayed=deferred(),calls=[];
  const ready={enabled:true,devices:[{deviceKey:'A',label:'Browser A'}],selectedDeviceKey:'A'};
  const {elements,actions}=await launchPet((url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return ++reads===1?Promise.resolve(answer(ready)):delayed.promise;
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw Error('unexpected request');
  });
  elements.get('#tmFace').fire('click');await tick();
  elements.get('#tmClose').fire('click');
  elements.get('#tmFace').fire('click');await tick();
  actions[0].fire('click');
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,0);
  delayed.resolve(answer(ready));await tick();
  actions[0].fire('click');
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,1);
});

test('superseded device refresh cannot replace the latest selected browser',async()=>{
  const pending=[];const calls=[];
  const {elements,actions}=await launchPet((url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/devices')){const d=deferred();pending.push({d,options});return d.promise;}
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw Error('unexpected request');
  });
  elements.get('#tmFace').fire('click');await tick();
  elements.get('#tmRefresh').fire('click');await tick();
  assert.equal(pending[0].options.signal.aborted,true);
  pending[1].d.resolve(answer({enabled:true,devices:[{deviceKey:'B',label:'B'}],selectedDeviceKey:'B'}));await tick();
  pending[0].d.resolve(answer({enabled:true,devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'}));await tick();
  assert.equal(elements.get('#tmDevices').value,'B');
  actions[0].fire('click');
  assert.equal(calls.filter(c=>c.url.endsWith('/command')).length,1);
});


test('local transcription is cancelled on close and microphone cannot start without fresh selection',async()=>{
  const calls=[];let transcription;
  const harness=await launchPet((url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A',localTranscription:true}));
    if(url.endsWith('/transcribe')){transcription={d:deferred(),options};return transcription.d.promise;}
    throw Error('unexpected request');
  },{local:true});
  harness.elements.get('#tmFace').fire('click');await tick();
  harness.captureOptions.onAudio({type:'audio/webm'});await tick();
  harness.elements.get('#tmClose').fire('click');
  assert.equal(transcription.options.signal.aborted,true);
  await assert.rejects(harness.captureOptions.getUserMedia({audio:true}),/Select a connected browser/);
  transcription.d.resolve(answer({status:'ok',text:'pause'}));await tick();
  assert.equal(calls.filter(c=>c.url.endsWith('/command')||c.url.endsWith('/interpret')).length,0);
});

test('native speech times out at 20 seconds, aborts, and ignores late partial or end callbacks',async()=>{
  const calls=[];
  const harness=await launchPet(url=>{
    calls.push(url);
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A',localTranscription:false}));
    if(url.endsWith('/command')||url.endsWith('/interpret'))return Promise.resolve(answer({status:'accepted'}));
    throw Error(`unexpected request ${url}`);
  });
  const {elements,speechSessions,timers,fireTimers}=harness;
  elements.get('#tmFace').fire('click');await tick();
  elements.get('#tmMic').fire('click');
  const session=speechSessions[0];
  assert.equal(timers.size,1);
  assert.equal([...timers.values()][0].ms,20000);
  fireTimers();
  assert.equal(session.aborted,true);
  assert.match(elements.get('#tmState').textContent,/timed out after 20 seconds.*Try again or type/i);
  session.onresult({results:[[{transcript:'pause'}]]});session.onend();await tick();
  assert.equal(calls.some(url=>url.endsWith('/command')||url.endsWith('/interpret')),false,
    'terminated session cannot dispatch a late transcript');
  assert.equal(timers.size,0);
});

test('native speech cancellation on blur, hidden, target change, close, and pagehide aborts each session',async()=>{
  for(const cancel of ['blur','hidden','target','close','pagehide']){
    const harness=await launchPet(url=>url.endsWith('/devices')?Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'A'},{deviceKey:'B',label:'B'}],selectedDeviceKey:'A'})):
      Promise.resolve(answer({status:'selected'})));
    const {elements,window,document,speechSessions,timers}=harness;
    elements.get('#tmFace').fire('click');await tick();
    elements.get('#tmMic').fire('click');const session=speechSessions[0];
    if(cancel==='blur')for(const fn of window.listeners.blur||[])fn();
    if(cancel==='hidden'){document.hidden=true;for(const fn of document.listeners.visibilitychange||[])fn();}
    if(cancel==='target'){elements.get('#tmDevices').value='B';elements.get('#tmDevices').fire('change');await tick();}
    if(cancel==='close')elements.get('#tmClose').fire('click');
    if(cancel==='pagehide')for(const fn of window.listeners.pagehide||[])fn();
    assert.equal(session.aborted,true,cancel);
    assert.equal(timers.size,0,cancel+' clears timeout');
  }
});

test('native speech stop and start exceptions clean up timers and synchronous end dispatches once',async()=>{
  const calls=[];
  const harness=await launchPet(url=>{
    calls.push(url);
    if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
      devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'}));
    if(url.endsWith('/command'))return Promise.resolve(answer({status:'accepted'}));
    throw Error(`unexpected request ${url}`);
  },{speechBehavior:{endOnStop:true},interpretImpl:()=>({tool:'pause',args:{}})});
  const {elements,speechSessions,timers}=harness;
  elements.get('#tmFace').fire('click');await tick();
  elements.get('#tmMic').fire('click');
  const session=speechSessions[0];
  session.onresult({results:[[{transcript:'pause'}]]});
  elements.get('#tmMic').fire('click');await tick();await tick();
  assert.equal(session.stopped,true);
  assert.equal(timers.size,0);
  assert.equal(calls.filter(url=>url.endsWith('/command')).length,1);

  const failing=await launchPet(url=>url.endsWith('/devices')?Promise.resolve(answer({enabled:true,
    devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'})):Promise.resolve(answer({status:'accepted'})),
    {speechBehavior:{startThrows:true}});
  failing.elements.get('#tmFace').fire('click');await tick();
  failing.elements.get('#tmMic').fire('click');
  assert.equal(failing.timers.size,0,'failed start leaves no timer');
  assert.match(failing.elements.get('#tmState').textContent,/unavailable.*Type a command or retry/i);

  const stopFailure=await launchPet(url=>url.endsWith('/devices')?Promise.resolve(answer({enabled:true,
    devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'})):Promise.resolve(answer({status:'accepted'})),
    {speechBehavior:{stopThrows:true}});
  stopFailure.elements.get('#tmFace').fire('click');await tick();
  stopFailure.elements.get('#tmMic').fire('click');
  const failedSession=stopFailure.speechSessions[0];
  stopFailure.elements.get('#tmMic').fire('click');
  assert.equal(failedSession.aborted,true,'failed stop falls back to abort');
  assert.equal(stopFailure.timers.size,0,'failed stop clears timeout');
  assert.match(stopFailure.elements.get('#tmState').textContent,/failed.*Type a command or retry/i);
});


test('native speech construction failure preserves typed fallback without a timer',async()=>{
  const harness=await launchPet(url=>Promise.resolve(answer({enabled:true,
    devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'})),
    {speechBehavior:{constructorThrows:true}});
  harness.elements.get('#tmFace').fire('click');await tick();
  assert.doesNotThrow(()=>harness.elements.get('#tmMic').fire('click'));
  assert.equal(harness.timers.size,0);
  assert.match(harness.elements.get('#tmState').textContent,/unavailable.*Type a command or retry/i);
});

test('idle local capture does not claim there was active input to cancel',async()=>{
 const h=await launchPet(()=>Promise.resolve(answer({enabled:true,localTranscription:true,
  devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'})),{local:true});
 h.elements.get('#tmFace').fire('click');await tick();
 h.elements.get('#tmCancel').fire('click');
 assert.equal(h.elements.get('#tmState').textContent,'No input is in progress.');
});
test('Cancel stops concurrent speech while preserving an already sent playback command',async()=>{
 const command=deferred();let count=0;
 const h=await launchPet(url=>{
  if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,
   devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'}));
  if(url.endsWith('/command')){count++;return command.promise;}
  throw Error('unexpected');
 });
 h.elements.get('#tmFace').fire('click');await tick();
 h.actions[0].fire('click');h.elements.get('#tmMic').fire('click');
 h.elements.get('#tmCancel').fire('click');
 assert.equal(h.speechSessions[0].aborted,true);assert.equal(count,1);
 command.resolve(answer({status:'accepted'}));await tick();assert.equal(count,1);
});
test('late cancelled interpretation cannot disable Cancel for a newer transcription',async()=>{
 const old=deferred(),next=deferred();
 const h=await launchPet(url=>{
  if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,localTranscription:true,modelConfigured:true,
   devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'}));
  if(url.endsWith('/interpret'))return old.promise;
  if(url.endsWith('/transcribe'))return next.promise;
  throw Error('unexpected');
 },{local:true});
 h.elements.get('#tmFace').fire('click');await tick();
 h.elements.get('#tmModelOptIn').checked=true;h.elements.get('#tmText').value='unmatched request';
 h.elements.get('#tmForm').fire('submit');await tick();h.elements.get('#tmCancel').fire('click');
 h.captureOptions.onAudio({type:'audio/webm'});await tick();
 old.resolve(answer({status:'ok',tool:'pause',args:{}}));await tick();
 assert.equal(h.elements.get('#tmCancel').disabled,false);
 h.elements.get('#tmCancel').fire('click');
 next.resolve(answer({status:'failed',code:'transcription_cancelled'}));await tick();
});


test('pet follows a native fullscreen container and returns to the document on exit',async()=>{
 const h=await launchPet(()=>Promise.resolve(answer({enabled:true,devices:[]})));
 const host={tagName:'DIV',children:[],append(node){this.children.push(node);}};
 h.document.fullscreenElement=host;
 for(const listener of h.document.listeners.fullscreenchange)listener();
 assert.equal(host.children.length,1);
 h.document.fullscreenElement=null;
 for(const listener of h.document.listeners.fullscreenchange)assert.doesNotThrow(()=>listener());
});

test('status reports media and playback while fullscreen already active',async()=>{
 const h=await launchPet(url=>Promise.resolve(answer(url.endsWith('/devices')?{enabled:true,
  devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'}:
  {status:'observed',playbackPhase:'paused',title:'Fixture title',fullscreenMode:'native'})));
 h.elements.get('#tmFace').fire('click');await tick();
 h.actions.find(x=>x.dataset.tm==='get_playback_state').fire('click');await tick();
 assert.equal(h.elements.get('#tmState').textContent,'Paused · Fixture title');
});


test('successful speech keeps one editable transcript without automatically replaying it',async()=>{
 let commands=0;
 const h=await launchPet(url=>{
  if(url.endsWith('/devices'))return Promise.resolve(answer({enabled:true,devices:[{deviceKey:'A',label:'A'}],selectedDeviceKey:'A'}));
  if(url.endsWith('/command')){commands++;return Promise.resolve(answer({status:'observed',playbackPhase:'paused'}));}
  throw Error('unexpected');
 },{interpretImpl:()=>({tool:'pause',args:{}})});
 h.elements.get('#tmFace').fire('click');await tick();
 h.elements.get('#tmMic').fire('click');const session=h.speechSessions[0];
 session.onresult({results:[[{transcript:'please pause'}]]});session.onend();await tick();
 assert.equal(h.elements.get('#tmTranscript').textContent,'Heard: please pause');
 assert.equal(h.elements.get('#tmTranscriptRow').hidden,false);
 assert.equal(commands,1);h.elements.get('#tmEditTranscript').fire('click');await tick();
 assert.equal(h.elements.get('#tmText').value,'please pause');assert.equal(commands,1);
});
