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
    beginNewPlaybackQuality() {},
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


test("resume lookup restores persisted progress outside History without wiping it", async () => {
  const { resumePosition } = loadModule();
  const history = [{
    id: "video",
    youtubeId: "video",
    url: "https://www.youtube.com/watch?v=video",
    positionSeconds: 42,
    duration: 100,
    completed: false,
  }];
  const context = vm.createContext({
    window: { WatchProgress: { resumePosition } },
    state: { youtubeHistoryLoaded: false, youtubeHistory: [] },
    api: { get: async () => history },
    URL,
    Date,
    console,
  });
  const start = app.indexOf("function youtubeIdFromUrl(");
  const end = app.indexOf("\nconst watchProgress", start);
  vm.runInContext(app.slice(start, end), context);

  const partial = await context.watchResumePlan({
    id: "video",
    url: "https://youtu.be/video",
  });
  assert.equal(partial.position, 42);
  assert.equal(partial.restartProgress, false);

  history[0] = { ...history[0], positionSeconds: 99, completed: true };
  const completed = await context.watchResumePlan({
    id: "video",
    url: "https://www.youtube.com/watch?v=video",
  });
  assert.equal(completed.position, 0);
  assert.equal(completed.restartProgress, true);

  context.api.get = async () => { throw new Error("offline"); };
  const failed = await context.watchResumePlan({
    id: "other",
    url: "https://www.youtube.com/watch?v=other",
  });
  assert.equal(failed.position, 0);
  assert.equal(failed.restartProgress, false);
});

test("reopening a YouTube search result starts at its saved timestamp", async () => {
  const calls = [];
  const records = [];
  const context = vm.createContext({
    state: {
      youtubeSearchPlayingId: null,
      youtubeHistoryPlayingId: null,
      playingItemId: null,
      legacyPlayingId: null,
      recommendedPlayingId: null,
      youtubeSearchResults: [],
    },
    watchProgress: { stop() {} },
    beginNewPlaybackQuality() {},
    watchResumePlan: async () => ({ position: 42, restartProgress: false }),
    beginPlaybackStartupTrace: () => ({}),
    refreshYoutubeMetadataInBackground() {},
    renderItems() {}, renderLegacyLibrary() {}, renderRecommendations() {},
    renderYoutubeSearch() {}, renderYoutubeHistory() {}, showAttemptedUrl() {},
    isMobileMode: () => false,
    watchHistoryKey: item => item.id,
    recordWatchHistory: (...args) => records.push(args),
    playStream: (_sources, _label, meta) => calls.push(meta),
    streamQuery: time => `timestamp=${time}`,
    audioQuery: time => `timestamp=${time}`,
    encodeURIComponent,
  });
  const start = app.indexOf("async function streamYoutubeSearchResult(");
  const end = app.indexOf("\nasync function streamYoutubeHistoryItem", start);
  vm.runInContext(app.slice(start, end), context);

  const item = { id: "video", url: "https://www.youtube.com/watch?v=video", duration: 100 };
  await context.streamYoutubeSearchResult(item);
  assert.equal(calls[0].startAt, 42);
  assert.equal(records[0][2].restartProgress, false);
});

test("History refresh failure clears the loaded flag so navigation can retry", async () => {
  const state = {
    youtubeHistory: [{ id: "old" }], youtubeHistoryLoaded: true,
    youtubeHistoryLoading: false, youtubeHistoryError: "",
  };
  let requests = 0;
  const renders = [];
  const context = vm.createContext({
    state,
    Date,
    api: { get: async () => {
      requests += 1;
      if (requests === 1) throw new Error("temporary offline");
      return [{ id: "recovered" }];
    } },
    renderYoutubeHistory: () => renders.push(state.youtubeHistoryLoaded),
    toast: () => {},
  });
  const start = app.indexOf("async function loadYoutubeHistory()");
  const end = app.indexOf("\nasync function performYoutubeSearch", start);
  assert.ok(start > -1 && end > start);
  vm.runInContext(app.slice(start, end), context);

  await context.loadYoutubeHistory();
  assert.equal(state.youtubeHistoryLoaded, false, "failed refresh must become eligible for retry");
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(state.youtubeHistoryError, "temporary offline");
  await context.loadYoutubeHistory();
  assert.equal(requests, 2);
  assert.equal(state.youtubeHistoryLoaded, true);
  assert.equal(state.youtubeHistoryError, "");
  assert.equal(state.youtubeHistory[0].id, "recovered");
  assert.equal(renders.at(-1), true);
});

test("history mutation waits for an in-flight record, removes its row, and permits replay", async () => {
  const { Tracker } = loadModule();
  const rows = new Set();
  const events = [];
  const saved = [];
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const tracker = new Tracker({
    record: async payload => {
      events.push("record-start");
      started();
      await gate;
      rows.add(payload.youtubeId);
      events.push("record-finish");
      return { id: payload.youtubeId, ...payload };
    },
    update: async (id, payload) => ({ id, ...payload }),
    capture: () => ({ positionSeconds: 10, duration: 100 }),
    onSaved: entry => saved.push(entry),
  });
  const begin = tracker.begin({ youtubeId: "deleted" });
  await startedPromise;
  const mutation = tracker.runHistoryMutation(async () => {
    events.push("delete");
    rows.delete("deleted");
    return "deleted";
  }, { deletedEntry: { id: "deleted", youtubeId: "deleted" } });
  release();
  await Promise.all([begin, mutation]);
  assert.deepEqual(events, ["record-start", "record-finish", "delete"]);
  assert.deepEqual(Array.from(rows), [], "the in-flight POST is removed after it settles");
  assert.equal(saved.length, 1, "the pre-delete callback runs before deletion");
  assert.equal(tracker.session, null, "deleting the active entry stops its stale tracker session");

  await tracker.begin({ youtubeId: "deleted" });
  assert.deepEqual(Array.from(rows), ["deleted"], "explicit replay after deletion remains allowed");
  assert.equal(saved.length, 2);
});


test("history mutation orders a queued begin before delete and then allows replay", async () => {
  const { Tracker } = loadModule();
  const records = [];
  const rows = new Set();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tracker = new Tracker({
    record: async payload => {
      records.push(payload.youtubeId);
      rows.add(payload.youtubeId);
      return { id: payload.youtubeId, ...payload };
    },
    update: async () => null, capture: () => null,
  });
  tracker.enqueue(() => gate);
  const pendingBegin = tracker.begin({ youtubeId: "deleted" });
  const mutation = tracker.runHistoryMutation(async () => {
    rows.delete("deleted");
    return "deleted";
  }, { deletedEntry: { id: "deleted", youtubeId: "deleted" } });
  release();
  await Promise.all([pendingBegin, mutation]);
  assert.deepEqual(records, ["deleted"]);
  assert.deepEqual(Array.from(rows), [], "the queued POST settles before deletion");
  await tracker.begin({ youtubeId: "deleted" });
  assert.deepEqual(records, ["deleted", "deleted"], "a later explicit replay is recorded");
  assert.deepEqual(Array.from(rows), ["deleted"]);
});

test("deleting a different history item keeps the active playback session", async () => {
  const { Tracker } = loadModule();
  const saved = [];
  let updates = 0;
  const tracker = new Tracker({
    record: async payload => ({ id: payload.youtubeId, ...payload }),
    update: async (id, payload) => { updates++; return { id, ...payload }; },
    capture: () => ({ positionSeconds: 10, duration: 100 }),
    onSaved: entry => saved.push(entry),
  });
  await tracker.begin({ youtubeId: "keep-playing" });
  const currentSession = tracker.session;
  await tracker.runHistoryMutation(async () => "deleted", { deletedEntry: { id: "other-video" } });
  assert.equal(tracker.session, currentSession);
  await tracker.save();
  assert.equal(updates, 1);
  assert.equal(saved.at(-1).id, "keep-playing");
});

test("clear invalidates the active session and a failed mutation preserves queued replay", async () => {
  const { Tracker } = loadModule();
  const saved = [];
  const records = [];
  let rejectMutation;
  const gate = new Promise((resolve, reject) => { rejectMutation = reject; });
  const tracker = new Tracker({
    record: async payload => { records.push(payload.youtubeId); return { id: payload.youtubeId, ...payload }; },
    update: async (id, payload) => ({ id, ...payload }),
    capture: () => ({ positionSeconds: 10, duration: 100 }),
    onSaved: entry => saved.push(entry),
  });
  await tracker.begin({ youtubeId: "clear-me" });
  await tracker.runHistoryMutation(async () => "cleared", { clearAll: true });
  assert.equal(tracker.session, null, "successful Clear stops the deleted active session");

  await tracker.begin({ youtubeId: "still-active" });
  const mutation = tracker.runHistoryMutation(() => gate, { deletedEntry: { id: "still-active" } });
  const replay = tracker.begin({ youtubeId: "new-replay" });
  rejectMutation(new Error("delete failed"));
  await assert.rejects(
    mutation,
    /delete failed/,
  );
  await replay;
  assert.deepEqual(records, ["clear-me", "still-active", "new-replay"]);
  assert.equal(saved.at(-1).id, "new-replay", "a replay queued during a failed mutation remains visible");
});

test("failed history deletion keeps active session and queued progress writes", async () => {
  const { Tracker } = loadModule();
  const updates = [];
  const errors = [];
  const tracker = new Tracker({
    record: async payload => ({ id: payload.youtubeId, ...payload }),
    update: async (id, payload) => { updates.push({ id, ...payload }); return { id, ...payload }; },
    capture: () => ({ positionSeconds: 23, duration: 100 }),
    onError: error => errors.push(error.message),
  });
  await tracker.begin({ youtubeId: "keep-on-failure" });
  const session = tracker.session;
  const deletion = tracker.runHistoryMutation(async () => { throw new Error("delete unavailable"); },
    { deletedEntry: { id: "keep-on-failure" } });
  const save = tracker.save();
  await assert.rejects(deletion, /delete unavailable/);
  await save;
  assert.equal(tracker.session, session);
  assert.equal(session.historyInvalidated, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].positionSeconds, 23);
  assert.deepEqual(errors, ["delete unavailable"]);
});

test("overlapping Remove and Clear serialize around replay without losing the final session", async () => {
  const { Tracker } = loadModule();
  const rows = new Set();
  const events = [];
  let releaseRemove;
  let removeStarted;
  const started = new Promise(resolve => { removeStarted = resolve; });
  const removeGate = new Promise(resolve => { releaseRemove = resolve; });
  const tracker = new Tracker({
    record: async payload => {
      rows.add(payload.youtubeId);
      events.push(`record:${payload.youtubeId}`);
      return { id: payload.youtubeId, ...payload };
    },
    update: async (id, payload) => ({ id, ...payload }),
    capture: () => ({ positionSeconds: 7, duration: 100 }),
  });
  await tracker.begin({ youtubeId: "first" });
  const remove = tracker.runHistoryMutation(async () => {
    removeStarted();
    await removeGate;
    rows.delete("first");
    events.push("remove:first");
  }, { deletedEntry: { id: "first" } });
  await started;
  const replay = tracker.begin({ youtubeId: "second" });
  const clear = tracker.runHistoryMutation(async () => {
    rows.clear();
    events.push("clear");
  }, { clearAll: true });
  const finalReplay = tracker.begin({ youtubeId: "third" });
  releaseRemove();
  await Promise.all([remove, replay, clear, finalReplay]);
  assert.deepEqual(events, [
    "record:first", "remove:first", "record:second", "clear", "record:third",
  ]);
  assert.deepEqual([...rows], ["third"]);
  assert.equal(tracker.session?.entry?.id, "third");
  await tracker.save();
  assert.deepEqual([...rows], ["third"], "later progress cannot recreate cleared entries");
});

test("rejected Remove followed by same-video replay preserves the new session and queue", async () => {
  const { Tracker } = loadModule();
  const events = [];
  const errors = [];
  let rejectRemove;
  let removeStarted;
  const started = new Promise(resolve => { removeStarted = resolve; });
  const pendingRemove = new Promise((_resolve, reject) => { rejectRemove = reject; });
  const tracker = new Tracker({
    record: async payload => {
      events.push(`record:${payload.youtubeId}`);
      return { id: payload.youtubeId, ...payload };
    },
    update: async (id, payload) => {
      events.push(`update:${id}`);
      return { id, ...payload };
    },
    capture: () => ({ positionSeconds: 12, duration: 100 }),
    onError: error => errors.push(error.message),
  });
  await tracker.begin({ youtubeId: "same-video" });
  const original = tracker.session;
  const remove = tracker.runHistoryMutation(async () => {
    removeStarted();
    return pendingRemove;
  }, { deletedEntry: { id: "same-video" } });
  await started;
  const replay = tracker.begin({ youtubeId: "same-video" });
  rejectRemove(new Error("remove rejected"));
  await assert.rejects(remove, /remove rejected/);
  await replay;
  await tracker.save();
  assert.notEqual(tracker.session, original);
  assert.equal(tracker.session?.historyInvalidated, false);
  assert.equal(tracker.session?.entry?.id, "same-video");
  assert.deepEqual(events, [
    "record:same-video", "update:same-video", "record:same-video", "update:same-video",
  ]);
  assert.deepEqual(errors, ["remove rejected"]);
});
