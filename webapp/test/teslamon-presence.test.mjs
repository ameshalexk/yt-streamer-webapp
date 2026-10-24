import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldDismissTeslaMon} from '../public/teslamon-presence.js';

const check=(response,options={})=>shouldDismissTeslaMon({
  response,tool:'search_and_play',requestRevision:6,panelRevision:6,
  hasDraft:false,panelOpen:true,fullscreen:false,...options
});

test('dismiss after real playback, completed HA change and confirmed control actions',()=>{
  assert.equal(check({status:'observed',playbackPhase:'playing'}),true);
  assert.equal(check({status:'ha_done'},{tool:'ha_done'}),true);
  assert.equal(check({status:'observed',playbackPhase:'paused'},{tool:'pause'}),true);
  assert.equal(check({status:'observed',playbackPhase:'idle'},{tool:'get_playback_state'}),true);
});

test('do not dismiss early, on buffering or on failure',()=>{
  for(const status of ['accepted','failed','uncertain','unsupported','needs_user_gesture','offline']){
    assert.equal(check({status,playbackPhase:'playing'}),false,status);
  }
  assert.equal(check({status:'observed',playbackPhase:'buffering'}),false);
});

test('do not hide a new wake session or a user draft after an older reply',()=>{
  const playing={status:'observed',playbackPhase:'playing'};
  assert.equal(check(playing,{panelRevision:7}),false);
  assert.equal(check(playing,{hasDraft:true}),false);
  assert.equal(check(playing,{panelOpen:false,fullscreen:false}),false);
  assert.equal(check(playing,{panelOpen:false,fullscreen:true}),true);
});
