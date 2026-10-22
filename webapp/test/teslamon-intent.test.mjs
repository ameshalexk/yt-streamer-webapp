import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretTeslaMon} from '../public/teslamon-intent.js';

test('20 polite typed phrases map to the existing six playback tools',()=>{
  const cases=[
    ['please pause','pause'],['can you pause the video','pause'],
    ['would you please pause playback','pause'],
    ['could you pause the movie for me','pause'],
    ['can you resume the video','resume'],['could you resume video please','resume'],
    ['please continue playing','resume'],
    ['would you keep playing','resume'],
    ['could you tell me what is playing','get_playback_state'],
    ["please tell me what's playing right now",'get_playback_state'],
    ['can you tell me what is on','get_playback_state'],["what's playing please",'get_playback_state'],
    ['please go full screen','request_fullscreen'],['can you make it fullscreen','request_fullscreen'],
    ['could you enter full-screen mode','request_fullscreen'],
    ['can you leave fullscreen','exit_fullscreen'],['please exit full screen','exit_fullscreen'],
    ['could you turn off full-screen mode','exit_fullscreen'],
    ['get out of full screen','exit_fullscreen'],['switch to fullscreen please','request_fullscreen'],
  ];
  assert.equal(cases.length,20);
  const allowed=new Set(['search_and_play','pause','resume','get_playback_state',
    'request_fullscreen','exit_fullscreen']);
  for(const [phrase,tool] of cases){
    const result=interpretTeslaMon(phrase);
    assert.deepEqual(result,{tool,args:{}},phrase);
    assert.ok(allowed.has(result.tool),phrase);
  }
});
test('search-by-title is bounded and never grants model targets or URLs',()=>{
  for(const phrase of ['play the MKBHD video','find interstellar trailer',
    'search for doomsday explained','put on movie review']){
    const result=interpretTeslaMon(phrase);
    assert.equal(result.tool,'search_and_play',phrase);
    assert.ok(result.args.query.length>=2);
    assert.deepEqual(Object.keys(result.args),['query']);
  }
  for(const bad of ['play https://example.test/video','play www.example.com',
    'play a','play '+('a'.repeat(124))]){
    assert.ok(interpretTeslaMon(bad).error,bad);
  }
  assert.deepEqual(interpretTeslaMon('please play Please Pause'),
    {tool:'search_and_play',args:{query:'Please Pause'}});
  assert.deepEqual(interpretTeslaMon('please play Again'),
    {tool:'search_and_play',args:{query:'Again'}});
  assert.deepEqual(interpretTeslaMon('play please pause'),
    {tool:'search_and_play',args:{query:'please pause'}});
});
test('20 unsafe, ambiguous, multi-action and target-injection phrases fail closed',()=>{
  const unsafe=[
    'pause then unlock','please pause and unlock','can you resume then pause',
    'pause or resume','pause and then turn on fullscreen','resume, then tell me status',
    'play a song and then pause','play Mr Robot then unlock the car',
    'play a song on browser B','play a video in tab 3','pause on browser B',
    'resume on the other player','status for browser B','play music to device 2',
    'play example.test','please play a video at ftp://example.test',
    'play www.example.com','play example.com','unlock my Tesla','delete my files',
  ];
  assert.equal(unsafe.length,20);
  for(const phrase of unsafe){
    assert.ok(interpretTeslaMon(phrase).error,phrase);
  }
});
