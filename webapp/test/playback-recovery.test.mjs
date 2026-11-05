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
test('freeze recovery preserves position and keeps retrying with capped backoff after attempt three', async () => {
  const f = fixture();
  const expectedDelays = [1000, 3000, 8000, 15000, 30000, 60000, 60000];
  for (let i = 0; i < expectedDelays.length; i++) {
    const attempt = i + 1;
    f.advance(0, { attempt });
    f.advance(16000, { attempt });
    assert.equal(f.task.delay, expectedDelays[i]);
    await f.run();
    assert.equal(f.recoveries.at(-1).position, 42);
  }
  assert.equal(f.monitor.attempts, 7);
  assert.equal(f.events.filter(e => e.state === 'exhausted').length, 0);
  assert.equal(f.monitor.recoveryActive, true);
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
test('recurrent audio stalls stay on the audio path without rebuilding useful video', async () => {
  const f = fixture(); f.advance(0, { audioEnabled: true });
  f.advance(9000, { audioEnabled: true, videoProgress: 50 }); await f.run(); assert.equal(f.recoveries[0].audioOnly, true);
  f.advance(9000, { audioEnabled: true, videoProgress: 100 }); await f.run(); assert.equal(f.recoveries[1].audioOnly, true);
});
test('audio loading and browser gesture denial suppress competing audio repairs', () => {
  for (const audioStatus of ['retrying', 'gesture-required']) {
    const f = fixture(); f.advance(0, { audioEnabled: true, audioStatus });
    f.advance(9000, { audioEnabled: true, audioStatus, audioError: true, videoProgress: 50 });
    assert.equal(f.task, undefined, audioStatus);
  }
});
test('video reader failure still rebuilds video even when an audio repair callback exists', async () => {
  const f = fixture();
  assert.equal(f.monitor.request('failure', f.sample), true);
  await f.run();
  assert.equal(f.recoveries[0].audioOnly, false);
  assert.equal(f.recoveries[0].position, 42);
});
test('failed audio repairs keep capped backoff and audio-only routing', async () => {
  const calls = [];
  const f = fixture({ recover: async sample => { calls.push(sample); throw new Error('fixture audio unavailable'); } });
  f.monitor.request('audio', { ...f.sample, audioEnabled: true });
  for (const delay of [1000, 3000, 8000, 15000, 30000, 60000, 60000]) {
    assert.equal(f.task.delay, delay);
    await f.run();
    assert.equal(calls.at(-1).audioOnly, true);
  }
  f.monitor.reset();
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

test('rejected reconnect requeues automatically without a button press', async () => {
  let failed = 0;
  const f = fixture({ recover: async () => { failed++; throw new Error('network unreachable'); } });
  f.monitor.request('failure', f.sample);
  assert.equal(f.task.delay, 1000);
  await f.run();
  assert.equal(failed, 1);
  assert.equal(f.task.delay, 3000);
  await f.run();
  assert.equal(failed, 2);
  assert.equal(f.task.delay, 8000);
});

test('a failure during an in-flight replay queues another attempt instead of getting lost', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture({ recover: async () => gate });
  f.monitor.request('failure', f.sample);
  const running = f.task.fn();
  assert.equal(f.monitor.inFlight, true);
  assert.equal(f.monitor.request('failure', f.sample), true);
  finish();
  await running;
  assert.equal(f.task.delay, 3000);
});

test('pause while replay is in flight prevents a queued follow-up retry', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture({ recover: async () => gate });
  f.monitor.request('failure', f.sample);
  const running = f.task.fn();
  f.monitor.request('failure', f.sample);
  f.monitor.hold();
  finish();
  await running;
  assert.equal(f.monitor.pending, false);
  assert.equal(f.monitor.queued, null);
});

test('network return resumes interrupted recovery without another user action', async () => {
  const f = fixture();
  f.monitor.request('failure', f.sample);
  f.monitor.hold();
  assert.equal(f.task, null);
  assert.equal(f.monitor.recoveryActive, true);
  assert.equal(f.monitor.resume({ ...f.sample, offline: false }), true);
  assert.equal(f.task.delay, 1000);
  await f.run();
  assert.equal(f.recoveries.length, 1);
});

test('lowest quality hides the one-click quality action; higher setting lowers and disables Auto', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="streamRetryBtn"/);
  assert.match(app, /if \(lower\) lower.hidden = !canLowerPlaybackSettings\(\)/);
  const controls = { '#ctlHeight': { value: '360' }, '#ctlFps': { value: '12' }, '#ctlQuality': { value: '12' } };
  const events = [];
  const ctx = vm.createContext({
    replayFn: () => {}, qualityProfilesAvailableForCurrentMode: () => true,
    legacy: { playing: null }, $: selector => controls[selector],
    streamSettingsSnapshot: () => ({
      height: controls['#ctlHeight'].value, fps: controls['#ctlFps'].value, quality: controls['#ctlQuality'].value }),
    setStreamQualitySelection: (value, options) => events.push([value, options.persist]),
    renderFpsPresets: () => {}, renderQuickQuality: () => {},
    renderSettingOptions: () => {}, updateBwHint: () => {},
  });
  const start = app.indexOf('function canLowerPlaybackSettings()');
  const end = app.indexOf('\n// ---- Modals', start);
  vm.runInContext(app.slice(start, end), ctx);
  assert.equal(ctx.canLowerPlaybackSettings(), false);
  assert.equal(ctx.lowerPlaybackSettings(), false);
  controls['#ctlHeight'].value = '480';
  controls['#ctlFps'].value = '24';
  controls['#ctlQuality'].value = '7';
  assert.equal(ctx.canLowerPlaybackSettings(), true);
  assert.equal(ctx.lowerPlaybackSettings(), true);
  assert.deepEqual([controls['#ctlHeight'].value, controls['#ctlFps'].value, controls['#ctlQuality'].value], ['360','12','12']);
  assert.deepEqual(events, [[null, false]]);
  assert.equal(ctx.canLowerPlaybackSettings(), false);
});

test('healthy frames cancel a queued retry and do not reconnect after returning to the tab', () => {
  const f = fixture();
  f.advance(0);
  f.monitor.request('failure', f.sample);
  const retry = f.task;
  f.monitor.hold();
  assert.equal(f.monitor.resume({ ...f.sample, paused: false }), true);
  assert.equal(f.task.delay, retry.delay);
  f.advance(1000, { videoProgress: 11 });
  assert.equal(f.task, null);
  f.monitor.hold();
  assert.equal(f.monitor.resume(f.sample), false);
});
