import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTeslaMonVideoUrl} from '../public/teslamon-video-url.js';

test('every ordinary unknown path is passed through as an unspaced video command',()=>{
  assert.equal(parseTeslaMonVideoUrl('/playthelatestMKBSTvideo'),'playthelatestMKBSTvideo');
  assert.equal(parseTeslaMonVideoUrl('/playthelatestMKBHDvideo'),'playthelatestMKBHDvideo');
  assert.equal(parseTeslaMonVideoUrl('/play%20a%20video'),'play a video');
  assert.equal(parseTeslaMonVideoUrl('/play%2520a%2520video'),'play a video');
  assert.equal(parseTeslaMonVideoUrl('/play+MKBHD+greatest+video'),'play MKBHD greatest video');
  assert.equal(parseTeslaMonVideoUrl('/play%20Kalyanraman%20Malayalam'),'play Kalyanraman Malayalam');
  assert.equal(parseTeslaMonVideoUrl('/play%20%E0%B4%AE%E0%B4%B2%E0%B4%AF%E0%B4%BE%E0%B4%B3%E0%B4%82'),'play മലയാളം');
  assert.equal(parseTeslaMonVideoUrl('/play%20%E2%98%85%20video'),'play ★ video');
  assert.equal(parseTeslaMonVideoUrl('/play%2050%25%20video'),'play 50% video');
  assert.equal(parseTeslaMonVideoUrl('/play%20with%random%20percent'),'play with%random percent');
  assert.equal(parseTeslaMonVideoUrl('/play%20part%2Btwo'),'play part+two');
  assert.equal(parseTeslaMonVideoUrl('/play/the/latest/MKBHDvideo'),'play the latest MKBHDvideo');
  assert.equal(parseTeslaMonVideoUrl('/anyothercustomvideocommand'),'anyothercustomvideocommand');
});
test('existing app, assets and unsafe paths never become automatic commands',()=>{
  for(const path of ['','/','/index.html','/api/teslamon/plan','/stream/youtube',
    '/apne/watch/123','/retrotv','/games/','/vendor/x.js','/teslamon-pet.js',
    '/favicon.ico','/robots.txt','/_next/foo','/assets/photo.jpg',
    '/retro','/retro/','/retrotv/','/retro-pc/','/tesla','/tesla/live',
    '/experimental/','/icons/logo.svg','/teslamon-wake-assets/model',
    '/download','/episodes/current','/check-source','/mark-watched',
    '/play%0Avideo','/%ZZ','/%72etro','/%2561pi/teslamon/plan',
    '/%2E%2E/private','/%2Fplay','/play%2Fvideo','/play%5Cvideo','/play?foo','/go#section','/']){
    assert.equal(parseTeslaMonVideoUrl(path),null,path);
  }
  assert.equal(parseTeslaMonVideoUrl('/'+ 'a'.repeat(221)),null);
});
