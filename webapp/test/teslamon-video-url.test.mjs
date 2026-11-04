import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTeslaMonVideoUrl} from '../public/teslamon-video-url.js';

test('every ordinary unknown path is passed through as an unspaced video command',()=>{
  assert.equal(parseTeslaMonVideoUrl('/playthelatestMKBSTvideo'),'playthelatestMKBSTvideo');
  assert.equal(parseTeslaMonVideoUrl('/playthelatestMKBHDvideo'),'playthelatestMKBHDvideo');
  assert.equal(parseTeslaMonVideoUrl('/play%20a%20video'),'play a video');
  assert.equal(parseTeslaMonVideoUrl('/play/the/latest/MKBHDvideo'),'play the latest MKBHDvideo');
  assert.equal(parseTeslaMonVideoUrl('/anyothercustomvideocommand'),'anyothercustomvideocommand');
});
test('existing app, assets and unsafe paths never become automatic commands',()=>{
  for(const path of ['','/','/index.html','/api/teslamon/plan','/stream/youtube',
    '/apne/watch/123','/retrotv','/games/','/vendor/x.js','/teslamon-pet.js',
    '/favicon.ico','/robots.txt','/_next/foo','/assets/photo.jpg',
    '/play%0Avideo','/%ZZ','/play?foo','/go#section','/']){
    assert.equal(parseTeslaMonVideoUrl(path),null,path);
  }
  assert.equal(parseTeslaMonVideoUrl('/'+ 'a'.repeat(221)),null);
});
