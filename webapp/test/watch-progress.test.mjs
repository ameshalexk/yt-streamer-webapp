import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("watch progress is session-scoped, monotonic, persisted, and does not replay history", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-watch-progress-"));
  const { config } = await import("../src/config.js");
  const original = { dataDir: config.dataDir, libraryDir: config.libraryDir };
  config.dataDir = dir;
  config.libraryDir = path.join(dir, "library");
  t.after(async () => { Object.assign(config, original); await fs.rm(dir, { recursive: true, force: true }); });
  const store = await import("../src/lib/store.js");
  const first = await store.recordWatchHistory({ youtubeId: "continue-video", duration: 100, playbackSessionId: "session-one" });
  await store.updateWatchProgress(first.id, { playbackSessionId: "session-one", sequence: 0, positionSeconds: 50 });
  await assert.rejects(store.updateWatchProgress(first.id, { playbackSessionId: "old-session", sequence: 1, positionSeconds: 1 }), { status: 409 });
  await assert.rejects(store.updateWatchProgress(first.id, { playbackSessionId: "session-one", sequence: 0, positionSeconds: 1 }), { status: 409 });
  const seekBack = await store.updateWatchProgress(first.id, { playbackSessionId: "session-one", sequence: 1, positionSeconds: 12 });
  assert.equal(seekBack.positionSeconds, 12);
  assert.equal(seekBack.progressSequence, 1);
  await store.updateWatchProgress(first.id, { playbackSessionId: "session-one", sequence: 2, positionSeconds: 20, duration: 50 });
  const clamped = await store.updateWatchProgress(first.id, { playbackSessionId: "session-one", sequence: 3, positionSeconds: 80 });
  assert.equal(clamped.positionSeconds, 50);
  assert.equal(clamped.completed, true);
  const beforeReplay = { ...clamped };
  const replay = await store.recordWatchHistory({ youtubeId: "continue-video", title: "metadata replay" });
  assert.equal(replay.positionSeconds, beforeReplay.positionSeconds);
  assert.equal(replay.completed, beforeReplay.completed);
  assert.equal(replay.playbackSessionId, "session-one");
  assert.equal(replay.progressSequence, 3);
  assert.equal(replay.playCount, beforeReplay.playCount + 1);
  const next = await store.recordWatchHistory({ youtubeId: "continue-video", playbackSessionId: "session-two" });
  assert.equal(next.positionSeconds, 50);
  assert.equal(next.completed, true);
  assert.equal(next.progressSequence, -1);
  assert.equal(next.playbackSessionId, "session-two");
  const raw = JSON.parse(await fs.readFile(path.join(dir, "store.json"), "utf8"));
  assert.equal(raw.watchHistory[0].positionSeconds, 50);
  const freshStore = await import(`../src/lib/store.js?progress-reload=${Date.now()}`);
  const reloaded = await freshStore.listWatchHistory();
  assert.equal(reloaded[0].progressSequence, -1);
  assert.equal(reloaded[0].playbackSessionId, "session-two");
  const restarted = await store.recordWatchHistory({ youtubeId: "continue-video", playbackSessionId: "restart-session", restartProgress: true });
  assert.equal(restarted.positionSeconds, 0);
  assert.equal(restarted.completed, false);
  const restartDisk = JSON.parse(await fs.readFile(path.join(dir, "store.json"), "utf8"));
  assert.equal(restartDisk.watchHistory[0].positionSeconds, 0);
  assert.equal(restartDisk.watchHistory[0].completed, false);
});

test("watch progress validates sessions, values, live media, and completion thresholds", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-watch-progress-invalid-"));
  const { config } = await import("../src/config.js");
  const original = { dataDir: config.dataDir, libraryDir: config.libraryDir };
  config.dataDir = dir;
  config.libraryDir = path.join(dir, "library");
  t.after(async () => { Object.assign(config, original); await fs.rm(dir, { recursive: true, force: true }); });
  const store = await import(`../src/lib/store.js?invalid-suite=${Date.now()}`);
  for (const playbackSessionId of ["", "   ", "x".repeat(129), 3, null]) {
    await assert.rejects(store.recordWatchHistory({ youtubeId: `invalid-${String(playbackSessionId)}`, playbackSessionId }), { status: 400 });
  }
  const entry = await store.recordWatchHistory({ youtubeId: "threshold-video", duration: 100, playbackSessionId: "valid" });
  for (const playbackSessionId of [undefined, null, "", "   ", 3, "x".repeat(129)]) {
    await assert.rejects(store.updateWatchProgress(entry.id, { playbackSessionId, sequence: 0, positionSeconds: 1 }), { status: 400 });
  }
  for (const positionSeconds of [-1, NaN, Infinity, "4", null]) {
    await assert.rejects(store.updateWatchProgress(entry.id, { playbackSessionId: "valid", sequence: 0, positionSeconds }), { status: 400 });
  }
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    await assert.rejects(store.updateWatchProgress(entry.id, { playbackSessionId: "valid", sequence, positionSeconds: 1 }), { status: 409 });
  }
  await assert.rejects(store.updateWatchProgress("missing", { playbackSessionId: "valid", sequence: 0, positionSeconds: 1 }), { status: 404 });
  await assert.rejects(store.updateWatchProgress(entry.id, { playbackSessionId: "valid", sequence: 0, positionSeconds: 1, duration: 0 }), { status: 400 });
  await assert.rejects(store.updateWatchProgress(entry.id, { playbackSessionId: "valid", sequence: 0, positionSeconds: 1, isLive: true }), { status: 400 });
  assert.equal((await store.updateWatchProgress(entry.id, { playbackSessionId: "valid", sequence: 0, positionSeconds: 95 })).completed, true);
  const nearEnd = await store.recordWatchHistory({ youtubeId: "near-end-video", duration: 20, playbackSessionId: "near-end" });
  assert.equal((await store.updateWatchProgress(nearEnd.id, { playbackSessionId: "near-end", sequence: 0, positionSeconds: 15 })).completed, true);
  const short = await store.recordWatchHistory({ youtubeId: "short-video", duration: 10, playbackSessionId: "short" });
  assert.equal((await store.updateWatchProgress(short.id, { playbackSessionId: "short", sequence: 0, positionSeconds: 9.7 })).completed, false);
  const unknownDuration = await store.recordWatchHistory({ youtubeId: "unknown-duration", playbackSessionId: "unknown" });
  const withoutDuration = await store.updateWatchProgress(unknownDuration.id, { playbackSessionId: "unknown", sequence: 0, positionSeconds: 25 });
  assert.equal(withoutDuration.positionSeconds, 25);
  assert.equal(withoutDuration.completed, false);
  const live = await store.recordWatchHistory({ youtubeId: "live-video", isLive: true, playbackSessionId: "live" });
  await assert.rejects(store.updateWatchProgress(live.id, { playbackSessionId: "live", sequence: 0, positionSeconds: 1 }), { status: 400 });
});
