import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TESLAMON_WAKE_KEYWORDS,
  normalizeTeslaMonWakeKeywords,
  stripTeslaMonWakePhrasePrefix,
} from '../public/teslamon-wake-phrases.js';

test('wake selection accepts a nonempty unique subset and restores canonical order',()=>{
  assert.deepEqual(TESLAMON_WAKE_KEYWORDS,['hey_jarvis','hey_luna','alexa']);
  assert.deepEqual(normalizeTeslaMonWakeKeywords(['alexa','hey_luna']),['hey_luna','alexa']);
  for(const invalid of [null,[],['unrecognized'],['alexa','alexa'],['alexa',null]])
    assert.equal(normalizeTeslaMonWakeKeywords(invalid),null);
});

test('wake transcript prefix strips each recognized phrase only at the beginning',()=>{
  assert.equal(stripTeslaMonWakePhrasePrefix('  Hey Jarvis, play Alexa radio  '),'play Alexa radio');
  assert.equal(stripTeslaMonWakePhrasePrefix('HEY LUNA — pause the video'),'pause the video');
  assert.equal(stripTeslaMonWakePhrasePrefix('Alexa: resume'),'resume');
  assert.equal(stripTeslaMonWakePhrasePrefix('Please say Hey Luna, then play music'),
    'Please say Hey Luna, then play music');
  assert.equal(stripTeslaMonWakePhrasePrefix('Alexa play Alexa'),'play Alexa');
});

test('a standalone wake phrase produces no command payload',()=>{
  for(const phrase of ['Hey Jarvis','Hey Luna!','Alexa'])
    assert.equal(stripTeslaMonWakePhrasePrefix(phrase),'');
  assert.equal(stripTeslaMonWakePhrasePrefix('Hey JarvisPlay music'),'Hey JarvisPlay music');
});
