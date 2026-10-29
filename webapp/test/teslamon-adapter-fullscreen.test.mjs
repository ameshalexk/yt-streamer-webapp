import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createTeslaMonLocalPlayer} from '../public/teslamon-local-player.js';

// Run the actual browser adapter, rather than a mock facade. This caught the
// missing fullscreen branch despite existing local-player unit tests passing.
const source=fs.readFileSync(new URL('../public/ai-media-agent-adapter.js',import.meta.url),'utf8');
function setup({hostname='stream.ameshalex.com',control=true}={}){
  let mode='none';
  const calls=[],requests=[];
  const screen={classList:{contains:name=>name==='playing'}};
  const context={
    location:{hostname,search:''},URLSearchParams,performance:{now:()=>0},
    document:{querySelector:selector=>selector==='#screen'?screen:null},
    activeCompat:null,replayFn:null,state:{},streamAttempt:0,playbackPaused:false,
    getStreamCurrentTime:()=>0,streamSeek:{duration:0},
    api:{get:async url=>{requests.push(url);return {items:[{id:'ESABTN4VtrA',title:'Newest'}]};}},
  };
  if(control)context.YTStreamerTeslaMonFullscreen={
    kind:()=>mode,
    enter:()=>{calls.push('enter');mode='in_page';return Promise.resolve();},
    exit:()=>{calls.push('exit');mode='none';return Promise.resolve();}
  };
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'ai-media-agent-adapter.js'});
  return {context,calls,requests,get mode(){return mode},
    player:createTeslaMonLocalPlayer({getPlayer:()=>context.YTStreamerMediaAgent})};
}

test('pet Fullscreen directly enters existing player, then reports in-page state',async()=>{
  const {player,calls}=setup();
  const pending=player.run({tool:'request_fullscreen',args:{}});
  assert.deepEqual(calls,['enter'],'fullscreen starts synchronously within the click gesture');
  const result=await pending;
  assert.equal(result.status,'observed');
  assert.equal(result.fullscreenMode,'in_page');
});

test('pet Exit fullscreen uses existing player and reports none',async()=>{
  const {player,calls}=setup();
  await player.run({tool:'request_fullscreen',args:{}});
  const result=await player.run({tool:'exit_fullscreen',args:{}});
  assert.deepEqual(calls,['enter','exit']);
  assert.equal(result.status,'observed');
  assert.equal(result.fullscreenMode,'none');
});

test('fullscreen controls do not wait for an in-progress asynchronous resume',async()=>{
  const x=setup();
  let release;
  x.context.replayFn=()=>{};
  x.context.resumePlayback=()=>new Promise(resolve=>{release=resolve});
  const resuming=x.context.YTStreamerMediaAgent.execute('resume',{});
  // The queued resume starts on the next microtask, but must not capture or
  // delay the trusted user activation of a separate fullscreen click.
  const fullscreen=x.context.YTStreamerMediaAgent.execute('request_fullscreen',{});
  assert.deepEqual(x.calls,['enter']);
  assert.equal((await fullscreen).status,'completed');
  await Promise.resolve();
  release();
  await resuming;
});

test('adapter returns unsupported rather than claiming fullscreen with no hook',async()=>{
  const x=setup({control:false});
  const response=await x.player.run({tool:'request_fullscreen',args:{}});
  assert.equal(response.status,'unsupported');
  assert.equal(x.context.YTStreamerMediaAgent.get_player_state().fullscreen_kind,'unknown');
});

test('native fullscreen permission denial is reported without a false success',async()=>{
  const x=setup();
  x.context.YTStreamerTeslaMonFullscreen.enter=()=>{
    throw Object.assign(new Error('blocked'),{name:'NotAllowedError'});
  };
  const response=await x.player.run({tool:'request_fullscreen',args:{}});
  assert.equal(response.status,'needs_user_gesture');
  assert.equal(x.context.YTStreamerMediaAgent.get_player_state().fullscreen_kind,'none');
});

test('adapter remains restricted to the authorized production host',()=>{
  const x=setup({hostname:'another.example'});
  assert.equal(x.context.YTStreamerMediaAgent,undefined);
  assert.equal(x.player.ready,false);
});

test('adapter routes latest-MKBHD search to reviewed channel upload feed',async()=>{
  const x=setup();
  const newest=await x.context.YTStreamerMediaAgent.execute('search_media',{
    query:'latest MKBHD video',source:'latest_mkbhd',limit:8});
  assert.equal(newest.status,'completed');
  assert.equal(newest.result.results[0].media_id,'ESABTN4VtrA');
  assert.equal(x.requests[0],'/api/youtube/latest-channel?channel=mkbhd&limit=8');
  await x.context.YTStreamerMediaAgent.execute('search_media',{query:'ordinary clip',limit:5});
  assert.equal(x.requests[1],'/api/youtube/search?q=ordinary%20clip&limit=5');
});

test('wake pause bypasses a pending resume and reasserts pause on late completion',async()=>{
  const x=setup();
  let release;
  x.context.replayFn=()=>{};
  x.context.pausePlayback=()=>{x.calls.push('pause');x.context.playbackPaused=true;};
  x.context.resumePlayback=()=>new Promise(resolve=>{release=()=>{
    x.context.playbackPaused=false;resolve();};});
  const resuming=x.context.YTStreamerMediaAgent.execute('resume',{});
  await Promise.resolve();
  assert.equal(typeof release,'function');
  const wake=await x.context.YTStreamerMediaAgent.execute('pause_for_voice',{});
  assert.equal(wake.status,'completed');
  assert.deepEqual(x.calls,['pause'],'pause runs before the unsettled resume settles');
  release();await resuming;
  assert.deepEqual(x.calls,['pause','pause'],'old resume cannot leave playback running');
});

test('old queued controls are fenced rather than firing after wake deadline',async()=>{
  const x=setup();
  let release;
  x.context.replayFn=()=>{};
  x.context.pausePlayback=()=>x.calls.push('pause');
  x.context.resumePlayback=()=>new Promise(resolve=>{release=resolve;});
  const resuming=x.context.YTStreamerMediaAgent.execute('resume',{});
  const stalePause=x.context.YTStreamerMediaAgent.execute('pause',{});
  await Promise.resolve();
  assert.equal((await x.context.YTStreamerMediaAgent.execute('pause_for_voice',{})).status,'completed');
  release();
  await resuming;
  assert.equal((await stalePause).status,'cancelled');
  assert.deepEqual(x.calls,['pause','pause'],'only priority pause and completion fence run');
});

test('wake pause bypasses a pending play, and late play cannot resume media',async()=>{
  const x=setup();
  let release;
  x.context.replayFn=()=>{};
  x.context.pausePlayback=()=>x.calls.push('pause');
  await x.context.YTStreamerMediaAgent.execute('search_media',{query:'latest MKBHD',limit:2});
  x.context.streamYoutubeSearchResult=()=>new Promise(resolve=>{release=resolve;});
  const playing=x.context.YTStreamerMediaAgent.execute('play_media',{media_id:'ESABTN4VtrA'});
  await Promise.resolve();
  const paused=await x.context.YTStreamerMediaAgent.execute('pause_for_voice',{});
  assert.equal(paused.status,'completed');
  assert.deepEqual(x.calls,['pause']);
  release();
  await playing;
  assert.deepEqual(x.calls,['pause','pause']);
});
