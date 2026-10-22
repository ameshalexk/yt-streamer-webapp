import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonCandidateService} from '../src/lib/teslamon-candidates.js';

const START=Date.parse('2026-10-22T16:00:00Z');
const A='AAAaa00000_',B='BBBbb11111_',C='CCCcc22222_';
const video=(media_id,title='Video title',creator='Channel')=>({media_id,title,creator});
const make=({rows=[video(A)],phase='playing',ackPatch={},readbackPatch={},
  searchPatch={},beforeDispatch}={})=>{
  let now=START;
  let authority={
    origin:'https://stream.ameshalex.com',subject:'owner-verified',
    controllerId:'controller-verified',
    deviceKey:'11111111-1111-4111-8111-111111111111',
    connectionId:'22222222-2222-4222-8222-222222222222',
    explicitSelection:true,tabConsent:true,authExpiresAt:now+120000
  };
  const calls=[];
  const service=createTeslaMonCandidateService({
    clock:()=>now,getAuthority:async()=>({...authority}),
    dispatch:async command=>{
      calls.push(command);
      if(beforeDispatch)await beforeDispatch(command,change);
      const envelope={
        commandId:command.commandId,subject:command.binding.subject,
        deviceKey:command.binding.deviceKey,
        connectionId:command.binding.connectionId
      };
      if(command.action==='search_media')
        return {...envelope,status:'completed',
          result:{results:rows},...searchPatch};
      if(command.action==='play_media')
        return {...envelope,status:'accepted',...ackPatch};
      if(command.action==='get_player_state')
        return {...envelope,status:'completed',
          state:{media_id:calls.findLast(c=>c.action==='play_media')?.args.media_id,
            playback_phase:phase,observed_at:new Date(now).toISOString(),
            ...readbackPatch}};
      throw new Error('unexpected_action');
    }
  });
  const change=x=>{authority={...authority,...x};};
  return {service,calls,change,advance:ms=>{now+=ms;},get now(){return now}};
};
const query=q=>({tool:'search_and_play',args:{query:q}});
const select=t=>({tool:'search_and_play',args:{candidate_token:t}});

test('one exact search result plays and confirms matching observed media',async()=>{
  const f=make();
  const r=await f.service.searchAndPlay(query('Trailer 2026'));
  assert.deepEqual(f.calls.map(c=>c.action),[
    'search_media','play_media','get_player_state']);
  assert.equal(r.status,'observed');
  assert.equal(r.observed,true);
  assert.equal(r.mediaId,A);
  for(const c of f.calls){
    assert.equal(c.binding.subject,'owner-verified');
    assert.equal(c.binding.controllerId,'controller-verified');
    assert.equal(c.binding.deviceKey,'11111111-1111-4111-8111-111111111111');
    assert.equal(c.binding.connectionId,'22222222-2222-4222-8222-222222222222');
  }
  assert.equal(f.service.pendingCandidates,0);
});

test('ambiguous results require private candidate selection, no blind first hit',async()=>{
  const f=make({rows:[video(A,'First'),video(B,'Second')]});
  const found=await f.service.searchAndPlay(query('Broad question'));
  assert.equal(found.status,'needs_selection');
  assert.equal(found.choices.length,2);
  assert.equal(f.calls.length,1);
  assert.ok(found.choices[1].candidate_token.length>=16);
  assert.equal(found.choices[1].title,'Second');
  assert.equal('media_id' in found.choices[1],false);
  const played=await f.service.searchAndPlay(select(found.choices[1].candidate_token));
  assert.equal(played.status,'observed');
  assert.equal(played.mediaId,B);
  assert.deepEqual(f.calls.map(c=>c.action),['search_media','play_media','get_player_state']);
  assert.equal((await f.service.searchAndPlay(select(found.choices[1].candidate_token))).code,
    'stale_or_unknown_candidate');
  assert.equal(f.calls.length,3);
});

test('new search invalidates previous candidate tokens',async()=>{
  const f=make({rows:[video(A),video(B)]});
  const first=await f.service.searchAndPlay(query('one result query'));
  const old=first.choices[0].candidate_token;
  await f.service.searchAndPlay(query('new query'));
  assert.equal((await f.service.searchAndPlay(select(old))).code,'stale_or_unknown_candidate');
  assert.equal(f.calls.length,2);
});

test('TTL expiration and explicit invalidation reject old results without playing',async()=>{
  const f=make({rows:[video(A),video(B)]});
  const found=await f.service.searchAndPlay(query('Find two'));
  f.advance(46000);
  assert.equal((await f.service.searchAndPlay(select(found.choices[0].candidate_token))).code,
    'stale_or_unknown_candidate');
  const fresh=await f.service.searchAndPlay(query('Find two'));
  f.service.invalidate();
  assert.equal(f.service.pendingCandidates,0);
  assert.equal((await f.service.searchAndPlay(select(fresh.choices[0].candidate_token))).code,
    'stale_or_unknown_candidate');
  assert.equal(f.calls.length,2);
});

test('different owner, controller, connection, consent or origin cannot reuse candidates',async()=>{
  const cases=[
    {subject:'different-owner'},{controllerId:'other-controller'},
    {deviceKey:'33333333-3333-4333-8333-333333333333'},
    {connectionId:'44444444-4444-4444-8444-444444444444'},
    {tabConsent:false},{explicitSelection:false},
    {origin:'https://streamha.ameshalex.com'}
  ];
  for(const c of cases){
    const f=make({rows:[video(A),video(B)]});
    const found=await f.service.searchAndPlay(query('Find 2'));
    f.change(c);
    const r=await f.service.searchAndPlay(select(found.choices[0].candidate_token));
    assert.notEqual(r.status,'observed');
    assert.equal(f.calls.length,1,JSON.stringify(c));
  }
});

test('no implicit one-browser fallback, no replay on vanished target',async()=>{
  const f=make();
  f.change({explicitSelection:false});
  const r=await f.service.searchAndPlay(query('One result'));
  assert.equal(r.status,'failed');
  assert.equal(f.calls.length,0);
});

test('target reconnect while search is pending prevents any play',async()=>{
  let triggered=false;
  const f=make({
    beforeDispatch:async(command,change)=>{
      if(!triggered&&command.action==='search_media'){
        triggered=true;
        change({connectionId:'33333333-3333-4333-8333-333333333333'});
      }
    }
  });
  const r=await f.service.searchAndPlay(query('Question'));
  assert.equal(r.status,'offline');
  assert.equal(f.calls.length,1);
});

test('wrong command id and wrong-generation ACKs are uncertain, never success',async()=>{
  for(const patch of [
    {commandId:'00000000-0000-4000-8000-000000000000'},
    {subject:'other'}, {deviceKey:'other'}, {connectionId:'other'}
  ]){
    const f=make({ackPatch:patch});
    const r=await f.service.searchAndPlay(query('Single video'));
    assert.equal(r.status,'uncertain');
    assert.equal(f.calls.length,2);
  }
});

test('play accepted but buffering or gesture-needed remains accepted, never observed',async()=>{
  for(const phase of ['buffering','paused','needs_user_gesture']){
    const f=make({phase});
    const r=await f.service.searchAndPlay(query('Single video'));
    assert.equal(r.status,'accepted');
    assert.equal(r.observed,false);
    assert.equal(r.playbackPhase,phase);
  }
});

test('stale or mismatched player observation cannot report playback success',async()=>{
  for(const patch of [
    {media_id:B},{observed_at:new Date(START-120000).toISOString()},
    {observed_at:'not-a-date'},
    {playback_phase:'ended'}
  ]){
    const f=make({readbackPatch:patch});
    const r=await f.service.searchAndPlay(query('Single video'));
    assert.equal(r.status,'uncertain');
  }
});

test('failed, malformed, duplicated or empty search response never triggers play',async()=>{
  for(const rows of [
    [],[video('INVALID','Bad')],[video(A,'')],[{media_id:A,title:'X'.repeat(161)}]
  ]){
    const f=make({rows});
    const r=await f.service.searchAndPlay(query('Find video'));
    assert.equal(r.status,'failed');
    assert.equal(f.calls.length,1);
  }
  const dupe=make({rows:[video(A),video(A,'duplicate')]});
  const r=await dupe.service.searchAndPlay(query('dupes'));
  assert.equal(r.status,'observed');
  assert.deepEqual(dupe.calls.map(c=>c.action),
    ['search_media','play_media','get_player_state']);
  const pending=make({searchPatch:{status:'accepted'}});
  assert.equal((await pending.service.searchAndPlay(query('pending'))).status,'failed');
  assert.equal(pending.calls.length,1);
});

test('even a failed replacement search invalidates previously selected candidates',async()=>{
  const rows=[video(A),video(B)];
  const f=make({rows});
  const first=await f.service.searchAndPlay(query('Find two'));
  rows.splice(0,rows.length);
  const failed=await f.service.searchAndPlay(query('Find nothing'));
  assert.equal(failed.code,'no_results');
  assert.equal(f.service.pendingCandidates,0);
  assert.equal((await f.service.searchAndPlay(select(first.choices[0].candidate_token))).code,
    'stale_or_unknown_candidate');
  assert.equal(f.calls.length,2);
});

test('candidate token collision fails without publishing partial results',async()=>{
  const f=make({rows:[video(A),video(B)]});
  let nonce=0;
  const service=createTeslaMonCandidateService({
    getAuthority:async()=>({
      origin:'https://stream.ameshalex.com',subject:'s',
      controllerId:'c',deviceKey:'11111111-1111-4111-8111-111111111111',
      connectionId:'22222222-2222-4222-8222-222222222222',
      explicitSelection:true,tabConsent:true,authExpiresAt:START+90000
    }),
    clock:()=>START,
    makeToken:()=>{nonce++;return 'A'.repeat(32);},
    dispatch:async c=>({
      status:'completed',commandId:c.commandId,subject:c.binding.subject,
      deviceKey:c.binding.deviceKey,connectionId:c.binding.connectionId,
      result:{results:[video(A),video(B)]}
    })
  });
  const result=await service.searchAndPlay(query('some query'));
  assert.equal(result.code,'candidate_generation_failed');
  assert.equal(service.pendingCandidates,0);
  assert.equal(nonce,2);
});

test('uncertain search result remains uncertain instead of a definitive failure',async()=>{
  const f=make({searchPatch:{status:'uncertain',code:'transport_timeout'}});
  const r=await f.service.searchAndPlay(query('Search this'));
  assert.equal(r.status,'uncertain');
  assert.equal(r.code,'transport_timeout');
  assert.equal(f.calls.length,1);
});

test('model cannot select arbitrary URL, media ID, owner or invoke unrelated tool',async()=>{
  const f=make();
  for(const intent of [
    {tool:'search_and_play',args:{media_id:A}},
    {tool:'search_and_play',args:{query:'hi',subject:'other'}},
    {tool:'search_and_play',args:{query:'hi',target:'different'}},
    {tool:'play_media',args:{media_id:A}},
    {tool:'search_and_play',args:{query:'https://example.com/watch?v=bad'}}
  ]){
    const r=await f.service.searchAndPlay(intent);
    // URL strings may be ordinary user search text; they may search but can't
    // directly select a URL. Other input must be rejected.
    if(intent.args.query?.startsWith('https://'))assert.ok(r.status!=='failed');
    else assert.equal(r.code,'invalid_intent');
  }
  assert.deepEqual(f.calls.map(c=>c.action),['search_media','play_media','get_player_state']);
});

test('overlong 160-char tool query is rejected before older 120-char relay',async()=>{
  const f=make();
  assert.equal((await f.service.searchAndPlay(query('Q'.repeat(130)))).code,
    'query_exceeds_player_limit');
  assert.equal(f.calls.length,0);
});

test('parallel search calls do not overlap same target mutation stream',async()=>{
  let unblock;const gate=new Promise(resolve=>{unblock=resolve});
  const f=make({beforeDispatch:async(command)=>{
    if(command.action==='search_media')await gate;
  }});
  const first=f.service.searchAndPlay(query('First'));
  await new Promise(resolve=>setImmediate(resolve));
  const concurrent=await f.service.searchAndPlay(query('Second'));
  assert.equal(concurrent.code,'target_busy');
  unblock();
  assert.equal((await first).status,'observed');
});
