import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const moduleSource = await fs.readFile(new URL("../public/watch-progress.js", import.meta.url), "utf8");
const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
function loadModule() {
  const context = vm.createContext({ Date, Math, crypto: { randomUUID: () => Math.random().toString() } });
  vm.runInContext(moduleSource, context);
  return context.WatchProgress;
}

test("resume position handles missing metadata, completed videos, and live sources", () => {
  const { resumePosition } = loadModule();
  assert.equal(resumePosition({ positionSeconds: 42, duration: 100 }), 42);
  assert.equal(resumePosition({ positionSeconds: 42 }), 42);
  for (const item of [
    { positionSeconds: 42, completed: true }, { positionSeconds: 42, isLive: true },
    { positionSeconds: -1 }, { positionSeconds: Infinity }, { positionSeconds: "42" },
    { positionSeconds: 95, duration: 100 }, { positionSeconds: 1000, duration: 100 }, {},
  ]) assert.equal(resumePosition(item), 0);
  assert.equal(resumePosition({ positionSeconds: 9.7, duration: 10 }), 9.7);
});

test("queued progress snapshots retain video/session identity across switching and backwards seeking", async () => {
  const { Tracker } = loadModule();
  const requests = [];
  const saved = [];
  let positionSeconds = 40;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tracker = new Tracker({
    record: async payload => {
      requests.push({ type: "record", ...payload });
      if (payload.youtubeId === "a") await gate;
      return { id: payload.youtubeId, ...payload };
    },
    update: async (id, payload, keepalive) => {
      requests.push({ type: "progress", id, ...payload, keepalive });
      return { id, ...payload };
    },
    capture: () => ({ positionSeconds, duration: 100, isLive: false }),
    onSaved: entry => saved.push(entry),
  });
  const first = tracker.begin({ youtubeId: "a" });
  tracker.save();
  positionSeconds = 12;
  tracker.save();
  tracker.stop();
  positionSeconds = 3;
  const second = tracker.begin({ youtubeId: "b" });
  tracker.save({ keepalive: true });
  release();
  await Promise.all([first, second, tracker.chain]);
  const a = requests.filter(request => request.type === "progress" && request.id === "a");
  assert.deepEqual(a.map(request => request.positionSeconds), [40, 12, 12]);
  assert.deepEqual(a.map(request => request.sequence), [0, 1, 2]);
  assert.equal(new Set(a.map(request => request.playbackSessionId)).size, 1);
  const b = requests.find(request => request.type === "progress" && request.id === "b");
  assert.equal(b.positionSeconds, 3);
  assert.equal(b.keepalive, true);
  assert.notEqual(b.playbackSessionId, a[0].playbackSessionId);
  assert.equal(saved.at(-1).id, "b");
  assert.equal(saved.findLast(entry => entry.id === "a").positionSeconds, 12);
});

test("startup/live snapshots are skipped and a failed save does not poison later requests", async () => {
  const { Tracker } = loadModule();
  let snapshot = null;
  let writes = 0;
  const errors = [];
  const tracker = new Tracker({
    record: async payload => ({ id: "video", ...payload }),
    update: async (_id, payload) => {
      if (++writes === 1) throw new Error("temporary failure");
      return payload;
    },
    capture: () => snapshot,
    onError: error => errors.push(error.message),
  });
  await tracker.begin({ youtubeId: "video" });
  await tracker.save();
  snapshot = { positionSeconds: 5, isLive: true };
  await tracker.save();
  assert.equal(writes, 0);
  snapshot = { positionSeconds: 5, isLive: false };
  await assert.rejects(tracker.save(), /temporary failure/);
  await tracker.save();
  assert.equal(writes, 2);
  assert.deepEqual(errors, ["temporary failure"]);
});

test("reopening History sends the same persisted timestamp to video and separate audio", async () => {
  const calls = [];
  const records = [];
  const context = vm.createContext({
    window: { WatchProgress: loadModule() }, state: {}, replayFn: null,
    watchProgress: { stop() {} },
    beginPlaybackStartupTrace: () => ({}), refreshYoutubeMetadataInBackground() {},
    renderItems() {}, renderLegacyLibrary() {}, renderRecommendations() {},
    renderYoutubeSearch() {}, renderYoutubeHistory() {}, showAttemptedUrl() {},
    isMobileMode: () => false, watchHistoryKey: item => item.id,
    recordWatchHistory: (...args) => records.push(args), playStream: (sources, _label, meta) => calls.push({ sources, meta }),
    streamQuery: time => `timestamp=${time}`, audioQuery: time => `timestamp=${time}`,
    encodeURIComponent,
  });
  const start = app.indexOf("async function streamYoutubeHistoryItem(");
  const end = app.indexOf("\nfunction recommendationMeta", start);
  vm.runInContext(app.slice(start, end), context);
  const item = { id: "video", url: "https://www.youtube.com/watch?v=video", duration: 100, positionSeconds: 42 };
  await context.streamYoutubeHistoryItem(item);
  assert.equal(calls[0].meta.startAt, 42);
  assert.equal(records[0][2].restartProgress, false);
  for (const url of Object.values(calls[0].sources)) {
    assert.equal(new URL(url, "http://localhost").searchParams.get("timestamp"), "42");
  }
  await context.streamYoutubeHistoryItem(item, { restart: true });
  assert.equal(calls[1].meta.startAt, 0);
  assert.equal(records[1][2].restartProgress, true);
  await context.streamYoutubeHistoryItem({ ...item, completed: true });
  assert.equal(calls[2].meta.startAt, 0);
  assert.equal(records[2][2].restartProgress, true);
});

test("runtime WebCodecs resumes through the shared timestamp and exposes its absolute playback clock", async () => {
  const calls = [];
  const context = vm.createContext({
    activeYoutubeSourceUrl: "", youtubePlaybackMethod: "webcodecs",
    playCyberdashStream: (url, label, meta) => calls.push({ url, label, meta }),
    streamSeek: { seekable: true, duration: 1000, startAt: 42 },
    cyberdashPlayer: { currentTime: () => 123 },
    activeCompat: null, legacy: { playing: false },
    clampStreamSeekTime: value => Math.max(0, Math.min(value, 1000)),
  });
  const start = app.indexOf("async function playStream(");
  const end = app.indexOf("\nfunction playNativeVideoStream", start);
  vm.runInContext(app.slice(start, end), context);
  const clockStart = app.indexOf("function getStreamCurrentTime(");
  const clockEnd = app.indexOf("\nfunction updateStreamSeekUi", clockStart);
  vm.runInContext(app.slice(clockStart, clockEnd), context);
  await context.playStream({ audioUrl: "/stream/audio/youtube?timestamp=42" }, "Video", {
    youtubeUrl: "https://youtu.be/video", startAt: 42, watchHistoryKey: "video", isLive: false,
  });
  assert.equal(calls[0].meta.startAt, 42);
  assert.equal(calls[0].meta.watchHistoryKey, "video");
  assert.equal(context.getStreamCurrentTime(), 123);
});
