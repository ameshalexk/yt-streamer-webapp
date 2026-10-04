import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeBackend } from '../src/lib/browser-audio-capture.js';

const appUrl = new URL('../public/app.js', import.meta.url);
const htmlUrl = new URL('../public/index.html', import.meta.url);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is present`);
  let parens = 0;
  let closeParams = -1;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    if (source[i] === ')' && --parens === 0) { closeParams = i; break; }
  }
  assert.ok(closeParams > start, `${name} has a parameter list`);
  const bodyStart = source.indexOf('{', closeParams);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('browser audio UI exposes Core Tap as its single selectable capture mode', async () => {
  const html = await fs.readFile(htmlUrl, 'utf8');
  for (const id of ['browserAudioCapture', 'browserPlayerAudioCapture']) {
    const select = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)<\\/select>`));
    assert.ok(select, `${id} exists`);
    assert.deepEqual([...select[1].matchAll(/<option\b/g)].length, 1);
    assert.match(select[1], /<option value="core-tap" selected>Core Tap<\/option>/);
  }
});

test('capture mode normalization falls back to the sole supported Core Tap backend', async () => {
  const app = await fs.readFile(appUrl, 'utf8');
  const context = vm.createContext({ BROWSER_AUDIO_CAPTURE_MODES: ['core-tap'], DEFAULT_BROWSER_AUDIO_CAPTURE: 'core-tap' });
  vm.runInContext(extractFunction(app, 'validBrowserAudioCapture'), context);
  assert.equal(context.validBrowserAudioCapture('core-tap'), 'core-tap');
  assert.equal(context.validBrowserAudioCapture('blackhole-direct'), 'core-tap');
  assert.equal(context.validBrowserAudioCapture('manual'), 'core-tap');
  assert.equal(normalizeBackend('core-tap'), 'core-tap');
});

test('capture selection synchronizes both controls and persists the current V3 key', async () => {
  const app = await fs.readFile(appUrl, 'utf8');
  const writes = [];
  const controls = {
    browserAudioCapture: { value: '' }, browserPlayerAudioCapture: { value: '' },
    browserAudio: { disabled: false, title: '' }, browserPlayerAudio: { disabled: false, title: '' },
  };
  const context = vm.createContext({
    BROWSER_AUDIO_CAPTURE_MODES: ['core-tap'], DEFAULT_BROWSER_AUDIO_CAPTURE: 'core-tap',
    BROWSER_AUDIO_CAPTURE_KEY: 'ytStreamerBrowserAudioCaptureV3',
    $: (id) => controls[id.slice(1)],
    localStorage: { setItem: (...args) => writes.push(args) },
  });
  vm.runInContext(`${extractFunction(app, 'validBrowserAudioCapture')}\n${extractFunction(app, 'setBrowserAudioCapture')}`, context);
  assert.equal(context.setBrowserAudioCapture('manual'), 'core-tap');
  assert.equal(controls.browserAudioCapture.value, 'core-tap');
  assert.equal(controls.browserPlayerAudioCapture.value, 'core-tap');
  assert.equal(controls.browserAudio.disabled, true);
  assert.equal(controls.browserPlayerAudio.disabled, true);
  assert.deepEqual(writes, [['ytStreamerBrowserAudioCaptureV3', 'core-tap']]);
});

test('Core Tap PCM output is held for synchronized startup and released when audio becomes ready', async () => {
  const app = await fs.readFile(appUrl, 'utf8');
  assert.match(app, /createScriptProcessor\(1024, 0, 2\)/);
  assert.match(app, /targetFrames: Math\.round\(ctx\.sampleRate \* 0\.05\)/);
  assert.match(app, /maxFrames: Math\.round\(ctx\.sampleRate \* 0\.12\)/);
  assert.match(app, /holdPcmOutput: Boolean\(activeCompat\.browserPcm && !meta\.looseAudioSync\)/);
  assert.match(app, /releaseBrowserPcmOutput\(\)/);
});

test('Real Chrome browser playback retains tight A/V sync and source media pause/resume', async () => {
  const app = await fs.readFile(appUrl, 'utf8');
  const renderer = await fs.readFile(new URL('../src/lib/real-chrome-renderer.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok((app.match(/looseAudioSync: false/g) || []).length >= 2);
  assert.match(app, /setRealChromeMediaPlayback\("pause"\)/);
  assert.match(app, /await setRealChromeMediaPlayback\("play"\)/);
  assert.match(renderer, /export async function mediaPlayback/);
  assert.match(server, /\/api\/real-chrome\/:id\/media/);
});
