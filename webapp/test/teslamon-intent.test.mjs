import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretTeslaMon} from '../public/teslamon-intent.js';

test('common typed/speech phrases map only to six TeslaMon playback tools',()=>{
  const cases=[
    ['pause','pause'],['pause the video','pause'],['stop playback','pause'],
    ['unpause','resume'],['continue','resume'],['resume the player','resume'],
    ["what's playing",'get_playback_state'],['status','get_playback_state'],
    ['fullscreen','request_fullscreen'],['go fullscreen','request_fullscreen'],
    ['exit fullscreen','exit_fullscreen'],['leave fullscreen','exit_fullscreen']
  ];
  for(const [phrase,tool] of cases)assert.deepEqual(
    interpretTeslaMon(phrase),{tool,args:{}},phrase
  );
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
});
test('shell, filesystem and vehicle commands are not executable intents',()=>{
  for(const phrase of ['delete my files','unlock my Tesla','run shell ls',
    'brew install ffmpeg','ssh admin@example.com','set house alarm off']){
    assert.ok(interpretTeslaMon(phrase).error,phrase);
  }
});
