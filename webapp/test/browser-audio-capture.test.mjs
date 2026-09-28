import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { normalizeBackend } from '../src/lib/browser-audio-capture.js';

test('server keeps legacy capture backends available for internal fallback/debugging', () => {
  assert.equal(normalizeBackend('blackhole-direct'), 'blackhole-direct');
  assert.equal(normalizeBackend('core-tap'), 'core-tap');
  assert.equal(normalizeBackend('manual'), 'manual');
  assert.equal(normalizeBackend('unexpected'), 'manual');
});

test('Browser UI exposes one production audio choice: Core Tap', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/Core Tap · Low latency/g) || []).length, 2);
  assert.equal((html.match(/No BlackHole or virtual speaker\./g) || []).length, 2);
  assert.doesNotMatch(html, /Version 1 · BlackHole/);
  assert.doesNotMatch(html, /Advanced · Manual device/);
  assert.match(html, /id="browserAudioCapture"><option value="core-tap" selected>Core Tap/);
  assert.match(html, /id="browserPlayerAudioCapture"><option value="core-tap" selected>Core Tap/);
});

test('Real Chrome browser audio is pinned to Core Tap raw PCM', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = js.indexOf('async function browserAudioUrl(audio)');
  const end = js.indexOf('function renderDesktopStatus', start);
  const block = js.slice(start, end);
  assert.match(block, /backend: "core-tap"/);
  assert.match(block, /return `\/stream\/browser-pcm\?\$\{query\.toString\(\)\}`/);
  assert.doesNotMatch(block, /format === "hls"/);
  assert.doesNotMatch(block, /blackhole-direct/);
});

test('stale browser audio preferences cannot override Core Tap PCM', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /DEFAULT_BROWSER_AUDIO_CAPTURE = "core-tap"/);
  assert.match(js, /DEFAULT_BROWSER_AUDIO_FORMAT = "auto"/);
  assert.match(js, /ytStreamerBrowserAudioCaptureV3/);
  assert.match(js, /ytStreamerBrowserAudioFormatV3/);
  assert.match(js, /function browserAudioCaptureValue\(\) \{\s*return DEFAULT_BROWSER_AUDIO_CAPTURE;/);
  assert.match(js, /function browserAudioFormatValue\(\) \{\s*return DEFAULT_BROWSER_AUDIO_FORMAT;/);
  assert.match(js, /Overwrite stale A\/B-test choices/);
});

test('Core Tap primes and reuses one Web Audio context from the Open Chrome gesture', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /let browserPcmSharedContext = null/);
  assert.match(js, /function primeBrowserAudioFromGesture\(\)/);
  assert.match(js, /new AudioCtx\(\{ sampleRate: 48000, latencyHint: "interactive" \}\)/);
  assert.equal((js.match(/primeBrowserAudioFromGesture\(\);/g) || []).length >= 2, true);
  assert.match(js, /const ctx = ensureBrowserPcmContext\(\)/);
  assert.doesNotMatch(
    js.slice(js.indexOf('function destroyBrowserPcmAudio'), js.indexOf('function setBrowserPcmOutputHeld')),
    /ctx\?\.close/
  );
});

test('Core Tap PCM fails visibly instead of leaving the player stuck syncing forever', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /session\.error = error/);
  assert.match(js, /browserPcmReady\(session, 3000\)/);
  assert.match(js, /Core Tap audio did not start within 3 seconds/);
  assert.match(js, /destroyBrowserPcmAudio\(\);\s*throw error;/);
});

test('Version 3 keeps the low-latency PCM queue and A\/V gate', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /createScriptProcessor\(1024, 0, 2\)/);
  assert.match(js, /targetFrames: Math\.round\(ctx\.sampleRate \* 0\.05\)/);
  assert.match(js, /maxFrames: Math\.round\(ctx\.sampleRate \* 0\.12\)/);
  assert.match(js, /holdPcmOutput: Boolean\(activeCompat\.browserPcm && !meta\.looseAudioSync\)/);
  assert.match(js, /releaseBrowserPcmOutput\(\)/);
});

test('Real Chrome browser playback keeps tight A\/V sync and source media pause\/resume', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderer = await fs.readFile(new URL('../src/lib/real-chrome-renderer.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.equal((js.match(/looseAudioSync: false/g) || []).length >= 2, true);
  assert.match(js, /setRealChromeMediaPlayback\("pause"\)/);
  assert.match(js, /await setRealChromeMediaPlayback\("play"\)/);
  assert.match(renderer, /export async function mediaPlayback/);
  assert.match(server, /\/api\/real-chrome\/:id\/media/);
});
