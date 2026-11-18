import test from "node:test";
import assert from "node:assert/strict";
import { advanceAudioHealthIncident, classifyAudioSchedule, detectPrematureAudioEnd, fastPlaybackBufferTargets, normalSpeedNeedsRebuffer, normalizePlaybackRate, planAudioSchedule, playbackStartupReady } from "../public/cyberdash-embedded.mjs";

const FRAME = 1024 / 48000;

test("audio scheduler keeps adjacent AAC blocks sample-continuous", () => {
  const plan = planAudioSchedule({
    expectedStart: 10 + FRAME,
    cursor: 10 + FRAME,
    now: 9.5,
    duration: FRAME,
  });
  assert.equal(plan.start, 10 + FRAME);
  assert.equal(plan.lateBy, 0);
  assert.equal(plan.overlapPrevented, false);
});

test("audio scheduler closes tiny timestamp gaps that can click", () => {
  const cursor = 20;
  const plan = planAudioSchedule({
    expectedStart: cursor + 0.005,
    cursor,
    now: 19,
    duration: FRAME,
  });
  assert.equal(plan.start, cursor);
  assert.equal(plan.continuityAdjusted, true);
});

test("audio scheduler never overlaps decoded AAC blocks", () => {
  const cursor = 30;
  const plan = planAudioSchedule({
    expectedStart: cursor - 0.006,
    cursor,
    now: 29,
    duration: FRAME,
  });
  assert.equal(plan.start, cursor);
  assert.equal(plan.overlapPrevented, true);
});

test("late decoded bursts are rebased instead of stacking at one start time", () => {
  const now = 40.08;
  const first = planAudioSchedule({
    expectedStart: 40,
    cursor: 40,
    now,
    duration: FRAME,
  });
  assert.ok(first.lateBy > 0);
  assert.ok(first.start >= now + 0.025);

  const offset = first.lateBy;
  const second = planAudioSchedule({
    expectedStart: 40 + FRAME + offset,
    cursor: first.end,
    now,
    duration: FRAME,
  });
  assert.ok(second.start >= first.end);
  assert.equal(second.lateBy, 0);
});

test("audio scheduler preserves real discontinuities larger than jitter tolerance", () => {
  const cursor = 50;
  const plan = planAudioSchedule({
    expectedStart: cursor + 0.05,
    cursor,
    now: 49,
    duration: FRAME,
  });
  assert.equal(plan.start, cursor + 0.05);
  assert.equal(plan.continuityAdjusted, false);
});


test("playback rate is clamped to the supported 1x-4x range", () => {
  assert.equal(normalizePlaybackRate(0.25), 1);
  assert.equal(normalizePlaybackRate(1.5), 1.5);
  assert.equal(normalizePlaybackRate(4), 4);
  assert.equal(normalizePlaybackRate(9), 4);
  assert.equal(normalizePlaybackRate("bad"), 1);
});


test("fast playback prebuffer scales source video with playback rate", () => {
  const one = fastPlaybackBufferTargets({ playbackRate: 1, fps: 30 });
  assert.equal(one.startupVideoFrames, 3);
  assert.equal(one.startupAudioWallSec, 0);

  const oneFive = fastPlaybackBufferTargets({ playbackRate: 1.5, fps: 30 });
  assert.equal(oneFive.startupWallSec, 1.5);
  assert.equal(oneFive.startupVideoSourceSec, 2.25);
  assert.equal(oneFive.startupVideoFrames, 68);
  assert.equal(oneFive.startupAudioWallSec, 1.5);
  assert.equal(oneFive.rebufferLowWallSec, 0.65);
  assert.equal(oneFive.rebufferHighWallSec, 2);
  assert.equal(oneFive.rebufferHighVideoSourceSec, 3);

  const two = fastPlaybackBufferTargets({ playbackRate: 2, fps: 30 });
  assert.equal(two.startupWallSec, 1.5);
  assert.equal(two.startupVideoSourceSec, 3);
  assert.equal(two.startupVideoFrames, 90);
  assert.equal(two.rebufferHighWallSec, 2.5);
  assert.equal(two.rebufferHighVideoSourceSec, 5);
});

test("fast startup uses playable time rather than an assumed source frame cadence", () => {
  const ready = { playbackRate: 2, videoFrames: 37, audioBlocks: 5, videoSourceSec: 3, audioWallSec: 1.5 };
  assert.equal(playbackStartupReady(ready), true);
  assert.equal(playbackStartupReady({ ...ready, videoSourceSec: 2.9 }), false);
  assert.equal(playbackStartupReady({ ...ready, audioWallSec: 1.4 }), false);
  assert.equal(playbackStartupReady({ ...ready, videoFrames: 0 }), false);
  assert.equal(playbackStartupReady({ ...ready, audioBlocks: 0 }), false);
  for (const rate of [1.25, 1.5, 2, 3, 4]) {
    const targets = fastPlaybackBufferTargets({ playbackRate: rate });
    assert.ok(targets.startupAudioWallSec > targets.rebufferLowWallSec);
    assert.ok(targets.startupVideoSourceSec > targets.rebufferLowWallSec * rate);
  }
});

test("startup plays a short completed tail without waiting for impossible reserves", () => {
  const tail = { playbackRate: 2, videoFrames: 12, audioBlocks: 3, videoSourceSec: 0.8, audioWallSec: 0.4 };
  assert.equal(playbackStartupReady(tail), false);
  assert.equal(playbackStartupReady({ ...tail, videoFeedDone: true }), false);
  assert.equal(playbackStartupReady({ ...tail, audioFeedDone: true }), false);
  assert.equal(playbackStartupReady({ ...tail, videoFeedDone: true, audioFeedDone: true }), true);
  assert.equal(playbackStartupReady({ ...tail, videoFeedDone: true, audioFeedDone: true, videoFrames: 0 }), false);
  assert.equal(playbackStartupReady({ ...tail, videoFeedDone: true, audioFeedDone: true, audioBlocks: 0 }), false);
});


test("normal-speed stall protection waits for a real underrun without slowing startup", () => {
  const base = { hasFirstPicture: true, videoAheadSec: 0.02, audioAheadSec: 0.8 };
  assert.equal(normalSpeedNeedsRebuffer({ ...base, timeSinceVideoFrameMs: 150 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, timeSinceVideoFrameMs: 499 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, timeSinceVideoFrameMs: 500 }), true);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, videoAheadSec: 0.5, timeSinceVideoFrameMs: 900 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, hasFirstPicture: false, timeSinceVideoFrameMs: 900 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, videoFeedDone: true, timeSinceVideoFrameMs: 900 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, audioFeedDone: true, timeSinceVideoFrameMs: 900 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, videoAheadSec: 0.5, audioAheadSec: 0.01, timeSinceAudioReadyMs: 349 }), false);
  assert.equal(normalSpeedNeedsRebuffer({ ...base, videoAheadSec: 0.5, audioAheadSec: 0.01, timeSinceAudioReadyMs: 350 }), true);
  const one = fastPlaybackBufferTargets({ playbackRate: 1, fps: 15 });
  assert.equal(one.startupVideoFrames, 3);
  assert.equal(one.rebufferHighVideoSourceSec, 0.45);
  assert.equal(one.rebufferHighWallSec, 0.45);
});

test("audio diagnostic classifies running-video scheduling gaps without affecting playback", () => {
  const base = { playing: true, audioStarted: true, videoMoving: true, audioContextState: "running", audioAheadSec: 0.01 };
  assert.equal(classifyAudioSchedule(base), "audio_schedule_empty");
  assert.equal(classifyAudioSchedule({ ...base, audioAheadSec: 0.4 }), null);
  assert.equal(classifyAudioSchedule({ ...base, audioContextState: "suspended" }), "audio_context_not_running");
  assert.equal(classifyAudioSchedule({ ...base, muted: true }), null);
  assert.equal(classifyAudioSchedule({ ...base, playing: false }), null);
  assert.equal(classifyAudioSchedule({ ...base, videoMoving: false }), null);
  assert.equal(classifyAudioSchedule({ ...base, audioStarted: false }), null);
});


test("audio diagnostics require persistent gaps, report once and record recovery", () => {
  const state = { audioDiagnosticGapReason: null, audioDiagnosticGapAt: 0, audioDiagnosticReported: false };
  assert.equal(advanceAudioHealthIncident(state, 1000, "audio_schedule_empty"), null);
  assert.equal(advanceAudioHealthIncident(state, 3000, "audio_schedule_empty"), null);
  assert.deepEqual(advanceAudioHealthIncident(state, 3600, "audio_schedule_empty"), {
    event: "cyberdash_audio_anomaly", reason: "audio_schedule_empty",
  });
  assert.equal(advanceAudioHealthIncident(state, 4000, "audio_schedule_empty"), null);
  assert.deepEqual(advanceAudioHealthIncident(state, 4100, null), {
    event: "cyberdash_audio_recovered", reason: "audio_schedule_empty",
  });
  assert.equal(advanceAudioHealthIncident(state, 4200, null), null);
});

const terminalBase = {
  playing: true, hasFirstPicture: true, audioFeedDone: true,
  audioEndPtsSec: 569.6, videoEndPtsSec: 666.5, startAt: 113.83,
  knownVideoEndSec: 779, currentSourceSec: 686,
};

test("premature audio exhaustion catches the confirmed late-video EOF and clearly short completed feeds", () => {
  const failure = detectPrematureAudioEnd(terminalBase);
  assert.ok(failure);
  assert.ok(Math.abs(failure.audioEndSourceSec - 683.43) < 1e-9);
  assert.ok(Math.abs(failure.evidenceEndSourceSec - 780.33) < 1e-9);
  assert.ok(Math.abs(failure.remainingSourceSec - 94.33) < 1e-9);
  assert.ok(detectPrematureAudioEnd({
    ...terminalBase, videoEndPtsSec: 666.5, knownVideoEndSec: null,
  }));
});

test("premature audio exhaustion waits for playback to reach the true audio end", () => {
  assert.equal(detectPrematureAudioEnd({ ...terminalBase, currentSourceSec: 680.44 }), null);
  assert.equal(detectPrematureAudioEnd({
    ...terminalBase, currentSourceSec: 571.59, audioAheadSec: 0,
    startAt: 0, videoEndPtsSec: 571.5, knownVideoEndSec: 572,
  }), null);
  assert.equal(detectPrematureAudioEnd({
    ...terminalBase, currentSourceSec: 571.61, audioAheadSec: 0,
    startAt: 0, videoEndPtsSec: 571.5, knownVideoEndSec: 572,
  }), null);
});

test("premature audio exhaustion aligns seek offsets and rate-scaled audio PTS", () => {
  const prepared = detectPrematureAudioEnd({
    ...terminalBase,
    startAt: 600,
    segmentOffsetSourceSec: 0.75,
    audioEndPtsSec: 10,
    videoEndPtsSec: 80,
    knownVideoEndSec: 700,
    currentSourceSec: 623,
    playbackRate: 2,
  });
  assert.ok(prepared);
  assert.equal(prepared.audioEndSourceSec, 620.75);
  assert.equal(prepared.evidenceEndSourceSec, 700);
  assert.equal(prepared.remainingSourceSec, 77);
  // Prepared video PTS is already segmentStartAt-relative, so the within-
  // segment audio offset must not be added to its endpoint a second time.
  assert.equal(detectPrematureAudioEnd({
    ...terminalBase,
    startAt: 600,
    segmentOffsetSourceSec: 0.75,
    audioEndPtsSec: 10,
    videoEndPtsSec: 11.5,
    knownVideoEndSec: null,
    currentSourceSec: 625,
    playbackRate: 2,
  }), null);
});

test("premature audio exhaustion excludes startup, pause, mute, stop, and external audio", () => {
  for (const override of [
    { playing: false },
    { hasFirstPicture: false },
    { paused: true },
    { stopped: true },
    { muted: true },
    { externalAudio: true },
    { audioFeedDone: false },
    { audioAheadSec: 0.051 },
  ]) {
    assert.equal(detectPrematureAudioEnd({ ...terminalBase, ...override }), null, JSON.stringify(override));
  }
});
