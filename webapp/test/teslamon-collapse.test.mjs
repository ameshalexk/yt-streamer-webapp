import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldAutoCollapseTeslaMonPanel} from '../public/teslamon-collapse.js';

const check=(status,options={})=>shouldAutoCollapseTeslaMonPanel({
  response:{status},opened:true,requestRevision:4,panelRevision:4,
  hasDraft:false,...options
});

test('closes after observed playback and completed Home Assistant actions',()=>{
  assert.equal(check('observed'),true);
  assert.equal(check('ha_done'),true);
});

test('keeps controls visible until playback is confirmed and on errors',()=>{
  for(const status of [
    'accepted','uncertain','failed','unsupported','offline',
    'needs_user_gesture','unavailable'
  ])assert.equal(check(status),false,status);
  assert.equal(check(undefined,{response:null}),false);
});

test('does not close a newly reopened panel or discard a draft',()=>{
  assert.equal(check('observed',{opened:false}),false);
  assert.equal(check('observed',{requestRevision:3}),false);
  assert.equal(check('observed',{panelRevision:5}),false);
  assert.equal(check('observed',{hasDraft:true}),false);
  assert.equal(check('ha_done',{panelRevision:5}),false);
});
