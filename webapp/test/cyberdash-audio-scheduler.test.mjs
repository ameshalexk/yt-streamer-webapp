import test from "node:test";
import assert from "node:assert/strict";
import { planAudioSchedule } from "../public/cyberdash-embedded.mjs";

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
