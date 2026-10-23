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
  const calls=[];
  const screen={classList:{contains:name=>name==='playing'}};
  const context={
    location:{hostname,search:''},URLSearchParams,performance:{now:()=>0},
    document:{querySelector:selector=>selector==='#screen'?screen:null},
    activeCompat:null,replayFn:null,state:{},streamAttempt:0,playbackPaused:false,
    getStreamCurrentTime:()=>0,streamSeek:{duration:0},
  };
  if(control)context.YTStreamerTeslaMonFullscreen={
    kind:()=>mode,
    enter:()=>{calls.push('enter');mode='in_page';return Promise.resolve();},
    exit:()=>{calls.push('exit');mode='none';return Promise.resolve();}
  };
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'ai-media-agent-adapter.js'});
  return {context,calls,get mode(){return mode},
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
