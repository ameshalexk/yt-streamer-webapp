import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const clientPath = process.env.APNE_EPISODE_UI_TEST_PATH ||
  path.resolve(import.meta.dirname, '../public/apne-episode-ui.js');
const code=await fs.readFile(clientPath,'utf8');
const flush=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};

function createHarness(states,post,episodeKey='2026-09-23') {
  const listeners={},dom={};
  let redirect=null;
  let timerId=0;
  const timers=new Map();
  const requests=[];
  const make=(id='',dataset={})=>{
    const events={};
    return {id,dataset,disabled:false,hidden:false,style:{},textContent:'',
      attributes:{},
      addEventListener(n,fn){(events[n] ||= []).push(fn);},
      click(){for(const fn of events.click||[])fn();},
      setAttribute(n,v){this.attributes[n]=v;},
    };
  };
  const sourceApne=make('',{apneProvider:'apne'}), sourceYodesi=make('',{apneProvider:'yodesi'});
  sourceYodesi.hidden=true;
  const panel=make('apneEpisodeControls',{showId:'udne-ki-aasha',dateKey:episodeKey});
  panel.querySelectorAll=()=>[sourceApne,sourceYodesi];
  const video=make('apneLiveVideo',{source:'/apne/live/source/udne-ki-aasha/2026-09-23'});
  dom['#apneEpisodeControls']=panel;dom['#apneLiveVideo']=video;
  dom['#apneSourceQuality']=make('apneSourceQuality');
  dom['#apneDownloadState']=make('apneDownloadState');
  dom['#apneDownloadMac']=make('apneDownloadMac');
  dom['#apneStreamMac']=make('apneStreamMac');dom['#apneStreamMac'].hidden=true;
  const document={
    hidden:false,querySelector(k){return dom[k]||null;},
    addEventListener(n,fn){(listeners[n] ||= []).push(fn);},
  };
  const window={
    addEventListener(n,fn){(listeners[n] ||= []).push(fn);},
    dispatchEvent(e){for(const fn of listeners[e.type]||[])fn(e);},
    location:{assign(v){redirect=v;}}
  };
  const timeout=(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;};
  const json={get:0};
  const fetch=async(url,options)=>{
    requests.push({url,options});
    if(options?.method==='POST')return {ok:true,status:202,headers:{get:()=> 'application/json'},json:async()=>post};
    const value=states[Math.min(json.get++,states.length-1)];
    return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>value};
  };
  vm.runInNewContext(code,{document,window,fetch,URLSearchParams,
    location:{search:''},Event:class Event{constructor(type){this.type=type}},
    setTimeout:timeout,clearTimeout(id){timers.delete(id)},
    console},{timeout:1800});
  return {dom,requests,sourceApne,sourceYodesi,timers,document,window,
    get redirect(){return redirect},
    async flush(){await flush()},
    async poll(){const scheduled=[...timers].find(([,v])=>v.ms===6000);if(!scheduled)throw Error('No download poll');timers.delete(scheduled[0]);scheduled[1].fn();await flush()}};
}

const state=(status,itemId=null)=>({
  sources:[{id:'apne'},{id:'yodesi'}],download:{status,itemId,
    detail:status==='Downloading'?'Downloading to Mac…':'',error:status==='Failed'?'Upstream timeout':null}
});

test('source buttons display both providers and switch with explicit source param',async()=>{
  const h=createHarness([state('Not downloaded')]);
  await h.flush();
  assert.equal(h.sourceYodesi.hidden,false);
  h.sourceYodesi.click();
  assert.match(h.dom['#apneLiveVideo'].dataset.source,/provider=yodesi$/);
  assert.equal(h.sourceYodesi.attributes['aria-pressed'],'true');
  assert.match(h.dom['#apneSourceQuality'].textContent,/Resolution cannot be verified/);
  h.sourceApne.click();
  assert.match(h.dom['#apneLiveVideo'].dataset.source,/provider=apne$/);
});

test('Download to Mac starts a job, changes loading color, then shows Stream from Mac',async()=>{
  const h=createHarness([state('Not downloaded'),state('Downloading'),state('Downloading'),state('Downloaded','saved-123')],
    {status:'Checking',detail:'Resolving APNE stream…'});
  await h.flush();
  h.dom['#apneDownloadMac'].click();
  await h.flush();
  assert.equal(h.requests.filter(x=>x.options.method==='POST').length,1);
  assert.equal(h.dom['#apneDownloadMac'].dataset.status,'downloading');
  await h.poll();
  assert.equal(h.dom['#apneDownloadMac'].disabled,true);
  await h.poll();
  assert.equal(h.dom['#apneDownloadMac'].hidden,true);
  assert.equal(h.dom['#apneStreamMac'].hidden,false);
  assert.match(h.dom['#apneDownloadState'].textContent,/Downloaded/);
  h.dom['#apneStreamMac'].click();
  assert.equal(h.redirect,'/apne/watch/saved-123');
});

test('failed download allows retry and does not fake saved file',async()=>{
  const h=createHarness([state('Failed')]);
  await h.flush();
  assert.equal(h.dom['#apneDownloadMac'].hidden,false);
  assert.equal(h.dom['#apneDownloadMac'].disabled,false);
  assert.match(h.dom['#apneDownloadMac'].textContent,/Retry Download/);
  assert.equal(h.dom['#apneStreamMac'].hidden,true);
});

test('unsupported YoDesi source stays hidden',async()=>{
  const h=createHarness([{sources:[{id:'apne'}],download:{status:'Not downloaded'}}]);
  await h.flush();
  assert.equal(h.sourceYodesi.hidden,true);
});


test('numbered episode date retains APNE download controls and source identity',async()=>{
  const h=createHarness([{sources:[{id:'apne'}],download:{status:'Not downloaded'}}],null,'2026-10-16-e15');
  await h.flush();
  assert.equal(h.requests[0].url,'/api/apne/episode/udne-ki-aasha/2026-10-16-e15');
  assert.equal(h.dom['#apneDownloadMac'].hidden,false);
  assert.equal(h.sourceYodesi.hidden,true);
});
