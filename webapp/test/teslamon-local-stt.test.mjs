import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeslaMonLocalStt } from '../public/teslamon-local-stt.js';

test('PTT and wake recordings reuse one loaded local engine without uploading audio', async () => {
  let created = 0, loaded = 0, inferred = 0, decoded = 0;
  const phases = [];
  class FakeEngine {
    constructor() { created++; this.loaded = false; this.modelInfo = { cacheState: 'complete' }; this.worker = {}; }
    async load({ onProgress }) {
      loaded++;
      onProgress?.({ phase: 'cached', status: 'progress', progress: 60 });
      this.loaded = true;
    }
    async transcribe(audio) {
      inferred++;
      assert.deepEqual(Array.from(audio), [0.25, 0.5]);
      return { text: inferred === 1 ? 'Play jazz in this tab' : 'Pause this video', elapsedMs: 18 };
    }
    cancelPending() {}
    dispose() {}
  }
  const engine = createTeslaMonLocalStt({
    loadImplementation: async () => ({
      VoiceEngine: FakeEngine,
      decodeRecordedAudio: async (blob) => {
        decoded++;
        assert.equal(blob.size, 8);
        return new Float32Array([0.25, 0.5]);
      }
    })
  });
  const clip = { size: 8 };
  const first = await engine.transcribe(clip, { onPhase: value => phases.push(value.phase) });
  const second = await engine.transcribe(clip, { onPhase: value => phases.push(value.phase) });
  assert.equal(first.text, 'Play jazz in this tab');
  assert.equal(second.text, 'Pause this video');
  assert.deepEqual({ created, loaded, inferred, decoded }, { created: 1, loaded: 1, inferred: 2, decoded: 2 });
  assert.equal(phases.filter(value => value === 'preparing').length, 1);
  assert.equal(phases.filter(value => value === 'cached').length, 1);
  assert.equal(phases.filter(value => value === 'transcribing').length, 2);
  assert.equal(engine.getState().modelInfo.cacheState, 'complete');
});

test('unsupported local model or decoder reports failure and retains a typed-command path', async () => {
  const engine = createTeslaMonLocalStt({ loadImplementation: async () => { throw new Error('WASM unavailable'); } });
  await assert.rejects(engine.transcribe({ size: 8 }), /WASM unavailable/);
  await assert.rejects(engine.transcribe({ size: 8 }), /WASM unavailable/);
  assert.equal(engine.getState().loaded, false);
});

test('already aborted voice requests do not load a worker or decode audio', async () => {
  let imports = 0;
  const engine = createTeslaMonLocalStt({ loadImplementation: async () => { imports++; throw new Error('unexpected import'); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.transcribe({ size: 8 }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(imports, 0);
});

test('dispose resets the in-memory instance, preserving the reusable module implementation', async () => {
  let created = 0, disposed = 0;
  class Engine {
    constructor() { created++; this.loaded = true; this.worker = {}; }
    async transcribe() { return { text: 'jump' }; }
    dispose() { disposed++; }
  }
  const stt = createTeslaMonLocalStt({ loadImplementation: async () => ({
    VoiceEngine: Engine, decodeRecordedAudio: async () => new Float32Array([0.4])
  }) });
  await stt.transcribe({ size: 3 });
  stt.dispose();
  assert.equal(stt.getState().loaded, false);
  await stt.transcribe({ size: 3 });
  assert.equal(created, 2);
  assert.equal(disposed, 1);
});

test('cancellation during a delayed module import unlocks retry without stale inference', async () => {
  let releaseImport, loaded = 0, inferred = 0;
  const implementation = new Promise(resolve => { releaseImport = resolve; });
  class Engine {
    constructor() { this.loaded = false; }
    async load() { loaded++;this.loaded = true; }
    async transcribe() { inferred++;return {text:'Play something'}; }
    cancelPending() {}
    dispose() {}
  }
  const stt = createTeslaMonLocalStt({ loadImplementation: () => implementation });
  const controller = new AbortController();
  const pending = stt.transcribe({size:8}, {signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(stt.getState().busy,false);
  releaseImport({VoiceEngine:Engine,decodeRecordedAudio:async()=>new Float32Array([0.2])});
  const result = await stt.transcribe({size:8});
  assert.equal(result.text,'Play something');
  assert.equal(loaded,1);
  assert.equal(inferred,1,'aborted earlier request never reached inference');
});

test('page cleanup aborts an in-flight decoder and later starts a fresh engine', async () => {
  let releaseDecode, reachedDecode, inferred = 0, created = 0;
  const onDecode = new Promise(resolve => { reachedDecode = resolve; });
  let blockDecode = true;
  class Engine {
    constructor() { created++;this.loaded = true; }
    async transcribe() { inferred++;return {text:'Play news'}; }
    cancelPending() {}
    dispose() {}
  }
  const stt = createTeslaMonLocalStt({ loadImplementation: async()=>({
    VoiceEngine:Engine,
    decodeRecordedAudio:async()=>{
      if(blockDecode) {
        reachedDecode();
        return new Promise(resolve => { releaseDecode = resolve; });
      }
      return new Float32Array([0.5]);
    }
  }) });
  const pending = stt.transcribe({size:8});
  await onDecode;
  stt.dispose();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(stt.getState().busy,false);
  assert.equal(stt.getState().loaded,false);
  blockDecode = false;
  releaseDecode(new Float32Array([0.1]));
  const retry = await stt.transcribe({size:8});
  assert.equal(retry.text,'Play news');
  assert.equal(created,2,'cleanup discarded the prior page worker');
  assert.equal(inferred,1,'late decoded audio did not transcribe');
});
