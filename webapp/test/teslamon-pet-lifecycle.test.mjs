import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createTeslaMonPetLifecycle} from '../public/teslamon-pet-lifecycle.js';

const deferred=()=>{
  let resolve;
  const promise=new Promise(r=>{resolve=r;});
  return {promise,resolve};
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const answer=value=>({status:200,json:async()=>value});

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

async function launchPet(fetchImpl,{local=false}={}){
  let captureOptions;
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
    getBoundingClientRect(){return {left:0,top:0,right:300,bottom:300};}
    setPointerCapture(){}
    querySelector(selector){return elements.get(selector)||new Element(selector);}
    querySelectorAll(){return actions;}
  }
  const ids=['#tmFace','#tmHandle','#tmPanel','#tmState','#tmDevices','#tmMic',
    '#tmText','#tmChoices','#tmModelLabel','#tmModelOptIn','#tmClose','#tmRefresh','#tmForm'];
  for(const id of ids)elements.set(id,new Element(id));
  const actions=['pause','resume','get_playback_state','request_fullscreen','exit_fullscreen']
    .map(key=>{const e=new Element();e.dataset.tm=key;return e;});
  const pet=new Element('#teslamonPet');pet.querySelector=s=>elements.get(s);
  pet.querySelectorAll=()=>actions;
  const window={listeners:{},addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);},
    SpeechRecognition:class{start(){} stop(){} abort(){}}};
  if(local)window.MediaRecorder=class{};
  const document={hidden:false,listeners:{},body:{append(){}},
    createElement(tag){return tag==='aside'?pet:new Element(tag);},
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}};
  const context={location:{hostname:'stream.ameshalex.com',protocol:'https:'},document,window,
    navigator:local?{mediaDevices:{getUserMedia:()=>Promise.resolve({})}}:{},innerWidth:390,innerHeight:844,localStorage:{getItem(){return null;},setItem(){}},
    Option:class{constructor(text,value){this.text=text;this.value=value;}},fetch:fetchImpl,
    interpretTeslaMon:()=>({error:'Use optional AI'}),
    createTeslaMonCapture:options=>{captureOptions=options;return {};},bindTeslaMonCaptureButton:()=>({dispose(){},targetChanged(){}}),
    createTeslaMonPetLifecycle,AbortController,console};
  const source=(await readFile(new URL('../public/teslamon-pet.js',import.meta.url),'utf8'))
    .replace(/^import .*;\n/gm,'');
  vm.runInNewContext(source,context);
  return {elements,window,document,actions,get captureOptions(){return captureOptions;}};
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
