import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonSilenceMonitor} from '../public/teslamon-silence-monitor.js';

function harness() {
  let time = 0, amplitude = 0, tick = null, closeCount = 0, disconnectCount = 0;
  const timers = {
    setInterval(fn) { tick = fn; return 1; },
    clearInterval(id) { assert.equal(id, 1); tick = null; },
  };
  class Context {
    createMediaStreamSource(stream) {
      assert.equal(stream, 'mic');
      return {connect: node => assert.ok(node), disconnect: () => disconnectCount++};
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        disconnect: () => disconnectCount++,
        getFloatTimeDomainData(data) { data.fill(amplitude); },
      };
    }
    async resume() {}
    async close() { closeCount++; }
  }
  return {
    timers, Context, now: () => time,
    get tick() { return tick; },
    setAmplitude(value) { amplitude = value; },
    advance(ms) { time += ms; tick?.(); },
    get closed() { return closeCount; },
    get disconnected() { return disconnectCount; },
  };
}

test('end-of-speech stops a single command after voiced frames and trailing silence', async () => {
  const h = harness();
  let ended = 0, silent = 0;
  const monitor = createTeslaMonSilenceMonitor({
    stream: 'mic', AudioContextClass: h.Context, timers: h.timers, now: h.now,
    onSpeechEnd: () => ended++, onNoSpeech: () => silent++,
  });
  assert.equal(await monitor.start(), true);
  h.setAmplitude(0.025);
  h.advance(100); h.advance(100);
  assert.equal(ended, 0);
  h.setAmplitude(0);
  h.advance(500);
  assert.equal(ended, 0);
  h.advance(800);
  assert.equal(ended, 1);
  assert.equal(silent, 0);
  assert.equal(h.tick, null);
  h.advance(2000);
  assert.equal(ended, 1);
  assert.equal(h.disconnected, 2);
  assert.equal(h.closed, 1);
  monitor.stop();
  assert.equal(h.closed, 1);
});

test('silence before speech aborts instead of submitting a clip', async () => {
  const h = harness();
  let silent = 0, ended = 0;
  const monitor = createTeslaMonSilenceMonitor({
    stream: 'mic', AudioContextClass: h.Context, timers: h.timers, now: h.now,
    onNoSpeech: () => silent++, onSpeechEnd: () => ended++,
  });
  await monitor.start();
  h.advance(3499); assert.equal(silent, 0);
  h.advance(1); assert.equal(silent, 1);
  h.advance(1000); assert.equal(silent, 1);
  assert.equal(ended, 0);
});

test('an unavailable or failed Web Audio monitor relies on bounded capture timeout', async () => {
  const unavailable = createTeslaMonSilenceMonitor({
    stream: 'mic', AudioContextClass: null,
  });
  assert.equal(await unavailable.start(), false);
  unavailable.stop();
  const rejected = createTeslaMonSilenceMonitor({
    stream: 'mic', AudioContextClass: class {createMediaStreamSource() {throw new Error('failed');} async close() {}},
  });
  assert.equal(await rejected.start(), false);
});
