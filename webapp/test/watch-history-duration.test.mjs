import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("watch history preserves known duration when replay metadata is incomplete", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-history-duration-"));
  const { config } = await import("../src/config.js");
  const original = { dataDir: config.dataDir, libraryDir: config.libraryDir };
  config.dataDir = dir;
  config.libraryDir = path.join(dir, "library");
  t.after(async () => {
    Object.assign(config, original);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { recordWatchHistory, listWatchHistory } = await import("../src/lib/store.js");
  const entry = { youtubeId: "test-video", duration: 123 };
  await recordWatchHistory(entry);
  const incomplete = [undefined, null, "", "  ", "unknown", -1, "-1", NaN, Infinity, "Infinity", false, true, [], [42], {}];
  for (const duration of incomplete) {
    const replay = await recordWatchHistory({ ...entry, duration });
    assert.equal(replay.duration, 123, `preserve duration for ${JSON.stringify(duration)}`);
  }
  assert.equal((await listWatchHistory()).length, 1);
  assert.equal((await recordWatchHistory({ ...entry, duration: "125.5" })).duration, 125.5);
  assert.equal((await recordWatchHistory({ ...entry, duration: 0 })).duration, 0);
  assert.equal((await recordWatchHistory({ ...entry, duration: null })).duration, 0);
  assert.equal((await recordWatchHistory({ youtubeId: "unknown-video", duration: null })).duration, null);
  for (const duration of incomplete) {
    assert.equal((await recordWatchHistory({ youtubeId: "unknown-video", duration })).duration, null);
  }
  await recordWatchHistory({ youtubeId: "persisted-video", duration: 125.5 });
  await recordWatchHistory({ youtubeId: "persisted-video", duration: null });
  const saved = JSON.parse(await fs.readFile(path.join(dir, "store.json"), "utf8"));
  assert.equal(saved.watchHistory.find((item) => item.youtubeId === entry.youtubeId).duration, 0);
  assert.equal(saved.watchHistory.find((item) => item.youtubeId === "persisted-video").duration, 125.5);
  const reloadedStore = await import("../src/lib/store.js?duration-reload");
  const reloaded = await reloadedStore.listWatchHistory();
  assert.equal(reloaded.find((item) => item.youtubeId === "persisted-video").duration, 125.5);
  assert.equal(reloaded.find((item) => item.youtubeId === entry.youtubeId).duration, 0);
});
