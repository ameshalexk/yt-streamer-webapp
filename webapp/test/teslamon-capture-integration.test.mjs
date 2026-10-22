import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeslaMonCapture } from '../public/teslamon-capture.js';
import { bindTeslaMonCaptureButton } from '../public/teslamon-capture-binding.js';

class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, properties = {}) {
    let prevented = false;
    const event = { type, preventDefault() { prevented = true; }, ...properties };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return { event, prevented };
  }
  listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

class FakeButton extends FakeTarget {
  disabled = false;
  captured = new Set();
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) {
    if (!this.captured.delete(id)) return;
    this.dispatch('lostpointercapture', { pointerId: id });
  }
}

class FakeTimers {
  jobs = new Map();
  next = 1;
  setTimeout(fn, ms) { const id = this.next++; this.jobs.set(id, { fn, ms }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  run(ms) {
    for (const [id, job] of [...this.jobs]) {
      if (job.ms === ms) { this.jobs.delete(id); job.fn(); }
    }
  }
  get count() { return this.jobs.size; }
}

function makeStream() {
  const tracks = [
    { stopped: 0, stop() { this.stopped++; } },
    { stopped: 0, stop() { this.stopped++; } },
  ];
  return { stream: { getTracks: () => tracks }, tracks };
}

function makeRecorderClass({ stopEvent = true, mimeTypes = ['audio/webm;codecs=opus'] } = {}) {
  const instances = [];
  class FakeRecorder {
    static isTypeSupported(type) { return mimeTypes.includes(type); }
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.handlers = new Map();
      instances.push(this);
    }
    addEventListener(type, fn) {
      const list = this.handlers.get(type) ?? [];
      list.push(fn);
      this.handlers.set(type, list);
    }
    emit(type, event = {}) { for (const fn of this.handlers.get(type) ?? []) fn(event); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (stopEvent) queueMicrotask(() => this.emit('stop'));
    }
    chunk(size, type = this.mimeType) {
      this.emit('dataavailable', { data: new Blob([new Uint8Array(size)], { type }) });
    }
  }
  return { Recorder: FakeRecorder, instances };
}

function setup({ getUserMedia, timers = new FakeTimers(), recorderOptions, onError } = {}) {
  const button = new FakeButton();
  const document = new FakeTarget();
  document.hidden = false;
  const window = new FakeTarget();
  const harness = makeRecorderClass(recorderOptions);
  const audio = [];
  const errors = [];
  const streams = [];
  const capture = createTeslaMonCapture({
    getUserMedia: getUserMedia ?? (async () => {
      const pair = makeStream(); streams.push(pair); return pair.stream;
    }),
    MediaRecorder: harness.Recorder,
    timers,
    onAudio: blob => audio.push(blob),
    onError: error => { errors.push(error); onError?.(error); },
  });
  const binding = bindTeslaMonCaptureButton({ button, document, window, capture });
  const press = (id = 1) => button.dispatch('pointerdown', { pointerId: id, button: 0, isPrimary: true });
  const release = (id = 1) => button.dispatch('pointerup', { pointerId: id });
  return { button, document, window, timers, harness, audio, errors, streams, capture, binding, press, release };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a deliberate press records transient chunks and submits once only after the final stop event', async () => {
  const s = setup();
  s.press(4);
  assert.equal(s.capture.state, 'requesting');
  await settle();
  assert.equal(s.capture.state, 'recording');
  const recorder = s.harness.instances[0];
  recorder.chunk(3);
  assert.equal(s.audio.length, 0, 'chunks stay private while the pointer is held');
  s.release(4);
  s.button.dispatch('lostpointercapture', { pointerId: 4 });
  assert.equal(s.capture.state, 'stopping');
  assert.equal(s.audio.length, 0, 'release waits for recorder stop');
  await settle();
  assert.equal(s.audio.length, 1);
  assert.equal(s.audio[0].size, 3);
  assert.equal(s.audio[0].type, 'audio/webm;codecs=opus');
  assert.equal(s.streams[0].tracks.every(track => track.stopped === 1), true);
  assert.equal(s.timers.count, 0);
  s.binding.dispose();
});

test('release during permission request discards a late grant and remains retryable', async () => {
  let grant;
  let requests = 0;
  const s = setup({ getUserMedia: () => {
    requests++;
    if (requests === 1) return new Promise(resolve => { grant = resolve; });
    const pair = makeStream(); s.streams.push(pair); return Promise.resolve(pair.stream);
  } });
  s.press(1);
  s.release(1);
  assert.equal(s.capture.state, 'idle');
  const late = makeStream();
  grant(late.stream);
  await settle();
  assert.equal(late.tracks.every(track => track.stopped === 1), true);
  assert.equal(s.audio.length, 0);
  s.press(2);
  await settle();
  s.harness.instances[0].chunk(2);
  s.release(2);
  await settle();
  assert.equal(s.audio.length, 1);
  assert.equal(s.audio[0].size, 2);
  assert.equal(s.streams[0].tracks.every(track => track.stopped === 1), true);
  s.binding.dispose();
});

test('pagehide, hidden visibility, and target change discard held and released captures', async t => {
  const cases = [
    ['pagehide while held', async s => s.window.dispatch('pagehide'), true],
    ['hidden while held', async s => { s.document.hidden = true; s.document.dispatch('visibilitychange'); }, true],
    ['target change while held', async s => s.binding.targetChanged(), true],
    ['pagehide after release before stop', async s => { s.release(1); s.window.dispatch('pagehide'); }, false],
    ['hidden after release before stop', async s => { s.release(1); s.document.hidden = true; s.document.dispatch('visibilitychange'); }, false],
    ['target change after release before stop', async s => { s.release(1); s.binding.targetChanged(); }, false],
  ];
  for (const [name, end, held] of cases) await t.test(name, async () => {
    const s = setup();
    s.press(1); await settle();
    s.harness.instances[0].chunk(5);
    if (!held) { /* release is part of end so the pending stop can be cancelled */ }
    await end(s);
    await settle();
    assert.equal(s.audio.length, 0);
    assert.equal(s.streams[0].tracks.every(track => track.stopped === 1), true);
    assert.equal(s.timers.count, 0);
    s.binding.dispose();
  });
});

test('disposing while permission is pending removes listeners and stops a late stream without audio', async () => {
  let grant;
  const s = setup({ getUserMedia: () => new Promise(resolve => { grant = resolve; }) });
  s.press();
  s.binding.dispose();
  assert.equal(s.button.listenerCount() + s.document.listenerCount() + s.window.listenerCount(), 0);
  const late = makeStream();
  grant(late.stream);
  await settle();
  assert.equal(late.tracks.every(track => track.stopped === 1), true);
  assert.equal(s.audio.length, 0);
  assert.equal(s.timers.count, 0);
});

test('stale events from an old recorder cannot alter a newer press', async () => {
  const s = setup();
  s.press(1); await settle();
  const old = s.harness.instances[0];
  old.chunk(2);
  s.release(1); await settle();
  s.press(2); await settle();
  const current = s.harness.instances[1];
  old.emit('error', { error: new Error('stale recorder error') });
  old.chunk(50);
  assert.equal(s.capture.state, 'recording');
  assert.equal(s.audio.length, 1);
  current.chunk(7);
  s.release(2); await settle();
  assert.equal(s.audio.length, 2);
  assert.deepEqual(s.audio.map(blob => blob.size), [2, 7]);
  assert.equal(s.errors.length, 0);
  assert.equal(s.streams.every(pair => pair.tracks.every(track => track.stopped === 1)), true);
  s.binding.dispose();
});

test('duration limit and missing-stop watchdog release tracks, clear timers, and ignore stale recorder callbacks', async () => {
  const s = setup({ recorderOptions: { stopEvent: false } });
  s.press(); await settle();
  const recorder = s.harness.instances[0];
  recorder.chunk(4);
  const duration = [...s.timers.jobs.values()].find(job => job.ms === 20_000);
  assert.ok(duration);
  s.timers.run(20_000);
  assert.equal(s.capture.state, 'stopping');
  assert.equal(s.streams[0].tracks.every(track => track.stopped === 1), true);
  assert.equal(s.timers.count, 1, 'only stop watchdog remains');
  s.timers.run(1_000);
  assert.equal(s.capture.state, 'idle');
  assert.equal(s.audio.length, 0);
  assert.match(s.errors[0].message, /did not stop/);
  assert.equal(s.timers.count, 0);
  recorder.emit('stop');
  recorder.chunk(8);
  assert.equal(s.audio.length, 0);
  s.binding.dispose();
});

test('denied permission can be retried through the same composed button binding', async () => {
  let attempts = 0;
  const s = setup({ getUserMedia: async () => {
    if (++attempts === 1) throw new Error('permission denied');
    const pair = makeStream(); s.streams.push(pair); return pair.stream;
  } });
  s.press(1); await settle();
  assert.equal(s.errors.length, 1);
  assert.equal(s.capture.state, 'idle');
  s.release(1);
  s.press(2); await settle();
  s.harness.instances[0].chunk(6);
  s.release(2); await settle();
  assert.equal(s.audio.length, 1);
  assert.equal(s.audio[0].size, 6);
  assert.equal(s.streams[0].tracks.every(track => track.stopped === 1), true);
  s.binding.dispose();
});

test('a second press while the first recorder is stopping cannot cancel its pending submission', async () => {
  const s = setup({ recorderOptions: { stopEvent: false } });
  s.press(1); await settle();
  s.harness.instances[0].chunk(3);
  s.release(1);
  s.press(2);
  await settle();
  assert.equal(s.harness.instances.length, 1);
  assert.equal(s.capture.state, 'stopping');
  s.release(2);
  s.harness.instances[0].emit('stop');
  await settle();
  assert.deepEqual(s.audio.map(blob => blob.size), [3]);
  assert.equal(s.streams.every(pair => pair.tracks.every(track => track.stopped === 1)), true);
  assert.equal(s.timers.count, 0);
  s.press(3); await settle();
  assert.equal(s.harness.instances.length, 2, 'input remains usable after the earlier stop finishes');
  s.harness.instances[1].chunk(4);
  s.release(3);
  s.harness.instances[1].emit('stop');
  await settle();
  assert.deepEqual(s.audio.map(blob => blob.size), [3, 4]);
  s.binding.dispose();
});

test('a resolved false start after denied permission clears pointer capture', async () => {
  const s = setup({ getUserMedia: async () => { throw new Error('permission denied'); } });
  s.press(8);
  await settle();
  assert.equal(s.button.hasPointerCapture(8), false);
  assert.equal(s.capture.state, 'idle');
  s.binding.dispose();
});
