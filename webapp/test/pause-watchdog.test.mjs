import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const clearTimers = app.slice(app.indexOf("function clearStreamTimers()"), app.indexOf("\nfunction clearStreamNotice()"));
const watchdog = app.slice(app.indexOf("// Only active loading time counts"), app.indexOf("\n// Lazy-load mpegts.js"));
assert.ok(clearTimers.startsWith("function clearStreamTimers"));
assert.ok(watchdog.startsWith("// Only active loading time counts"));

function fixture() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const errors = [], notices = [];
  const context = vm.createContext({
    Date: { now: () => now },
    streamAttempt: 1,
    streamWarnTimer: null, streamFailTimer: null, restreamTimer: null,
    streamWatchdog: null, playbackPaused: false,
    STREAM_WARN_MS: 12000, STREAM_FAIL_MS: 30000,
    Math,
    setTimeout(fn, ms) { const next = ++id; timers.set(next, { fn, at: now + Math.max(0, ms) }); return next; },
    clearTimeout(next) { timers.delete(next); },
    currentAttempt: (attempt) => attempt === context.streamAttempt,
    setBadge() {},
    showStreamNotice(...args) { notices.push(args); },
    failStreamAttempt(...args) { errors.push(args); },
  });
  vm.runInContext(clearTimers + "\n" + watchdog, context);
  function advance(ms) {
    const stopAt = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, item]) => item.at <= stopAt)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = stopAt;
  }
  return { context, errors, notices, advance, get pending() { return timers.size; } };
}

test("paused playback does not spend first-frame watchdog time or show a false error", () => {
  const f = fixture();
  f.context.startStreamWatchdog(1, "WebCodecs playback", { warnMs: 10000, failMs: 40000 });
  f.advance(3000);
  f.context.playbackPaused = true;
  f.context.suspendStreamWatchdog();
  f.advance(120000);
  assert.equal(f.errors.length, 0);
  assert.equal(f.notices.length, 0);
  assert.equal(f.pending, 0);
  f.context.playbackPaused = false;
  f.context.resumeStreamWatchdog();
  f.advance(6999);
  assert.equal(f.notices.length, 0);
  f.advance(1);
  assert.equal(f.notices.length, 1);
  f.advance(29999);
  assert.equal(f.errors.length, 0);
  f.advance(1);
  assert.equal(f.errors.length, 1);
  assert.doesNotMatch(f.errors[0][2], /Lower quality/i);
});

test("pause close to deadline gets a resume grace window; completed frames cancel the watchdog", () => {
  const f = fixture();
  f.context.startStreamWatchdog(1, "WebCodecs playback", { warnMs: 10000, failMs: 40000 });
  f.advance(39500);
  f.context.playbackPaused = true;
  f.context.suspendStreamWatchdog();
  f.advance(60000);
  f.context.playbackPaused = false;
  f.context.resumeStreamWatchdog();
  f.advance(9999);
  assert.equal(f.errors.length, 0);
  f.context.clearStreamTimers(); // first picture rendered
  f.advance(60000);
  assert.equal(f.errors.length, 0);
});

test("stale or superseded loading attempts never show a watchdog failure", () => {
  const f = fixture();
  f.context.startStreamWatchdog(1, "WebCodecs playback", { warnMs: 10000, failMs: 40000 });
  f.context.streamAttempt = 2;
  f.advance(60000);
  assert.equal(f.errors.length, 0);
  f.context.startStreamWatchdog(2, "Buffered MJPEG", { warnMs: 10000, failMs: 40000 });
  f.context.clearStreamTimers();
  f.advance(60000);
  assert.equal(f.errors.length, 0);
});

test("the UI calls watchdog pause/resume hooks on WebCodecs and MJPEG user actions", () => {
  assert.match(app, /playbackPaused = true;\s*suspendStreamWatchdog\(\)/);
  assert.match(app, /playbackPaused = false;\s*resumeStreamWatchdog\(\)/);
  assert.match(app, /function startStreamWatchdog[\s\S]*?suspended: playbackPaused/);
});
