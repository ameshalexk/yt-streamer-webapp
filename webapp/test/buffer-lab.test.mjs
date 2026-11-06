import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BoundedSegmentBuffer } from "../public/segment-prefetch.mjs";
import { fastPlaybackBufferTargets } from "../public/cyberdash-embedded.mjs";
import { buildCyberdashDashArgs } from "../src/lib/cyberdash-dash.js";

const data = (bytes) => ({ data: new Uint8Array(bytes).buffer });

test("Buffer Lab is off by default; legacy startup and rebuffer targets unchanged", () => {
  assert.deepEqual(fastPlaybackBufferTargets({ playbackRate: 1 }), {
    startupWallSec: 0, startupVideoSourceSec: 0, startupVideoFrames: 3,
    startupAudioWallSec: 0, rebufferLowWallSec: 0.05,
    rebufferHighWallSec: 0.45, rebufferHighVideoSourceSec: 0.45,
  });
  const lab = fastPlaybackBufferTargets({ playbackRate: 1, fps: 15, bufferLab: true });
  assert.ok(lab.startupVideoSourceSec >= 1);
  assert.ok(lab.rebufferHighWallSec > 1);
  assert.ok(lab.rebufferHighVideoSourceSec > 1);
});

test("experimental buffer is bounded by both compressed bytes and segment count", async () => {
  const q = new BoundedSegmentBuffer({ maxBytes: 100, maxSegments: 2, pollMs: 5 });
  assert.equal(await q.push(data(60)), true);
  assert.equal(await q.push(data(35)), true);
  let reached = false;
  const waiting = q.push(data(70)).then((ok) => { reached = true; return ok; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reached, false);
  await q.shift();
  assert.equal(reached, false);
  await q.shift();
  assert.equal(await waiting, true);
  assert.equal(q.bytes, 70);
  assert.equal(q.size, 1);
  assert.equal(q.peakBytes, 95);
  assert.equal(q.peakSegments, 2);
  q.close();
  assert.deepEqual(await q.shift(), data(70));
  assert.equal(await q.shift(), null);
});

test("buffer rejects oversized fragments and cancels a waiting producer on stop", async () => {
  const q = new BoundedSegmentBuffer({ maxBytes: 1024, maxSegments: 1, pollMs: 5 });
  await assert.rejects(q.push(data(1025)), /byte limit/);
  await q.push(data(50));
  let stopped = false;
  const producer = q.push(data(50), { shouldStop: () => stopped });
  await new Promise((resolve) => setTimeout(resolve, 15));
  stopped = true;
  assert.equal(await producer, false);
  assert.equal(q.size, 1);
});

test("buffer propagates producer error without discarding already delivered data", async () => {
  const q = new BoundedSegmentBuffer({ pollMs: 5 });
  await q.push(data(4));
  q.fail(new Error("network failure"));
  assert.equal((await q.shift()).data.byteLength, 4);
  await assert.rejects(q.shift(), /network failure/);
});

test("fast input headroom only applies to explicit per-session opt-in", () => {
  const opts = { videoInput: "source.mp4", manifestPath: "/tmp/test.mpd", initialBurstSupported: true };
  const base = buildCyberdashDashArgs(opts);
  const lab = buildCyberdashDashArgs({ ...opts, bufferLab: true });
  const at = (arr, flag) => arr[arr.indexOf(flag) + 1];
  assert.equal(at(base, "-readrate"), "1.15");
  assert.equal(at(lab, "-readrate"), "2");
  assert.equal(at(base, "-readrate_initial_burst"), "4");
  assert.equal(at(lab, "-readrate_initial_burst"), "8");
});

test("feature stays opt-in and only uses WebCodecs VOD per playback session", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const player = readFileSync(new URL("../public/cyberdash-embedded.mjs", import.meta.url), "utf8");
  assert.match(app, /localStorage\.getItem\(BUFFER_LAB_FLAG_KEY\) === "1"/);
  assert.match(app, /bufferLab: bufferLabEnabled && !preparedId/);
  assert.match(server, /bufferLab: body\.bufferLab === true/);
  assert.match(player, /state\.bufferLab \? 8 : 40/);
  assert.match(player, /const reserve = new BoundedSegmentBuffer\(\)/);
});

test("lab telemetry supports an upgrade with compressed headroom while legacy queue remains short", async () => {
  await import("../public/e-auto.js");
  await import("../public/auto-quality.js");
  const { AutoQualityController } = globalThis.YtAutoQuality;
  const decisions = [];
  function simulate(bufferLab) {
    let now = 0, frames = 0;
    const quality = new AutoQualityController({ now: () => now });
    quality.enable();
    for (let i = 0; i < 38; i++) {
      now += 1000;
      frames += 15;
      const next = quality.observe({
        transport: "webcodecs", state: "playing", fps: 15,
        renderedFrames: frames, droppedFrames: 0, averageDecodeMs: 5, decoderQueueSize: 0,
        bufferLab, compressedAheadSec: bufferLab ? 9 : null,
        queueSeconds: 0.4, queueTargetSeconds: 2, producerSpeed: 1,
        capacityBps: 6e6, mediaBps: 850000, deliveryBps: 860000,
        latencyMs: 25, rebufferCount: 0, rebufferDurationMs: 0,
      });
      if (next) { decisions.push({ bufferLab, ...next }); break; }
    }
    return quality.tier;
  }
  assert.equal(simulate(false), "medium", "short legacy decoded queue must not trigger an upgrade");
  assert.equal(simulate(true), "high", "sustained compressed headroom can justify a cautious opt-in upgrade");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, "stable-headroom");
});
