import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { normalizeBackend } from '../src/lib/browser-audio-capture.js';

test('browser audio capture exposes both A/B backends with manual fallback', () => {
  assert.equal(normalizeBackend('blackhole-direct'), 'blackhole-direct');
  assert.equal(normalizeBackend('core-tap'), 'core-tap');
  assert.equal(normalizeBackend('manual'), 'manual');
  assert.equal(normalizeBackend('unexpected'), 'manual');
});

test('browser settings expose Version 1 and Version 2 capture selectors', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /value="core-tap" selected>Version 2 · Core Tap \(Recommended\)/);
  assert.match(html, /value="blackhole-direct">Version 1 · BlackHole \(Fallback\)/);
});

test('Core Tap avoids HLS until the native PCM path is validated', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /backend === "core-tap" && format === "hls"/);
  assert.match(js, /Core Tap currently supports MP3 and Auto\/PCM/);
});


test('Core Tap is the browser audio capture default', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /DEFAULT_BROWSER_AUDIO_CAPTURE = "core-tap"/);
  assert.match(js, /ytStreamerBrowserAudioCaptureV2/);
});

test('Version 2 gates PCM output until audio is ready and uses a low-latency queue', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /createScriptProcessor\(1024, 0, 2\)/);
  assert.match(js, /targetFrames: Math\.round\(ctx\.sampleRate \* 0\.05\)/);
  assert.match(js, /maxFrames: Math\.round\(ctx\.sampleRate \* 0\.12\)/);
  assert.match(js, /holdPcmOutput: Boolean\(activeCompat\.browserPcm && !meta\.looseAudioSync\)/);
  assert.match(js, /releaseBrowserPcmOutput\(\)/);
});

test('Real Chrome browser playback uses tight A/V sync and source media pause/resume', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = await fs.readFile(new URL('../src/lib/real-chrome-renderer.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.equal((js.match(/looseAudioSync: false/g) || []).length >= 2, true);
  assert.match(js, /setRealChromeMediaPlayback\("pause"\)/);
  assert.match(js, /await setRealChromeMediaPlayback\("play"\)/);
  assert.match(renderer, /export async function mediaPlayback/);
  assert.match(server, /\/api\/real-chrome\/:id\/media/);
});
