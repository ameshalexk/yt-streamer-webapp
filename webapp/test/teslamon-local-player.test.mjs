import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonLocalPlayer} from '../public/teslamon-local-player.js';
const A='AAAaa00000_',B='BBBbb11111_';
const mk=(initial={})=>{
  let clock=100000,sequence=0,phase='idle',media='',fullscreen='none';
  const calls=[],results=initial.results??[{media_id:A,title:'Title',creator:'Channel'}];
  const facade={
    get_player_state:()=>({playback_phase:phase,media_id:media,fullscreen_kind:fullscreen}),
    execute:async(action,args)=>{
      calls.push({action,args});
      if(action==='search_media')return {status:'completed',result:{results}};
      if(action==='play_media'){media=args.media_id;phase=initial.buffer?'buffering':'playing';return {status:'accepted'};}
      if(action==='pause'){phase='paused';return {status:'completed'};}
      if(action==='resume'){phase='playing';return {status:'completed'};}
      if(action==='request_fullscreen'){fullscreen='in_page';return {status:'completed'};}
      if(action==='exit_fullscreen'){fullscreen='none';return {status:'completed'};}
      if(action==='get_player_state')return {status:'completed',state:{
        media_id:media,playback_phase:phase,fullscreen_kind:fullscreen}};
      return {status:'failed'};
    }
  };
  return {calls,facade,player:createTeslaMonLocalPlayer({
    getPlayer:()=>facade,now:()=>clock,
    makeToken:()=>('00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'))
  }),advance:ms=>{clock+=ms}};
};
test('single search plays through this page facade only',async()=>{
  const x=mk();
  assert.equal(x.player.ready,true);
  const result=await x.player.run({tool:'search_and_play',args:{query:'test movie'}});
  assert.equal(result.status,'observed');
  assert.equal(result.fullscreenAttempt,'observed');
  assert.deepEqual(x.calls.map(x=>x.action),['search_media','play_media','request_fullscreen','get_player_state']);
  assert.equal(x.calls[1].args.media_id,A);
});
test('ambiguous search returns opaque tokens and consumes chosen result once',async()=>{
  const x=mk({results:[{media_id:A,title:'One',creator:'A'},{media_id:B,title:'Two',creator:'B'}]});
  const found=await x.player.run({tool:'search_and_play',args:{query:'movie trailers'}});
  assert.equal(found.status,'needs_selection');
  assert.equal(found.choices.length,2);
  assert.ok(found.choices.every(v=>!('media_id' in v)));
  assert.deepEqual(x.calls.map(c=>c.action),['search_media']);
  assert.equal((await x.player.run({tool:'search_and_play',
    args:{candidate_token:found.choices[1].candidate_token}})).status,'observed');
  assert.equal(x.calls[1].args.media_id,B);
  assert.equal((await x.player.run({tool:'search_and_play',
    args:{candidate_token:found.choices[0].candidate_token}})).code,'stale_or_unknown_candidate');
});
test('a candidate token belongs only to the tab instance that minted it',async()=>{
  const resultSet=[{media_id:A,title:'A'},{media_id:B,title:'B'}];
  const a=mk({results:resultSet}),b=mk({results:resultSet});
  const found=await a.player.run({tool:'search_and_play',args:{query:'a movie'}});
  const attempt=await b.player.run({tool:'search_and_play',
    args:{candidate_token:found.choices[0].candidate_token}});
  assert.equal(attempt.code,'stale_or_unknown_candidate');
  assert.equal(b.calls.length,0);
});
test('candidate expires and new search invalidates previous results',async()=>{
  const x=mk({results:[{media_id:A,title:'A'},{media_id:B,title:'B'}]});
  const first=await x.player.run({tool:'search_and_play',args:{query:'first'}});
  x.advance(46000);
  assert.equal((await x.player.run({tool:'search_and_play',
    args:{candidate_token:first.choices[0].candidate_token}})).code,'stale_or_unknown_candidate');
  const next=await x.player.run({tool:'search_and_play',args:{query:'new search'}});
  assert.equal(next.status,'needs_selection');
  const another=await x.player.run({tool:'search_and_play',args:{query:'another new search'}});
  assert.equal(another.status,'needs_selection');
  assert.equal((await x.player.run({tool:'search_and_play',
    args:{candidate_token:next.choices[0].candidate_token}})).code,'stale_or_unknown_candidate');
});
test('unknown actions and browser targeting parameters never reach the player',async()=>{
  const x=mk();
  for(const intent of [
    {tool:'shell',args:{}},
    {tool:'pause',args:{deviceKey:'other'}},
    {tool:'pause',args:{tab_id:'other'}},
    {tool:'search_and_play',args:{media_id:A}},
    {tool:'search_and_play',args:{query:'https://another.example/watch'}}
  ])assert.equal((await x.player.run(intent)).status,'failed');
  assert.equal(x.calls.length,0);
});
test('pause resume state and fullscreen observed in the same facade',async()=>{
  const x=mk();
  for(const [tool,phase] of [['pause','paused'],['resume','playing']]){
    const r=await x.player.run({tool,args:{}});
    assert.equal(r.status,'observed');assert.equal(r.playbackPhase,phase);
  }
  assert.equal((await x.player.run({tool:'request_fullscreen',args:{}})).fullscreenMode,'in_page');
  assert.equal((await x.player.run({tool:'exit_fullscreen',args:{}})).fullscreenMode,'none');
});
test('buffering never claims playback observed',async()=>{
  const x=mk({buffer:true});
  const r=await x.player.run({tool:'search_and_play',args:{query:'trailer'}});
  assert.equal(r.status,'accepted');assert.equal(r.code,'state_not_yet_confirmed');
});
test('no player is offline rather than choosing another tab',async()=>{
  const x=createTeslaMonLocalPlayer({getPlayer:()=>null});
  assert.equal(x.ready,false);
  assert.equal((await x.run({tool:'pause',args:{}})).status,'offline');
});
test('mutations are serialized; overlapping same-tab commands rejected',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const calls=[];
  const facade={execute:async(action)=>{
    calls.push(action);
    if(action==='pause'){await gate;return {status:'completed'};}
    return {status:'completed',state:{playback_phase:'paused',fullscreen_kind:'none'}};
  }};
  const p=createTeslaMonLocalPlayer({getPlayer:()=>facade});
  const first=p.run({tool:'pause',args:{}});
  const second=await p.run({tool:'resume',args:{}});
  assert.equal(second.code,'target_busy');
  release();assert.equal((await first).status,'observed');
  assert.deepEqual(calls,['pause','get_player_state']);
});

test('fullscreen gesture denial does not erase accepted successful playback',async()=>{
  const calls=[];
  let media='';
  const p=createTeslaMonLocalPlayer({getPlayer:()=>({
    get_player_state:()=>({media_id:media,playback_phase:'playing',fullscreen_kind:'none'}),
    execute:async(action,args)=>{
      calls.push(action);
      if(action==='search_media')return {status:'completed',result:{results:[
        {media_id:A,title:'One'}]}};
      if(action==='play_media'){media=args.media_id;return {status:'accepted'};}
      if(action==='request_fullscreen')return {status:'needs_user_gesture'};
      if(action==='get_player_state')return {status:'completed',state:{
        media_id:media,playback_phase:'playing',fullscreen_kind:'none'}};
    }
  })});
  const result=await p.run({tool:'search_and_play',args:{query:'something'}});
  assert.equal(result.status,'observed');
  assert.equal(result.fullscreenAttempt,'needs_user_gesture');
  assert.deepEqual(calls,['search_media','play_media','request_fullscreen','get_player_state']);
});
test('fullscreen transport exceptions do not turn playback into a failure',async()=>{
  let media='';
  const p=createTeslaMonLocalPlayer({getPlayer:()=>({
    get_player_state:()=>({media_id:media,playback_phase:'playing',fullscreen_kind:'none'}),
    execute:async(action,args)=>{
      if(action==='search_media')return {status:'completed',result:{results:[
        {media_id:A,title:'One'}]}};
      if(action==='play_media'){media=args.media_id;return {status:'accepted'};}
      if(action==='request_fullscreen')throw Error('native fullscreen rejected');
      if(action==='get_player_state')return {status:'completed',state:{
        media_id:media,playback_phase:'playing',fullscreen_kind:'none'}};
    }
  })});
  const result=await p.run({tool:'search_and_play',args:{query:'something'}});
  assert.equal(result.status,'observed');
  assert.equal(result.fullscreenAttempt,'unconfirmed');
});
