import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
await import('../public/playback-diagnostics.js');
const { normalize, report, render } = globalThis.PlaybackDiagnostics;

test('normalizes allowlisted numeric metrics and known aliases', () => {
  const result = normalize({ method: 'webcodecs', state: 'playing', quality: 'high', qualityReason: 'stable-headroom', audioStatus: 'synced', errorCategory: 'playback-failed', stats: {
    queueSeconds: 2.34, receiveFps: 30.26, renderedFps: 29, droppedFrames: 0, rebufferCount: 2,
    lastAvDriftMs: -12, averageDecodeMs: 4.26, receiveBytesPerSecond: 524288, decoderQueueSize: 3, fps: 30,
  } });
  assert.deepEqual(result.metrics, {
    queueSeconds: 2.3, receiveFps: 30.3, renderedFps: 29, droppedFrames: 0, rebufferCount: 2,
    latestAvDriftMs: -12, decodeMs: 4.3, receiveBytesPerSecond: 524288, decoderQueueSize: 3, fps: 30,
  });
  assert.equal(result.method, 'WebCodecs');
  assert.equal(result.qualityReason, 'Stable playback');
  assert.equal(result.errorCategory, 'Playback');
});

test('distinguishes absent and invalid metrics from explicit zero', () => {
  const result = normalize({ stats: { droppedFrames: 0, queueSeconds: null, renderedFps: 'NaN', receiveFps: -1 } });
  assert.equal(result.metrics.droppedFrames, 0);
  assert.equal(result.metrics.queueSeconds, 'Unavailable');
  assert.equal(result.metrics.renderedFps, 'Unavailable');
  assert.equal(result.metrics.receiveFps, 'Unavailable');
  assert.equal(result.metrics.fps, 'Unavailable');
});

test('unknown fields and hostile strings never pass through normalization or report', () => {
  const hostile = 'https://private.example/watch?token=abc <img src=x onerror=alert(1)>';
  const result = normalize({ method: hostile, state: hostile, quality: hostile, qualityReason: hostile, errorCategory: hostile, title: hostile, url: hostile, error: hostile, stats: { queueSeconds: 1 } });
  assert.equal(result.method, 'Unavailable');
  assert.equal(result.state, 'Unavailable');
  const text = report({ ...result, title: hostile, url: hostile, error: hostile });
  assert.equal(text.includes(hostile), false);
  assert.equal(text.includes('token=abc'), false);
  assert.match(text, /excludes titles and URLs/);
  assert.match(text, /not an estimate of internet speed/);
});

test('method and audio labels are bounded; empty snapshots report unavailable', () => {
  assert.equal(normalize({ method: 'mjpeg', audioStatus: 'retrying' }).method, 'MJPEG');
  assert.equal(normalize({ method: 'jxl', audioStatus: 'retrying' }).audioStatus, 'Retrying');
  const text = report(null);
  assert.match(text, /Method: Unavailable/);
  assert.match(text, /Buffer depth: Unavailable/);
  assert.match(text, /A\/V drift: Unavailable/);
  assert.equal(normalize({ method: 'constructor' }).method, 'Unavailable');
  assert.match(report({ stats: { queueSeconds: 1.5, receiveBytesPerSecond: 1000 } }), /Buffer depth: 1.5 s/);
  assert.match(report({ stats: { receiveBytesPerSecond: 1000 } }), /Stream delivery: 1000 bytes\/s/);
});

test('buffering hints are cautious and require relevant measurements', () => {
  assert.equal(normalize({ state: 'buffering', stats: { fps: 15, receiveFps: 5, queueSeconds: 0.2 } }).hint, 'Possible slow stream delivery');
  assert.equal(normalize({ state: 'buffering', stats: { fps: 15, renderedFps: 4, queueSeconds: 2 } }).hint, 'Device rendering may be behind');
  assert.equal(normalize({ state: 'buffering', stats: { fps: 15 } }).hint, 'Not enough evidence');
  assert.equal(normalize({ state: 'playing', stats: {} }).hint, 'No current buffering');
});

test('render uses textContent and never interpolates snapshot strings as markup', () => {
  const nodes = [];
  const doc = { createElement(tag) { const node = { tag, children: [], textContent: '', append(...items) { this.children.push(...items); } }; nodes.push(node); return node; } };
  const container = { ownerDocument: doc, replaceChildren(...items) { this.children = items; } };
  render(container, { state: '<script>alert(1)</script>', stats: { queueSeconds: 0 } });
  assert.equal(container.children[0].tag, 'dl');
  assert.ok(nodes.every(node => !('innerHTML' in node)));
  assert.ok(nodes.some(node => node.textContent === 'Unavailable'));
  assert.ok(nodes.every(node => !node.textContent.includes('<script>')));
});

test('standalone script exposes the same API through CommonJS module.exports', async () => {
  const source = await readFile(new URL('../public/playback-diagnostics.js', import.meta.url), 'utf8');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.module.exports.normalize, 'function');
  assert.equal(sandbox.module.exports.normalize({ method: 'mjpeg' }).method, 'MJPEG');
});
