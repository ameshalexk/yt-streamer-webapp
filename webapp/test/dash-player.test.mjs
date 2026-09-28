import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../public/dash-player.js', import.meta.url), 'utf8');
function fixture(storage = new Map()) {
  const events = [];
  class AudioContext {
    currentTime = 0; state = 'running';
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { events.push('context-close'); this.state = 'closed'; return Promise.resolve(); }
  }
  const context = { window: {}, AudioContext, AbortController, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    cancelAnimationFrame() {}, requestAnimationFrame() { return 1; }, fetch: async () => ({ ok: true, text: async () => '{}' }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, location: { origin: 'http://localhost' }, URL };
  vm.runInNewContext(code, context);
  return { ...context.window.DashPlayback, context, events, storage };
}
test('mode defaults and invalid persisted values always select MJPEG; write/read DASH', () => {
  const f = fixture(); assert.equal(f.readMode(), 'mjpeg');
  f.storage.set(f.MODE_KEY, 'bogus'); assert.equal(f.readMode(), 'mjpeg');
  f.writeMode('dash'); assert.equal(f.readMode(), 'dash');
  f.writeMode('bogus'); assert.equal(f.readMode(), 'mjpeg');
  f.context.localStorage.getItem = () => { throw new Error('denied'); };
  assert.equal(f.readMode(), 'mjpeg');
});
test('pause freezes audio master clock and mute does not rebuild the player', async () => {
  const f = fixture(); const p = new f.DashPlayer({ canvas: {}, muted: false });
  p.base = 5; p.ctx.currentTime = 12; assert.equal(p.currentTime(), 7);
  p.pauseUser(); assert.equal(p.paused, true); assert.equal(p.ctx.state, 'suspended');
  assert.equal(p.retryFromGesture(), false); assert.equal(p.ctx.state, 'suspended');
  p.setMuted(true); assert.equal(p.gain.gain.value, 0);
  p.setMuted(false); assert.equal(p.gain.gain.value, 1);
  p.resumeUser(); assert.equal(p.paused, false); assert.equal(p.currentTime(), 7);
  p.destroy();
});
test('decoder error preserves fallback position and closes frames, tracks, audio once', () => {
  const f = fixture(); let failures = 0; let fallbackTime;
  const p = new f.DashPlayer({ canvas: {}, onError: (_error, time) => { failures++; fallbackTime = time; } });
  p.base = 1; p.ctx.currentTime = 9;
  p.frames.push({ close() { f.events.push('frame-close'); } });
  p.tracks.set('v', { decoder: { close() { f.events.push('decoder-close'); } }, file: { stop() {} }, pending: [1] });
  p.nodes.add({ stop() { f.events.push('node-stop'); }, disconnect() {} });
  p.fail(new Error('decode failed')); p.fail(new Error('duplicate')); p.destroy();
  assert.equal(failures, 1); assert.equal(fallbackTime, 8); assert.equal(p.abort.signal.aborted, true);
  assert.deepEqual(f.events.sort(), ['context-close','decoder-close','frame-close','node-stop'].sort());
});
test('startup renders at scheduled audio time, not during the prebuffer lead', () => {
  const f = fixture(); let draws = 0;
  const p = new f.DashPlayer({ canvas: { width: 2, height: 2, getContext: () => ({ drawImage() { draws++; } }) } });
  p.hasAudio = false;
  for (let i = 0; i < 3; i++) p.frames.push({ timestamp: i * 40000, displayWidth: 2, displayHeight: 2, close() {} });
  p.tick(); assert.equal(p.started, true); assert.equal(draws, 0);
  p.ctx.currentTime = 0.61; p.tick(); assert.equal(draws, 1); p.destroy();
});

test('automatic fallback resumes MJPEG at absolute time and does not change the preference', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function maybePlayDash('), app.indexOf('function playBufferedMjpegStream('));
  let options, fallback;
  const element = { classList: { add() {}, remove() {} }, textContent: '', disabled: true };
  const context = {
    playbackMode: 'dash', soundOn: true, window: { DashPlayback: { supported: () => true, DashPlayer: class { constructor(value) { options = value; } start() {} } } },
    dashSourceSupported: () => true, cleanupMedia() {}, resetPauseControl() {}, configureStreamSeek() {},
    setAutoplayContext() {}, legacy: {}, streamAttempt: 7, $: () => element, setBadge() {}, renderPlaybackMode() {},
    currentAttempt: attempt => attempt === 7, playbackPaused: true, pendingQualityRestore: null, qualitySwitchGeneration: 0,
    withUrlParam: (url, key, value) => { const u = new URL(url, 'http://localhost'); u.searchParams.set(key, value); return u.pathname + u.search; },
    reportPlaybackEvent() {}, toast() {}, playBufferedMjpegStream: (...args) => { fallback = args; },
    activeModeSource: null, activeCompat: null,
  };
  vm.createContext(context); vm.runInContext(source, context);
  context.maybePlayDash({ mjpegUrl: '/stream/item/test?timestamp=20', audioUrl: '/stream/audio/item/test?timestamp=20' }, 'fixture', { bufferedMjpeg: true, seekable: true, startAt: 20 });
  options.onError(new Error('decoder lost'), 3.5);
  assert.equal(context.playbackMode, 'dash'); assert.equal(fallback[2].dashFallback, true);
  assert.equal(fallback[2].startAt, 23.5); assert.match(fallback[0].mjpegUrl, /timestamp=23.5/); assert.match(fallback[0].audioUrl, /timestamp=23.5/);
  assert.equal(context.pendingQualityRestore.pause, true);
  context.currentAttempt = () => false; fallback = null; options.onError(new Error('stale'), 1); assert.equal(fallback, null);
});
