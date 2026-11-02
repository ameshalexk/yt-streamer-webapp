import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`Unclosed ${name}`);
}

function fixture(search = '') {
  const calls = [];
  const attrs = new Map();
  const source = {
    getAttribute: key => key === 'src' ? attrs.get(key) ?? null : attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, value),
    hasAttribute: key => attrs.has(key),
  };
  const frameAttrs = new Map();
  const frame = { hidden: true, getAttribute: key => frameAttrs.get(key) ?? null,
    setAttribute: (key, value) => frameAttrs.set(key, value), removeAttribute: key => frameAttrs.delete(key) };
  const screen = { style: {}, classList: { remove() {}, add() {} } };
  const elements = { screen, embedFrame: frame, embedHeight: { value: '70vh' }, nowPlaying: {}, stopBtn: {}, restreamBtn: {}, embedStatus: {} };
  const context = vm.createContext({
    URL, URLSearchParams, location: { href: 'https://stream.example/watch', origin: 'https://stream.example', search },
    DOMParser: class { parseFromString(code) { return { querySelector: () => code === 'no iframe' ? null : source }; } },
    $: id => elements[id.slice(1)],
    stopDesktopHlsSession: () => calls.push('stop-hls'), stopDesktopAudioHlsSession: () => calls.push('stop-audio'),
    cleanupMedia: () => calls.push('cleanup'), resetPauseControl: () => {}, stopStreamSeekTimer: () => {}, setDesktopStreamActive: () => {},
    resetDesktopZoom: () => {}, renderDesktopInputUi: () => {}, normalizedEmbedHeight: value => value, isMobileMode: () => false,
    setBadge: () => {},
    copyEmbedIframeAttributes: (from, to) => to.setAttribute('src', from.getAttribute('src')),
  });
  vm.runInContext(['parseEmbedIframe', 'moonshineBlocksEmbeddedPlayer', 'requestEmbedAutoplay', 'renderEmbedCode']
    .map(name => functionSource(name)).join('\n'), context);
  return { context, calls, source, frame, elements };
}

test('Moonshine rejects external embeds before changing playback or iframe state', () => {
  const f = fixture('?tm_stt_mode=moonshine');
  f.source.setAttribute('src', 'https://youtube.com/embed/abc');
  assert.throws(() => f.context.renderEmbedCode('<iframe></iframe>', '600px'), /Embedded website players are unavailable.*Choose Whisper Tiny or Base, then reopen the player/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.frame.hidden, true);
  assert.equal(f.frame.getAttribute('src'), null);
});

test('normal mode keeps external embeds working and malformed input retains validation', () => {
  const normal = fixture();
  normal.source.setAttribute('src', 'https://youtube.com/embed/abc');
  normal.context.renderEmbedCode('<iframe></iframe>', '600px');
  assert.ok(normal.calls.includes('cleanup'));
  assert.equal(normal.frame.getAttribute('src').startsWith('https://youtube.com/embed/abc?'), true);
  assert.equal(normal.frame.hidden, false);
  assert.throws(() => normal.context.renderEmbedCode('no iframe', '600px'), /Paste iframe embed code first/);
  normal.source.setAttribute('src', 'javascript:alert(1)');
  assert.throws(() => normal.context.renderEmbedCode('<iframe></iframe>', '600px'), /Iframe src must start with http or https/);
});

test('Moonshine also rejects same-origin frames because their documents may lack isolation or redirect externally', () => {
  const f = fixture('?tm_stt_mode=moonshine');
  f.source.setAttribute('src', 'https://stream.example/embed/local');
  assert.throws(() => f.context.renderEmbedCode('<iframe></iframe>', '600px'), /Choose Whisper Tiny or Base/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.frame.hidden, true);
  assert.equal(f.frame.getAttribute('src'), null);
});
