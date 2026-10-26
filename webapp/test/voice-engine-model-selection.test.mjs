import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceEngine } from '../public/games/voice-engine.js';

class MockWorker {
  static instances = [];
  constructor(url) { this.url = url; this.messages = []; MockWorker.instances.push(this); }
  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      if (message.type === 'load') {
        this.onmessage?.({ data: { id: message.id, type: 'ready', modelInfo: { modelId: message.modelId, modelLabel: 'test model' } } });
      } else if (message.type === 'transcribe') {
        this.onmessage?.({ data: { id: message.id, type: 'result', text: 'hello', elapsedMs: 5 } });
      }
    });
  }
  terminate() { this.terminated = true; }
}

test('default engine remains Whisper Tiny and sends its immutable selection to the worker', async () => {
  const priorWorker = globalThis.Worker;
  globalThis.Worker = MockWorker;
  MockWorker.instances = [];
  try {
    const engine = new VoiceEngine();
    const info = await engine.load();
    assert.equal(info.modelId, 'whisper-tiny.en');
    assert.equal(MockWorker.instances[0].messages[0].modelId, 'whisper-tiny.en');
    const result = await engine.transcribe(new Float32Array([0.2]));
    assert.equal(result.text, 'hello');
    assert.equal(MockWorker.instances[0].messages[1].modelId, 'whisper-tiny.en');
    engine.dispose();
  } finally { globalThis.Worker = priorWorker; }
});

test('base selection is sent to worker and appears in selected model state', async () => {
  const priorWorker = globalThis.Worker;
  globalThis.Worker = MockWorker;
  MockWorker.instances = [];
  try {
    const engine = new VoiceEngine({ modelId: 'whisper-base.en' });
    const info = await engine.load();
    assert.equal(info.modelId, 'whisper-base.en');
    assert.equal(engine.modelInfo.modelId, 'whisper-base.en');
    assert.equal(MockWorker.instances[0].messages[0].modelId, 'whisper-base.en');
    engine.dispose();
  } finally { globalThis.Worker = priorWorker; }
});

test('unknown model IDs fail before creating a worker', () => {
  const priorWorker = globalThis.Worker;
  globalThis.Worker = MockWorker;
  MockWorker.instances = [];
  try {
    assert.throws(() => new VoiceEngine({ modelId: 'whisper-large.en' }), /Unsupported voice model/);
    for (const modelId of ['toString', 'constructor', '__proto__', null, 1]) {
      assert.throws(() => new VoiceEngine({ modelId }), /Unsupported voice model/);
    }
    assert.equal(MockWorker.instances.length, 0);
  } finally { globalThis.Worker = priorWorker; }
});
