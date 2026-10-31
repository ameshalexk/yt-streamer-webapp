import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const playerPath = process.env.APNE_PLAYER_TEST_PATH || path.resolve(import.meta.dirname, '../public/apne-live-player.js');
const source = await fs.readFile(playerPath, 'utf8');
const tick = async () => { for(let i=0;i<15;i++) await Promise.resolve(); };

function harness(responders=[]) {
  const timers=new Map(), hits=[]; let nextTimer=1,fetchIndex=0;
  function element(tag='div'){
    const listeners={};
    return {tag,hidden:false,style:{},textContent:'',children:[],attrs:{},
      addEventListener(name,fn){(listeners[name] ||= []).push(fn);},
      dispatch(name){for(const fn of listeners[name]||[])fn();},
      setAttribute(name,v){this.attrs[name]=v;},
      replaceChildren(...kids){this.children=kids;},
      appendChild(kid){this.children.push(kid);},
      insertAdjacentElement(_position,kid){this.retry=kid;},
    };
  }
  const video=element('video'),status=element('p'),stage=element(),controls=element();
  stage.hidden=true;controls.hidden=true;
  video.dataset={source:'/apne/live/source/udne-ki-aasha/2026-09-23'};
  Object.assign(video,{readyState:0,paused:true,ended:false,currentTime:0,
    seekable:{length:0},canPlayType:()=> 'maybe',
    load(){this.readyState=0;}, removeAttribute(name){if(name==='src')this.src='';},
    async play(){this.paused=false;this.dispatch('playing');},
    pause(){this.paused=true;this.dispatch('pause');}});
  const dom={'#apneLiveVideo':video,'#apneLiveStatus':status,
    '#apneEmbedStage':stage,'#apnePartButtons':controls};
  const document={querySelector(s){return dom[s];},createElement:element,
    head:{appendChild(){throw Error('Unexpected HLS player request');}}};
  const timersAPI={
    setTimeout(fn,ms){const id=nextTimer++;timers.set(id,{fn,ms});return id;},
    clearTimeout(id){timers.delete(id);},
  };
  const fetch=async(url,options)=>{
    hits.push({url,options});
    const response=responders[Math.min(fetchIndex++,responders.length-1)];
    if(response instanceof Error)throw response;
    if(typeof response==='function')return response(options);
    return {ok:true,status:200,json:async()=>response||{format:'mp4',src:'/apne/live/mp4/default'}};
  };
  const winListeners={};
  const window={
    addEventListener(name,fn){(winListeners[name] ||= []).push(fn);},
    dispatchEvent(evt){for(const fn of winListeners[evt.type]||[])fn(evt);},
  };
  vm.runInNewContext(source,{document,window,fetch,URL,Event,setTimeout:timersAPI.setTimeout,
    clearTimeout:timersAPI.clearTimeout,AbortController,console},{timeout:2000});
  return {video,status,stage,controls,hits,timers,window,
    async settle(){await tick();},
    async fireTimers(ms){for(const [id,t] of [...timers])if(t.ms===ms){timers.delete(id);t.fn();}await tick();},
    clickRetry(){status.retry.dispatch('click');}};
}
test('MP4 resolves and metadata reports ready',async()=>{
  const h=harness([{format:'mp4',src:'/apne/live/mp4/id123'}]);
  await h.settle();
  assert.match(h.status.textContent,/MP4 found/);
  assert.equal(h.video.src,'/apne/live/mp4/id123');
  h.video.readyState=1;h.video.dispatch('loadedmetadata');
  assert.match(h.status.textContent,/Ready/);
  assert.equal(h.status.retry.hidden,true);
});
test('transient failure retries once',async()=>{
  const h=harness([new Error('Network interruption'),{format:'mp4',src:'/apne/live/mp4/new'}]);
  await h.settle();
  assert.equal(h.hits.length,2);
  assert.equal(h.video.src,'/apne/live/mp4/new');
});
test('authorization failure shows sign-in message without automatic retry',async()=>{
  const h=harness([()=>({ok:false,status:401})]);
  await h.settle();
  assert.equal(h.hits.length,1);
  assert.match(h.status.textContent,/sign-in may have expired/);
  assert.equal(h.status.retry.hidden,false);
});
test('missing provider video stops automatic retries and permits a later manual recheck',async()=>{
  const h=harness([
    ()=>({ok:false,status:424,json:async()=>({code:'APNE_UPSTREAM_VIDEO_MISSING',error:'<script>untrusted provider detail</script>'})}),
    {format:'mp4',src:'/apne/live/mp4/restored'},
  ]);
  await h.settle();
  assert.equal(h.hits.length,1);
  assert.match(h.status.textContent,/provider has no playable video.*Check again later/);
  assert.doesNotMatch(h.status.textContent,/untrusted|<script>|Tap Retry/);
  assert.equal(h.status.retry.textContent,'Check again');
  assert.equal(h.status.retry.hidden,false);
  assert.equal(h.video.paused,true);
  assert.equal(h.timers.size,0);
  h.clickRetry();await h.settle();
  assert.equal(h.hits.length,2);
  assert.equal(h.video.src,'/apne/live/mp4/restored');
  assert.equal(h.status.retry.hidden,true);
  assert.equal(h.status.retry.textContent,'Retry video');
});
test('unrecognized or non-JSON source errors retain one automatic retry',async()=>{
  for(const [status,json] of [
    [424,async()=>({code:'UNKNOWN',error:'private upstream URL'})],
    [502,async()=>({code:'UNKNOWN',error:'private upstream URL'})],
    [502,async()=>{throw new Error('HTML response');}],
    [503,async()=>({code:'UPSTREAM_BUSY',error:'private upstream URL'})],
  ]){
    const h=harness([()=>({ok:false,status,json}),{format:'mp4',src:'/apne/live/mp4/recovered'}]);
    await h.settle();
    assert.equal(h.hits.length,2);
    assert.equal(h.video.src,'/apne/live/mp4/recovered');
    assert.doesNotMatch(h.status.textContent,/private upstream/);
  }
});
test('startup timeout retries once, then manual retry is possible',async()=>{
  const h=harness([{format:'mp4',src:'/apne/live/mp4/first'},{format:'mp4',src:'/apne/live/mp4/second'}]);
  await h.settle();
  await h.fireTimers(85000);
  assert.equal(h.hits.length,2);
  assert.equal(h.video.src,'/apne/live/mp4/second');
  await h.fireTimers(85000);
  assert.equal(h.hits.length,2);
  assert.match(h.status.textContent,/Retry video/);
  h.clickRetry();await h.settle();
  assert.equal(h.hits.length,3);
});
test('native media error recovers once and then reports failure',async()=>{
  const h=harness([{format:'mp4',src:'/apne/live/mp4/first'},{format:'mp4',src:'/apne/live/mp4/second'}]);
  await h.settle();
  h.video.error={code:2};h.video.dispatch('error');await h.settle();
  assert.equal(h.hits.length,2);
  h.video.dispatch('error');await h.settle();
  assert.equal(h.hits.length,2);
  assert.equal(h.status.retry.hidden,false);
});
test('embedded parts preserve existing switching',async()=>{
  const h=harness([{format:'embed',parts:['https://www.blogger.com/video.g?token='+'a'.repeat(60)]}]);
  await h.settle();
  assert.equal(h.video.hidden,true);
  assert.equal(h.stage.hidden,false);
  assert.equal(h.controls.children.length,1);
  assert.match(h.status.textContent,/Part 1 of 1/);
});

test('manual switch from APNE to YoDesi and back restores native player',async()=>{
  const token='b'.repeat(60);
  const h=harness([{format:'mp4',src:'/apne/live/mp4/one'},
    {format:'embed',parts:['https://www.blogger.com/video.g?token='+token]},
    {format:'mp4',src:'/apne/live/mp4/two'}]);
  await h.settle();
  h.video.dataset.source='/apne/live/source/udne-ki-aasha/2026-09-23?provider=yodesi';
  h.window.dispatchEvent({type:'apne:source-change'});
  await h.settle();
  assert.equal(h.video.hidden,true);
  assert.equal(h.stage.hidden,false);
  assert.match(h.hits[1].url,/provider=yodesi/);
  h.video.dataset.source='/apne/live/source/udne-ki-aasha/2026-09-23?provider=apne';
  h.window.dispatchEvent({type:'apne:source-change'});
  await h.settle();
  assert.equal(h.video.hidden,false);
  assert.equal(h.stage.hidden,true);
  assert.equal(h.stage.children.length,0);
  assert.equal(h.video.src,'/apne/live/mp4/two');
});
