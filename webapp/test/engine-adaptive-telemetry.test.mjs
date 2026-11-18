import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

await import("../public/buffered-mjpeg.js");
const { videoCapacitySample } = await import("../public/cyberdash-embedded.mjs");
const { BufferedMjpegPlayer } = globalThis.BufferedMjpeg;

test("MJPEG engine emits observed throughput, media bitrate, and local playback state", () => {
  const canvas = { width: 640, height: 360, getContext: () => ({}) };
  const player = new BufferedMjpegPlayer({ url: "/fixture", canvas, fps: 20, audioEnabled: () => false });
  const now = player.startedAt + 1000;
  player.stats.receivedBytes = 2000;
  player.stats.receivedFrameBytes = 2000;
  player.stats.receivedFrames = 20;
  player.stats.renderedFrames = 21;
  player.firstRenderedAt = player.startedAt;
  player.decodeCount = 1;
  player.decodeTotalMs = 20;
  player._updateRates(now);

  const stats = player.getStats();
  assert.equal(stats.transport, "mjpeg");
  assert.equal(stats.adaptiveEligible, true);
  assert.equal(stats.deliveryBps, 16000);
  assert.equal(stats.mediaBps, 16000);
  assert.equal(stats.capacityBps, null);
  assert.equal(stats.latencyMs, null);
  assert.equal(stats.effectiveWidth, 640);
  assert.equal(stats.effectiveHeight, 360);
  assert.equal(stats.effectiveFps, 20);
  assert.equal(stats.decodePressure, 0.4);
  assert.equal(stats.audioStatus, "unavailable");
  assert.equal(stats.audioOnlyPressure, false);
  assert.equal(stats.sourceEnded, false);
  player.destroy();
});

test("MJPEG rebuffer duration stops accumulating across pause and background holds", async () => {
  const player = new BufferedMjpegPlayer({ url: "/fixture", canvas: { getContext: () => ({}) }, audioEnabled: () => false });
  player.playbackStarted = true;
  player._setState("buffering");
  await new Promise((resolve) => setTimeout(resolve, 15));
  player.userPaused = true;
  player._setState("paused");
  const afterPause = player.rebufferDurationTotalMs;
  assert.ok(afterPause >= 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(player.rebufferDurationTotalMs, afterPause);

  player.userPaused = false;
  player._setState("buffering");
  await new Promise((resolve) => setTimeout(resolve, 15));
  player.hidden = true;
  player._setState("background");
  const afterBackground = player.rebufferDurationTotalMs;
  assert.ok(afterBackground >= afterPause + 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(player.rebufferDurationTotalMs, afterBackground);
  player.destroy();
});

test("WebCodecs telemetry excludes prepared-cache network claims and exposes measured dynamic signals", async () => {
  const source = await readFile(new URL("../public/cyberdash-embedded.mjs", import.meta.url), "utf8");
  assert.match(source, /transport: "webcodecs"/);
  assert.match(source, /adaptiveEligible: !state\.preparedStatic/);
  assert.match(source, /deliveryBps,\s*capacityBps: recentCapacity \? state\.capacityBps : null/);
  assert.match(source, /latencyMs: recentLatency \? state\.latencyMs : null/);
  assert.match(source, /now - state\.capacityAt <= 3500/);
  assert.match(source, /now - state\.latencyAt <= 3500/);
  assert.match(source, /kind === "video"\) \{/);
  assert.match(source, /queueTargetSeconds: state\.firstPictureMs == null/);
  assert.match(source, /droppedFramesDelta: Math\.max\(0, state\.droppedFrames - lastStatsDroppedFrames\)/);
  assert.match(source, /sourceEnded: Boolean\(state\.videoFeedDone\)/);
  assert.match(source, /playbackRate: normalizePlaybackRate\(state\.playbackRate\)/);
  assert.match(source, /audioMuted: Boolean\(state\.requestedMuted\)/);
});

test("small or invalid responses cannot claim capacity, and fast valid video bodies remain useful", () => {
  assert.equal(videoCapacitySample(1000, 10), null);
  assert.equal(videoCapacitySample(32768, NaN), null);
  assert.equal(videoCapacitySample(32768, 10), 7489829);
  assert.equal(videoCapacitySample(32768, 200), 1310720);
});
