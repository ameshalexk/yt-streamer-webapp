import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

await import("../public/buffered-mjpeg.js");

const { BufferedMjpegPlayer } = globalThis.BufferedMjpeg;
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("buffered pause keeps the original seek timeline base", () => {
  const body = app.match(/function pausePlayback\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(body, /const bufferedPauseActive =/);
  assert.match(body, /if \(bufferedPauseActive\) \{[\s\S]*bufferedPlayer\.pauseUser\(\)/);
  assert.match(body, /if \(restartableMjpegPause\) streamSeek\.startAt = pausedResumeAt/);
  assert.doesNotMatch(body, /if \(streamSeek\.seekable[^\n]*\{\s*streamSeek\.startAt = pausedResumeAt/);
});

test("paused buffered playback reports how much video remains buffered", () => {
  assert.match(app, /Ⅱ PAUSED · " \+ stats\.queueSeconds\.toFixed\(1\) \+ "s buf"/);
  assert.match(app, /detail\.reason === "audio" \|\| detail\.reason === "resume"/);
});

test("user pause and resume do not count as a network rebuffer", async () => {
  const canvas = {
    width: 1,
    height: 1,
    getContext() { return { drawImage() {}, clearRect() {} }; },
  };
  const states = [];
  const player = new BufferedMjpegPlayer({
    url: "/fixture",
    canvas,
    fps: 4,
    sessionId: 77,
    isCurrent: (id) => id === 77,
    audioEnabled: () => false,
    startupSeconds: 1,
    rebufferSeconds: 0.5,
    maxQueueSeconds: 4,
    onState: (state) => states.push(state),
  });

  player._predecode = () => {};
  player._scheduleRender = () => {};
  player.playbackStarted = true;
  player.playing = true;
  player.buffering = false;
  player.lastRenderedTime = 5;
  player.monotonicAnchor = { media: 5, perf: performance.now() };

  for (let i = 0; i < 4; i += 1) {
    player.queue.push({ index: i, time: 5 + (i / 4), size: 1, released: false });
  }

  player.pauseUser();
  assert.equal(player.userPaused, true);
  assert.equal(player.getStats().rebufferCount, 0);
  assert.equal(player.getStats().state, "paused");

  player.resumeUser();
  await Promise.resolve();
  assert.equal(player.userPaused, false);
  assert.equal(player.playing, true);
  assert.equal(player.getStats().rebufferCount, 0);
  assert.equal(player.getStats().state, "playing");
  assert.deepEqual(states.slice(-2), ["paused", "playing"]);
  player.destroy();
});
