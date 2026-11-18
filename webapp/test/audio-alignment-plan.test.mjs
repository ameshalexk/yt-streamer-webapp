import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import "../public/playback-recovery.js";

const { audioAlignmentPlan } = globalThis.PlaybackRecovery;

test("delayed audio repair requests a fresh source timestamp at the current video position", () => {
  const plan = audioAlignmentPlan({ streamStartAt: 120, requestedLocalTime: 18, currentLocalTime: 23.4 });
  assert.ok(Math.abs(plan.targetAudioTime - 5.4) < 1e-9);
  assert.equal(plan.sourceTimestamp, 143.4);
  assert.equal(plan.requestFreshSegment, true);
  assert.equal(plan.withinTolerance, false);
});

test("a playable buffered or seekable audio range can align to the current source clock", () => {
  const plan = audioAlignmentPlan({ streamStartAt: 30, requestedLocalTime: 9.5, currentLocalTime: 9.56,
    toleranceSeconds: 0.1 });
  assert.ok(plan.targetAudioTime > 0 && plan.targetAudioTime < 0.1);
  assert.equal(plan.sourceTimestamp, 39.56);
  assert.equal(plan.requestFreshSegment, false);
  assert.equal(plan.withinTolerance, true);
});

test("full-file audio aligns against absolute media time instead of a stale request offset", () => {
  const plan = audioAlignmentPlan({ fullFile: true, streamStartAt: 47, requestedLocalTime: 12,
    currentLocalTime: 16.25 });
  assert.equal(plan.targetAudioTime, 63.25);
  assert.equal(plan.sourceTimestamp, 63.25);
  assert.equal(plan.requestFreshSegment, false);
});

test("application alignment waits for playable media and reports scalar readiness diagnostics", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /audioReadyForSync\(audio\)[\s\S]*?const alignment = window\.PlaybackRecovery\.audioAlignmentPlan/);
  assert.match(app, /audioMediaReadyState:[\s\S]*?audioMediaNetworkState:[\s\S]*?audioMediaPaused:[\s\S]*?audioMediaTimeSec:[\s\S]*?audioBufferedSeconds:[\s\S]*?audioLoadElapsedMs:/);
  assert.match(app, /activeCompat\.cancelAudioRecovery =/);
  assert.match(app, /NotAllowedError/);
});


test("buffered player marks already-playing audio synchronized after video startup", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const playing = app.match(/if \(stateName === "playing"\) \{([\s\S]*?)if \(!loggedPlaying\)/)?.[1];
  assert.ok(playing, "buffered playing handler is present");
  assert.match(playing, /activeCompat\.playbackStarted = true/);
  assert.match(playing, /audioReadyForSync\(audio\) && !audio\.paused/);
  assert.match(playing, /activeCompat\.audioStatus = "synced"/);
});


test("buffered startup only primes audio once and does not downgrade active sound", async () => {
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /let initialAudioPrimed = false/);
  assert.match(app, /!player\.playbackStarted && !initialAudioPrimed[\s\S]*?initialAudioPrimed = true/);
  assert.match(app, /player\.playbackStarted && !audio\.paused \? "synced" : "ready"/);
});
