import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

await import("../public/buffered-mjpeg.js");
const { BufferedMjpegPlayer } = globalThis.BufferedMjpeg;

function fakeCanvas() {
  return {
    width: 1,
    height: 1,
    getContext() { return { drawImage() {}, clearRect() {} }; },
  };
}

function fakeAudio() {
  return {
    currentTime: 1,
    paused: false,
    muted: false,
    addEventListener() {},
    removeEventListener() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
}

test("renderer catch-up drops obsolete frames without pausing the audio master clock", () => {
  const audio = fakeAudio();
  const player = new BufferedMjpegPlayer({
    url: "/fixture",
    canvas: fakeCanvas(),
    audio,
    fps: 8,
    sessionId: 77,
    isCurrent: (id) => id === 77,
    audioEnabled: () => true,
  });
  player.audioReady = true;
  for (let i = 0; i < 8; i += 1) {
    player.queue.push({
      index: i,
      time: i / 8,
      size: 10,
      bytes: new Uint8Array([1]),
      blob: null,
      decoded: null,
      decodePromise: null,
      released: false,
    });
  }
  const dropped = player._dropStaleFrames(1);
  assert.ok(dropped >= 5);
  assert.equal(player.stats.droppedFrames, dropped);
  assert.equal(audio.paused, false);
  assert.ok(player.queue.peek().time >= 0.75);
  player.destroy();
});

test("startup preview and latency telemetry are explicit player milestones", () => {
  const source = fs.readFileSync(new URL("../public/buffered-mjpeg.js", import.meta.url), "utf8");
  assert.match(source, /_renderStartupPreview\(frame\)/);
  assert.match(source, /firstPictureMs/);
  assert.match(source, /firstFrameReceivedMs/);
  assert.match(source, /bufferReadyMs/);
  assert.match(source, /serverResolveMs/);
  assert.match(source, /receiveBytesPerSecond/);
  assert.match(source, /averageDecodeMs/);
});

test("YouTube video and audio requests share one short-lived resolver result", () => {
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /YOUTUBE_RESOLVE_CACHE_TTL_MS = 90 \* 1000/);
  assert.match(server, /resolveCache: "shared"/);
  assert.match(server, /resolveCache: "hit"/);
  assert.match(server, /X-YT-Resolve-Cache/);
});

test("YouTube metadata no longer blocks the initial stream request", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /refreshYoutubeMetadataInBackground/);
  assert.match(app, /void api\.get\(\x60\/api\/youtube\/info/);
  assert.match(app, /startupTrace: trace/);
  assert.match(app, /Preview ready · buffering for smooth playback/);
});

test("slowdown feedback distinguishes renderer and network pressure", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /kind: "renderer"/);
  assert.match(app, /kind: "network"/);
  assert.match(app, /reason === "audio"/);
  assert.match(app, /SLOW_BUFFER_SYNC_SUGGEST_MS = 4000/);
});
