import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
await import('../public/playback-recovery.js');
const { Monitor } = globalThis.PlaybackRecovery;
function fixture(options = {}) {
  let now = 0;
  let scheduled;
  const events = [], recoveries = [];
  const monitor = new Monitor({ now: () => now, schedule: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    cancel: () => { scheduled = null; }, recover: async value => recoveries.push(value), notify: e => events.push(e), ...options });
  const sample = { key: 'video-a', attempt: 1, started: true, videoProgress: 10, canMeasureVideo: true, position: 42,
    videoAvailable: true, audioEnabled: false, audioTime: 5, canRepairAudio: true };
  return { monitor, sample, events, recoveries, advance: (ms, changes = {}) => { now += ms; monitor.observe({ ...sample, ...changes }); },
    run: async () => { const task = scheduled; scheduled = null; await task.fn(); }, get task() { return scheduled; } };
}
test('freeze recovery preserves position, delays retries and exhausts one budget across attempts', async () => {
  const f = fixture(); f.advance(0); f.advance(16000);
  assert.equal(f.task.delay, 1000); await f.run(); assert.equal(f.recoveries[0].position, 42);
  f.advance(0, { attempt: 2 }); f.advance(16000, { attempt: 2 }); assert.equal(f.task.delay, 3000); await f.run();
  f.advance(0, { attempt: 3 }); f.advance(16000, { attempt: 3 }); assert.equal(f.task.delay, 8000); await f.run();
  f.advance(0, { attempt: 4 }); f.advance(16000, { attempt: 4 });
  assert.equal(f.task, null); assert.equal(f.monitor.attempts, 3); assert.equal(f.events.at(-1).state, 'exhausted');
});
test('paused, hidden, autoplay-blocked, offline and finished playback never trigger recovery', () => {
  for (const condition of ['paused', 'hidden', 'blocked', 'offline', 'ended']) {
    const f = fixture(); f.advance(0); f.advance(60000, { [condition]: true });
    assert.equal(f.task, undefined); assert.equal(f.monitor.request('failure', { ...f.sample, [condition]: true }), false);
  }
});
test('source switch and stop cancel a queued retry; stale callbacks cannot replay old media', async () => {
  const f = fixture(); f.advance(0); f.advance(16000); const callback = f.task.fn;
  f.advance(1, { key: 'video-b' }); await callback(); assert.equal(f.recoveries.length, 0);
  f.monitor.request('failure', { ...f.sample, key: 'video-b' }); f.monitor.reset(); assert.equal(f.task, null);
});
test('audio stalls first repair audio then escalate to a full reconnect within the same budget', async () => {
  const f = fixture(); f.advance(0, { audioEnabled: true });
  f.advance(9000, { audioEnabled: true, videoProgress: 50 }); await f.run(); assert.equal(f.recoveries[0].audioOnly, true);
  f.advance(9000, { audioEnabled: true, videoProgress: 100 }); await f.run(); assert.equal(f.recoveries[1].audioOnly, false);
});
test('persistent drift needs five seconds and stable playback restores the budget', async () => {
  const f = fixture({ stableMs: 6000 }); f.advance(0, { audioEnabled: true });
  f.advance(1000, { audioEnabled: true, videoProgress: 11, audioTime: 6, driftMs: 2000 });
  f.advance(4000, { audioEnabled: true, videoProgress: 15, audioTime: 10, driftMs: 2000 }); assert.equal(f.task, undefined);
  f.advance(1000, { audioEnabled: true, videoProgress: 16, audioTime: 11, driftMs: 2000 }); await f.run();
  for (let i = 1; i <= 7; i++) f.advance(1000, { audioEnabled: true, videoProgress: 16 + i, audioTime: 11 + i });
  assert.equal(f.monitor.attempts, 0);
});
test('reconnect uses the captured video clock and stops separate audio while preserving watch session', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const calls = []; const replay = time => calls.push(['replay', time]);
  const context = vm.createContext({ replayFn: replay, playbackPaused: false, document: { hidden: false }, navigator: { onLine: true },
    activeCompat: null, streamSeek: { seekable: true }, clampStreamSeekTime: n => n,
    watchProgress: { save: () => calls.push(['save']) }, stopDesktopAudioHlsSession: async () => calls.push(['audio-stop']),
    clearBrowserAudioRetry: () => {}, cleanupMedia: keep => calls.push(['cleanup', keep]) });
  const start = app.indexOf('async function recoverPlayback('); const end = app.indexOf('\nconst playbackRecovery', start);
  vm.runInContext(app.slice(start, end), context);
  await context.recoverPlayback({ replay, position: 42, audioOnly: false });
  assert.deepEqual(calls, [['save'], ['audio-stop'], ['cleanup', true], ['replay', 42]]);
  context.playbackPaused = true; await context.recoverPlayback({ replay, position: 99 }); assert.equal(calls.length, 4);
});

test('pausing or hiding cancels a queued retry without consuming its budget', async () => {
  for (const held of ['paused', 'hidden', 'offline', 'blocked', 'ended']) {
    const f = fixture(); f.advance(0); f.advance(16000); const callback = f.task.fn;
    f.advance(1, { [held]: true }); assert.equal(f.task, null); assert.equal(f.monitor.attempts, 0);
    f.advance(1); await callback(); assert.equal(f.recoveries.length, 0);
  }
});
test('near-end clock/seek updates do not record processed completion; natural end does', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  let watched = 0;
  const context = vm.createContext({ markProcessedDownloadWatched: () => watched++,
    watchProgress: { save() {} }, streamSeek: { duration: 100 }, autoplayEnabled: false });
  const start = app.indexOf('async function handleAutoplayEnd('); const end = app.indexOf('\nfunction stopStreamSeekTimer', start);
  vm.runInContext(app.slice(start, end), context);
  await context.handleAutoplayEnd(); assert.equal(watched, 0);
  await context.handleAutoplayEnd({ naturalEnd: true }); assert.equal(watched, 1);
});

test('explicit hold cancels retries even when media has already failed and no sample remains', async () => {
  const f = fixture(); f.monitor.request('failure', f.sample); const callback = f.task.fn;
  f.monitor.hold(); await callback(); assert.equal(f.recoveries.length,0); assert.equal(f.monitor.attempts,0);
});
