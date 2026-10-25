import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TESLAMON_WAKE_KEYWORDS,
  normalizeTeslaMonWakeKeywords,
  restoreTeslaMonWakeKeywords,
  stripTeslaMonWakePhrasePrefix,
} from '../public/teslamon-wake-phrases.js';

test('wake selection accepts a nonempty unique subset and restores canonical order',()=>{
  assert.deepEqual(TESLAMON_WAKE_KEYWORDS,['hey_jarvis','alexa','hey_mycroft','hey_rhasspy']);
  assert.deepEqual(normalizeTeslaMonWakeKeywords(['hey_rhasspy','alexa']),['alexa','hey_rhasspy']);
  for(const invalid of [null,[],['unrecognized'],['alexa','alexa'],['alexa',null]])
    assert.equal(normalizeTeslaMonWakeKeywords(invalid),null);
});

test('wake transcript prefix strips each recognized phrase only at the beginning',()=>{
  assert.equal(stripTeslaMonWakePhrasePrefix('  Hey Jarvis, play Alexa radio  '),'play Alexa radio');
  assert.equal(stripTeslaMonWakePhrasePrefix('HEY MYCROFT — pause the video'),'pause the video');
  assert.equal(stripTeslaMonWakePhrasePrefix('Alexa: resume'),'resume');
  assert.equal(stripTeslaMonWakePhrasePrefix('Please say Hey Rhasspy, then play music'),
    'Please say Hey Rhasspy, then play music');
  assert.equal(stripTeslaMonWakePhrasePrefix('Alexa play Alexa'),'play Alexa');
});

test('legacy Luna selections migrate to Mycroft and Rhasspy without losing other choices',()=>{
  assert.deepEqual(restoreTeslaMonWakeKeywords(['hey_jarvis','hey_luna','alexa']),
    ['hey_jarvis','alexa','hey_mycroft','hey_rhasspy']);
  assert.deepEqual(restoreTeslaMonWakeKeywords(['hey_luna']),['hey_mycroft','hey_rhasspy']);
  assert.deepEqual(restoreTeslaMonWakeKeywords(['alexa']),['alexa']);
  assert.equal(restoreTeslaMonWakeKeywords(['unknown']),null);
});

test('a standalone wake phrase produces no command payload',()=>{
  for(const phrase of ['Hey Jarvis','Alexa','Hey Mycroft!','Hey Rhasspy'])
    assert.equal(stripTeslaMonWakePhrasePrefix(phrase),'');
  assert.equal(stripTeslaMonWakePhrasePrefix('Hey JarvisPlay music'),'Hey JarvisPlay music');
  assert.equal(stripTeslaMonWakePhrasePrefix('Hey Luna, play music'),'Hey Luna, play music');
});
