import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const helper = app.match(/let lastPlaybackBufferSample = [\s\S]*?\n}\n\nconst state =/);
assert.ok(helper, "periodic playback helper is present");

function harness() {
  let now = 100_000;
  let paused = false;
  let hidden = false;
  let attempt = 1;
  const emitted = [];
  const sandbox = {
    Date: { now: () => now },
    document: { get hidden() { return hidden; } },
    get playbackPaused() { return paused; },
    streamQualitySelection: "auto",
    currentAttempt: (value) => value === attempt,
    reportPlaybackEvent: (...args) => emitted.push(args),
  };
  vm.runInNewContext(helper[0].replace(/\n\nconst state =$/, ""), sandbox);
  return {
    report: (args = {}) => sandbox.reportPeriodicPlaybackSample({
      attempt, method: "webcodecs", label: "WebCodecs",
      streamUrl: "https://www.youtube.com/watch?v=test",
      stats: { state: "playing", renderedFrames: 24, queueSeconds: 1.5, ...args },
    }),
    emitted,
    advance: (ms) => { now += ms; },
    pause: (value) => { paused = value; },
    hide: (value) => { hidden = value; },
    setAttempt: (value) => { attempt = value; },
  };
}

test("records active buffer stats at most every 15 seconds per attempt", () => {
  const h = harness();
  h.report();
  h.report();
  h.advance(14_999);
  h.report();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0][0], "playback_buffer_sample");
  assert.equal(h.emitted[0][1].stats.queueSeconds, 1.5);
  h.advance(1);
  h.report({ queueSeconds: 0.2, queueTrend: "shrinking" });
  assert.equal(h.emitted.length, 2);
  assert.equal(h.emitted[1][1].stats.queueTrend, "shrinking");
  h.setAttempt(2);
  h.report();
  assert.equal(h.emitted.length, 3, "new stream gets an immediate sample");
});

test("does not log pause, hidden tab, initial buffering, or inactive playback", () => {
  const h = harness();
  h.pause(true); h.report();
  h.pause(false); h.hide(true); h.report();
  h.hide(false); h.report({ state: "paused" });
  h.report({ state: "buffering", renderedFrames: 0 });
  h.report({ state: "stopped" });
  assert.equal(h.emitted.length, 0);
  h.report({ state: "buffering" });
  assert.equal(h.emitted.length, 1, "post-first-picture rebuffer is sampled");
});

test("both MJPEG and WebCodecs report stats ahead of Auto tier switches", () => {
  assert.match(app, /reportPeriodicPlaybackSample\(\{ attempt, method: "mjpeg"[\s\S]*?if \(maybeAdaptAutoQuality\(stats\)\)/);
  assert.match(app, /method: "webcodecs"[\s\S]*?maybeAdaptAutoQuality\(stats\)/);
});
