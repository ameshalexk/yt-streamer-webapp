import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeslaMonCapture, TESLAMON_CAPTURE_LIMITS } from '../public/teslamon-capture.js';

class FakeTimers {
  jobs = new Map();
  next = 1;
  setTimeout(fn, ms) { const id = this.next++; this.jobs.set(id, { fn, ms }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  run(ms) {
    for (const [id, job] of [...this.jobs]) if (job.ms === ms) { this.jobs.delete(id); job.fn(); }
  }
}

function recorderHarness({ mimeTypes = ['audio/webm;codecs=opus'], startError, stopEvent = true, syncStop = false, actualMimeType, chunkOnStop = false } = {}) {
  const instances = [];
  class FakeRecorder {
    static isTypeSupported(type) { return mimeTypes.includes(type); }
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = actualMimeType ?? options.mimeType;
      this.state = 'inactive';
      this.handlers = new Map();
      instances.push(this);
    }
    addEventListener(name, handler) {
      const list = this.handlers.get(name) ?? [];
      list.push(handler);
      this.handlers.set(name, list);
    }
    emit(name, event = {}) { for (const handler of this.handlers.get(name) ?? []) handler(event); }
    start() { if (startError) throw startError; this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      if (stopEvent) {
        const flush=()=>{
          if(chunkOnStop){
            if(this.stream.getTracks().some(t=>t.stopped)) {
              this.emit('error',{error:new Error('track stopped before final audio')});return;
            }
            this.chunk(512,chunkOnStop===true?this.mimeType:chunkOnStop);
          }
          this.emit('stop');
        };
        if(syncStop)flush();else queueMicrotask(flush);
      }
    }
    chunk(size, type = this.mimeType) { this.emit('dataavailable', { data: new Blob([new Uint8Array(size)], { type }) }); }
  }
  return { Recorder: FakeRecorder, instances };
}

function trackStream() {
  const track = { stopped: 0, stop() { this.stopped++; } };
  return { stream: { getTracks: () => [track] }, track };
}

async function settle() { await new Promise(resolve => setImmediate(resolve)); }

test('import and controller creation do not request media; start is explicit and release submits transient audio', async () => {
  let requests = 0, requestedOptions;
  const { Recorder, instances } = recorderHarness();
  const { stream, track } = trackStream();
  const audio = [];
  const controller = createTeslaMonCapture({
    getUserMedia: async options => { requests++; requestedOptions = options; return stream; },
    MediaRecorder: Recorder,
    onAudio: blob => audio.push(blob),
  });
  assert.equal(requests, 0);
  assert.equal(controller.state, 'idle');
  await controller.start();
  assert.equal(requests, 1);
  assert.deepEqual(requestedOptions, {audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  instances[0].chunk(3);
  controller.release();
  await settle();
  assert.equal(track.stopped, 1);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].size, 3);
  assert.equal(controller.state, 'idle');
});

test('release while permission is pending discards a late grant and permits a new session', async () => {
  let resolveFirst;
  let requests = 0;
  const grants = [new Promise(resolve => { resolveFirst = resolve; })];
  const { Recorder, instances } = recorderHarness();
  const { stream: lateStream, track: lateTrack } = trackStream();
  const { stream: liveStream, track: liveTrack } = trackStream();
  const audio = [];
  const controller = createTeslaMonCapture({
    getUserMedia: () => requests++ === 0 ? grants[0] : Promise.resolve(liveStream),
    MediaRecorder: Recorder,
    onAudio: blob => audio.push(blob),
  });
  const pending = controller.start();
  controller.release();
  assert.equal(controller.state, 'idle');
  assert.equal(await controller.start(), true);
  resolveFirst(lateStream);
  await pending;
  assert.equal(lateTrack.stopped, 1);
  assert.equal(liveTrack.stopped, 0);
  instances[0].chunk(2);
  controller.release();
  await settle();
  assert.deepEqual(audio.map(blob => blob.size), [2]);
  assert.equal(liveTrack.stopped, 1);
});

test('cancel lifecycle methods stop tracks without submitting audio', async t => {
  for (const method of ['cancel', 'pointerCancel', 'lostPointerCapture', 'pageHide', 'targetChanged', 'dispose']) {
    await t.test(method, async () => {
      const { Recorder, instances } = recorderHarness();
      const { stream, track } = trackStream();
      const audio = [];
      const controller = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, onAudio: b => audio.push(b) });
      await controller.start();
      instances[0].chunk(2);
      controller[method]();
      await settle();
      assert.equal(track.stopped, 1);
      assert.equal(audio.length, 0);
    });
  }
});

test('synchronous recorder stop cannot turn cancellation or recorder failure into a submission', async () => {
  const canceledHarness = recorderHarness({ syncStop: true });
  const canceledStream = trackStream();
  const canceledAudio = [];
  const canceled = createTeslaMonCapture({ getUserMedia: async () => canceledStream.stream, MediaRecorder: canceledHarness.Recorder, onAudio: b => canceledAudio.push(b) });
  await canceled.start(); canceledHarness.instances[0].chunk(3); canceled.pointerCancel();
  assert.equal(canceledStream.track.stopped, 1);
  assert.equal(canceledAudio.length, 0);

  const errorHarness = recorderHarness({ syncStop: true });
  const errorStream = trackStream(); const errors = []; const audio = [];
  const failed = createTeslaMonCapture({ getUserMedia: async () => errorStream.stream, MediaRecorder: errorHarness.Recorder, onError: e => errors.push(e), onAudio: b => audio.push(b) });
  await failed.start(); errorHarness.instances[0].emit('error', { error: new Error('recorder fault') });
  assert.equal(errorStream.track.stopped, 1);
  assert.equal(audio.length, 0);
  assert.equal(errors.length, 1);
});

test('re-entrant callbacks, actual MIME, chunk MIME, and configurable limits fail closed', async t => {
  await t.test('requesting callback can synchronously cancel before permission request', async () => {
    const harness = recorderHarness(); let requested = 0; let controller;
    controller = createTeslaMonCapture({ getUserMedia: async () => { requested++; return trackStream().stream; }, MediaRecorder: harness.Recorder, onState: s => { if (s.state === 'requesting') controller.cancel(); } });
    assert.equal(await controller.start(), false); assert.equal(requested, 0);
  });
  await t.test('actual recorder MIME must match supported request', async () => {
    const harness = recorderHarness({ actualMimeType: 'audio/x-unknown' }); const { stream, track } = trackStream(); const errors = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: harness.Recorder, onError: e => errors.push(e) });
    assert.equal(await c.start(), false); assert.equal(track.stopped, 1); assert.match(errors[0].message, /unsupported audio format/);
  });
  await t.test('unsupported chunk MIME is rejected', async () => {
    for (const type of ['audio/x-unknown', 'video/mp4']) {
      const harness = recorderHarness(); const { stream, track } = trackStream(); const audio = []; const errors = [];
      const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: harness.Recorder, onAudio: b => audio.push(b), onError: e => errors.push(e) });
      await c.start(); harness.instances[0].chunk(4, type);
      assert.equal(track.stopped, 1); assert.equal(audio.length, 0); assert.match(errors[0].message, /unsupported audio format/);
    }
  });
  await t.test('limits cannot exceed hard maximums', async () => {
    const harness = recorderHarness(); let requests = 0; const errors = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => { requests++; return trackStream().stream; }, MediaRecorder: harness.Recorder, maxDurationMs: 20_001, onError: e => errors.push(e) });
    assert.equal(await c.start(), false); assert.equal(requests, 0); assert.match(errors[0].message, /bounds/);
  });
  await t.test('recording callback can cancel before the duration timer is installed', async () => {
    const harness = recorderHarness(); const timers = new FakeTimers(); const { stream, track } = trackStream(); let c;
    c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: harness.Recorder, timers, onState: s => { if (s.state === 'recording') c.cancel(); } });
    assert.equal(await c.start(), false); assert.equal(track.stopped, 1); assert.equal(timers.jobs.size, 0);
  });
  await t.test('stopping callback can cancel before the watchdog is installed', async () => {
    const harness = recorderHarness(); const timers = new FakeTimers(); const { stream, track } = trackStream(); let c;
    c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: harness.Recorder, timers, onState: s => { if (s.state === 'stopping') c.cancel(); } });
    await c.start(); c.release();
    assert.equal(c.state, 'idle'); assert.equal(track.stopped, 1); assert.equal(timers.jobs.size, 0);
  });
});

test('duration cap stops capture; a stop event watchdog releases a hung recorder', async () => {
  const timers = new FakeTimers();
  const { Recorder, instances } = recorderHarness();
  const { stream, track } = trackStream();
  const audio = [];
  const controller = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, timers, onAudio: b => audio.push(b) });
  await controller.start();
  instances[0].chunk(7);
  timers.run(TESLAMON_CAPTURE_LIMITS.maxDurationMs);
  await settle();
  assert.equal(track.stopped, 1);
  assert.equal(audio[0].size, 7);

  const hungTimers = new FakeTimers();
  const hung = recorderHarness({ stopEvent: false });
  const { stream: hungStream, track: hungTrack } = trackStream();
  const errors = [];
  const second = createTeslaMonCapture({ getUserMedia: async () => hungStream, MediaRecorder: hung.Recorder, timers: hungTimers, onError: e => errors.push(e) });
  await second.start();
  second.release();
  assert.equal(second.state, 'stopping');
  hungTimers.run(8_000);
  assert.equal(hungTrack.stopped, 1);
  assert.match(errors[0].message, /did not stop/);
});

test('oversize chunks, empty recordings, unsupported MIME, denied permission, recorder errors and start exceptions never submit audio', async t => {
  await t.test('oversize cumulative chunks', async () => {
    const { Recorder, instances } = recorderHarness();
    const { stream, track } = trackStream();
    const audio = [];
    const errors = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, onAudio: b => audio.push(b), onError: e => errors.push(e) });
    await c.start();
    instances[0].chunk(TESLAMON_CAPTURE_LIMITS.maxBytes);
    instances[0].chunk(1);
    assert.equal(track.stopped, 1);
    assert.equal(audio.length, 0);
    assert.match(errors[0].message, /configured size limit/);
  });
  await t.test('empty audio', async () => {
    const { Recorder } = recorderHarness();
    const { stream, track } = trackStream();
    const audio = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, onAudio: b => audio.push(b) });
    await c.start(); c.release(); await settle();
    assert.equal(track.stopped, 1); assert.equal(audio.length, 0);
  });
  await t.test('unsupported MIME', async () => {
    const { Recorder } = recorderHarness({ mimeTypes: [] });
    const { stream, track } = trackStream(); const errors = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, onError: e => errors.push(e) });
    assert.equal(await c.start(), false); assert.equal(track.stopped, 1); assert.match(errors[0].message, /format/);
  });
  await t.test('permission denied', async () => {
    const { Recorder } = recorderHarness(); const errors = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => { throw new Error('denied'); }, MediaRecorder: Recorder, onError: e => errors.push(e) });
    assert.equal(await c.start(), false); assert.equal(errors[0].message, 'denied');
  });
  await t.test('recorder error', async () => {
    const { Recorder, instances } = recorderHarness(); const { stream, track } = trackStream(); const audio = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, onAudio: b => audio.push(b) });
    await c.start(); instances[0].emit('error', { error: new Error('recorder fault') }); await settle();
    assert.equal(track.stopped, 1); assert.equal(audio.length, 0);
  });
  await t.test('start exception', async () => {
    const { Recorder, instances } = recorderHarness({ startError: new Error('start fault') }); const { stream, track } = trackStream(); const errors = [];
    const c = createTeslaMonCapture({ getUserMedia: async () => stream, MediaRecorder: Recorder, onError: e => errors.push(e) });
    assert.equal(await c.start(), false); assert.equal(track.stopped, 1); assert.equal(errors[0].message, 'start fault');
  });
});

test('double start is ignored; stale recorder callbacks and throwing consumer callbacks do not impact later sessions', async () => {
  const { Recorder, instances } = recorderHarness();
  const streams = [trackStream(), trackStream()];
  let call = 0;
  const c = createTeslaMonCapture({ getUserMedia: async () => streams[call++].stream, MediaRecorder: Recorder, onAudio: () => { throw new Error('consumer failed'); } });
  const one = c.start();
  assert.equal(await c.start(), false);
  assert.equal(await one, true);
  const old = instances[0];
  old.chunk(1); c.release(); await settle();
  assert.equal(await c.start(), true);
  old.emit('error', { error: new Error('stale') });
  instances[1].chunk(2); c.release(); await settle();
  assert.equal(streams[0].track.stopped, 1);
  assert.equal(streams[1].track.stopped, 1);
  assert.equal(c.state, 'idle');
});

test('terminal state callback that changes target or starts another session suppresses obsolete audio delivery', async () => {
  const harness = recorderHarness();
  const streams = [trackStream(), trackStream()];
  let requested = 0;
  const audio = [];
  let controller;
  controller = createTeslaMonCapture({
    getUserMedia: async () => streams[requested++].stream,
    MediaRecorder: harness.Recorder,
    onAudio: blob => audio.push(blob),
    onState: event => { if (event.state === 'complete') void controller.start(); },
  });
  await controller.start();
  harness.instances[0].chunk(5);
  controller.release();
  await settle();
  assert.equal(audio.length, 0);
  assert.equal(controller.state, 'recording');
  assert.equal(streams[0].track.stopped, 1);
  controller.cancel();
});


test('Safari: final dataavailable arrives only on stop, before tracks are released',async()=>{
  const {Recorder,instances}=recorderHarness({mimeTypes:['audio/mp4'],chunkOnStop:'audio/mp4;codecs=mp4a.40.2'});
  const {stream,track}=trackStream();
  const audio=[];const errors=[];
  const c=createTeslaMonCapture({getUserMedia:async()=>stream,MediaRecorder:Recorder,
    onAudio:blob=>audio.push(blob),onError:e=>errors.push(e)});
  assert.equal(await c.start(),true);
  c.release();
  assert.equal(track.stopped,0,'microphone tracks must remain alive while Safari flushes last chunk');
  await settle();
  assert.equal(track.stopped,1);
  assert.equal(errors.length,0);
  assert.equal(audio.length,1);
  assert.equal(audio[0].size,512);
  assert.equal(audio[0].type,'audio/mp4');
});

test('Safari accepts codec-decorated recorder MIME and an empty chunk MIME',async()=>{
  const {Recorder,instances}=recorderHarness({mimeTypes:['audio/mp4'],actualMimeType:'audio/mp4;codecs=mp4a.40.2'});
  const {stream,track}=trackStream();const audio=[];
  const c=createTeslaMonCapture({getUserMedia:async()=>stream,MediaRecorder:Recorder,onAudio:b=>audio.push(b)});
  assert.equal(await c.start(),true);
  instances[0].chunk(50,'');
  c.release();await settle();
  assert.equal(audio.length,1);assert.equal(audio[0].size,50);assert.equal(track.stopped,1);
});

test('iOS may delay stop event beyond one second; watchdog must not erase pending recording',async()=>{
  const {Recorder,instances}=recorderHarness({stopEvent:false,mimeTypes:['audio/mp4']});
  const timers=new FakeTimers();const {stream,track}=trackStream();const audio=[],errors=[];
  const c=createTeslaMonCapture({getUserMedia:async()=>stream,MediaRecorder:Recorder,timers,
    onAudio:b=>audio.push(b),onError:e=>errors.push(e)});
  await c.start();c.release();timers.run(1000);
  assert.equal(c.state,'stopping');assert.equal(track.stopped,0);
  instances[0].chunk(64,'audio/mp4');instances[0].emit('stop');
  assert.equal(audio.length,1);assert.equal(errors.length,0);
  assert.equal(track.stopped,1);
});
