import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("recommendation playback locks its source for the viewing session", () => {
  const body = app.match(/async function streamRecommendation\(item, autoplayQueue = null\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(body, /const preparedForSession = state\.recommendationPrepared\[item\.id\]\?\.status === "ready"/);
  assert.match(body, /const sessionSource = preparedForSession \? "prepared" : "youtube"/);
  assert.match(body, /recommendation_source_locked/);
  assert.match(body, /replayFn = \(startAt = 0\) => \{[\s\S]*const prepared = preparedForSession/);
  const replayBody = body.match(/replayFn = \(startAt = 0\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  assert.doesNotMatch(replayBody, /state\.recommendationPrepared\[item\.id\]/);
});

test("locked recommendation source is reused by video and audio restart URLs", () => {
  assert.match(app, /tsUrl: prepared \? `\/stream\/ts\/prepared/);
  assert.match(app, /mjpegUrl: prepared \? `\/stream\/prepared/);
  assert.match(app, /audioUrl: prepared \? `\/stream\/audio\/prepared/);
  assert.match(app, /mjpegUrl: prepared \?[^\n]*\/stream\/youtube/);
  assert.match(app, /audioUrl: prepared \?[^\n]*\/stream\/audio\/youtube/);
});
