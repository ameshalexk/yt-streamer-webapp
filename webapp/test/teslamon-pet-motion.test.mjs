import test from 'node:test';
import assert from 'node:assert/strict';
import {getTeslaMonPetMotion} from '../public/teslamon-pet-motion.js';

test('TeslaMon sits while idle, mic off, or passively waiting for Hey Jarvis',()=>{
  for(const wakeState of ['off','error','starting','listening'])
    assert.equal(getTeslaMonPetMotion({wakeState}),'sitting',wakeState);
  assert.equal(getTeslaMonPetMotion(),'sitting');
});

test('TeslaMon stands after wake activation and runs during PowerALX or Codex processing',()=>{
  assert.equal(getTeslaMonPetMotion({wakeState:'recording'}),'alert');
  assert.equal(getTeslaMonPetMotion({wakeState:'processing'}),'running');
  assert.equal(getTeslaMonPetMotion({wakeState:'listening',modelBusy:true}),'running');
  assert.equal(getTeslaMonPetMotion({wakeState:'recording',busy:true}),'running');
  assert.equal(getTeslaMonPetMotion({wakeState:'off',busy:true}),'running');
  assert.equal(getTeslaMonPetMotion({wakeState:'listening',modelBusy:false,busy:false}),'sitting');
});
