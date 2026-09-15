import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("adaptive buffering is bounded to 2-4 second startup and 4-6 second queue", () => {
  assert.match(app, /fast: Object\.freeze\(\{ id: "fast", startupSeconds: 2, rebufferSeconds: 1\.25, maxQueueSeconds: 4 \}\)/);
  assert.match(app, /balanced: Object\.freeze\(\{ id: "balanced", startupSeconds: 3, rebufferSeconds: 1\.5, maxQueueSeconds: 5 \}\)/);
  assert.match(app, /resilient: Object\.freeze\(\{ id: "resilient", startupSeconds: 4, rebufferSeconds: 2, maxQueueSeconds: 6 \}\)/);
  assert.doesNotMatch(app, /maxQueueSeconds:\s*8/);
});

test("new browsers start balanced and fast mode needs two healthy samples", () => {
  assert.match(app, /return \{ tier: "balanced", fastStreak: 0/);
  assert.match(app, /if \(fastStreak >= 2\) nextTier = "fast"/);
  assert.match(app, /renderedFrames < fps \* 8/);
});

test("real playback trouble immediately selects resilient buffering", () => {
  assert.match(app, /rebufferCount > 0/);
  assert.match(app, /dropRatio > 0\.05/);
  assert.match(app, /renderRatio < 0\.88/);
  assert.match(app, /driftMs > 180/);
  assert.match(app, /nextTier = "resilient"/);
  assert.match(app, /learnAdaptiveBufferProfile\(stats, \{ force: true \}\)/);
});

test("player uses the selected adaptive policy rather than fixed startup values", () => {
  assert.match(app, /startupSeconds: bufferPolicy\.startupSeconds/);
  assert.match(app, /rebufferSeconds: bufferPolicy\.rebufferSeconds/);
  assert.match(app, /maxQueueSeconds: bufferPolicy\.maxQueueSeconds/);
  assert.match(app, /__YT_STREAMER_BUFFER_POLICY__/);
});
