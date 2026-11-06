import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = app.match(/function isBlockedWebAudioStartup\(error\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(block, "audio startup classifier must remain available");
const isBlockedWebAudioStartup = vm.runInNewContext(block + "\nisBlockedWebAudioStartup");

test("recognizes Safari autoplay audio-blocking failures, not transport failures", () => {
  assert.equal(isBlockedWebAudioStartup(new Error("AudioContext resume timed out")), true);
  assert.equal(isBlockedWebAudioStartup(new Error("AudioContext did not enter running state")), true);
  assert.equal(isBlockedWebAudioStartup({name:"NotAllowedError",message:"The request is not allowed"}), true);
  for (const message of [
    "Network request failed", "Startup prebuffer timed out",
    "Audio ended before video continued", "AudioContext rebuffer resume failed",
    "AudioContext unavailable", "DASH failed: HTTP 500"
  ]) assert.equal(isBlockedWebAudioStartup(new Error(message)), false, message);
});

test("blocked Web Audio falls back once to MJPEG preserving position and pause without persisting preference", () => {
  const arm = app.match(/if \(isBlockedWebAudioStartup\(error\)[\s\S]*?\n          return;\n        \}/)?.[0] || "";
  assert.match(arm, /youtubePlaybackMethod === "webcodecs"/);
  assert.match(arm, /youtubePlaybackMethod = "mjpeg"/);
  assert.match(arm, /const fallbackAt = Math.max\(0, Number\(meta.startAt\) \|\| 0\)/);
  assert.match(arm, /pendingPlaybackMethodRestore = \{ minAttempt: attempt \+ 1, replay: replayFn \}/);
  assert.match(arm, /pendingWebAudioFallbackUrl = youtubeUrl/);
  assert.match(arm, /replayFn\(fallbackAt\)/);
  assert.match(arm, /finally \{\s*pendingWebAudioFallbackUrl = null/);
  assert.doesNotMatch(arm, /localStorage\.setItem/);
});

test("buffered MJPEG runs video without an interrupting autoplay audio dialog", () => {
  assert.match(app, /silentAudioAutoplayFallback = Boolean\([\s\S]*?pendingWebAudioFallbackUrl === youtubeUrl/);
  assert.match(app, /playBufferedMjpegStream\(\{ mjpegUrl, audioUrl \}, label, \{\s*\.\.\.meta, silentAudioAutoplayFallback/);
  assert.match(app, /if \(!meta.silentAudioAutoplayFallback\) \{\s*showStreamNotice\("warning", "Tap to start audio"/);
  assert.match(app, /player\.setAudioDisabled\(true, player\.currentTime\(\)\);\s*player\.setAudioReady\(true, \{ playable: false \}\)/);
  assert.match(app, /looseAudioSync: Boolean\(meta.silentAudioAutoplayFallback \|\| meta.looseAudioSync\)/);
  assert.match(html, /app\.js\?v=20261106-auto-start-high1/);
});

test("WebCodecs autoplay fallback invokes exactly one video-first replay", () => {
  const arm = app.match(/if \(isBlockedWebAudioStartup\(error\)[\s\S]*?\n          return;\n        \}/)?.[0] || "";
  const events = [];
  const ctx = {
    isBlockedWebAudioStartup,
    replayFn: (pos) => {
      events.push(["replay", pos, ctx.youtubePlaybackMethod, ctx.pendingWebAudioFallbackUrl]);
    },
    youtubePlaybackMethod: "webcodecs",
    youtubeUrl: "https://www.youtube.com/watch?v=fixture",
    pendingWebAudioFallbackUrl: null,
    playbackPaused: false,
    meta: {startAt: 73},
    attempt: 5,
    pendingPlaybackMethodRestore: null,
    renderYoutubePlaybackMethod: () => events.push(["render"]),
    reportPlaybackEvent: (name) => events.push(["event", name]),
  };
  const act = vm.runInNewContext("(function (error) {" + arm + "\n})", ctx);
  act({name:"Error", message:"AudioContext resume timed out"});
  assert.equal(ctx.youtubePlaybackMethod, "mjpeg");
  assert.equal(ctx.pendingWebAudioFallbackUrl, null);
  assert.deepEqual(JSON.parse(JSON.stringify(events.find(x=>x[0]==="replay"))),
    ["replay",73,"mjpeg",ctx.youtubeUrl]);
  assert.equal(events.filter(x=>x[0]==="replay").length, 1);
  events.length = 0;
  ctx.youtubePlaybackMethod = "webcodecs";
  ctx.playbackPaused = true;
  ctx.meta.startAt = 0;
  act(new Error("AudioContext did not enter running state"));
  assert.equal(ctx.pendingPlaybackMethodRestore.minAttempt, 6);
  assert.equal(ctx.pendingPlaybackMethodRestore.replay, ctx.replayFn);
  assert.equal(events.filter(x=>x[0]==="replay").length, 1);
});
