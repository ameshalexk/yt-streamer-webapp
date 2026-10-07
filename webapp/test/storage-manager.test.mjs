import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStorageManager } from "../src/lib/storage-manager.js";

async function fixture(t, { now = 2_000_000_000_000, failRemove = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-storage-manager-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    data: path.join(root, "data"), library: path.join(root, "library"),
    processed: path.join(root, "data", "processed-library"), cache: path.join(root, "data", "cache"),
    dash: path.join(root, "data", "processed-dash-cache"),
    cloud: path.join(root, "cloud-originals"),
  };
  await Promise.all(Object.values(paths).map((item) => fs.mkdir(item, { recursive: true })));
  const items = [{ id: "watched", title: "Watched episode" }, { id: "fresh", title: "Fresh" }, { id: "pinned", title: "Pinned" }];
  for (const item of items) {
    const dir = path.join(paths.processed, item.id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "video.mp4"), item.id);
    await fs.mkdir(path.join(paths.dash, item.id));
    await fs.writeFile(path.join(paths.dash, item.id, "chunk.m4s"), `cache-${item.id}`);
  }
  await fs.writeFile(path.join(paths.library, "raw.mp4"), "raw-library");
  await fs.writeFile(path.join(paths.cache, "prepared.bin"), "cache-data");
  await fs.writeFile(path.join(paths.cloud, "original.mp4"), "original");
  const deleted = [];
  const clock = { value: now };
  const manager = createStorageManager({
    dataDir: paths.data, libraryDir: paths.library, processedRoot: paths.processed, processedDashRoot: paths.dash,
    policyFile: path.join(paths.data, "storage-policy.json"), cacheRoots: [paths.cache],
    listDownloads: async () => items,
    removeDownload: async (id) => {
      if (failRemove) throw new Error("injected delete failure");
      deleted.push(id);
      await fs.rm(path.join(paths.processed, id), { recursive: true, force: true });
    },
    removeCache: async (id) => { deleted.push(`cache:${id}`); await fs.rm(path.join(paths.dash, id), { recursive: true, force: true }); }, now: () => clock.value,
  });
  return { manager, paths, deleted, now, setNow: (value) => { clock.value = value; } };
}

test("summary reports raw library, processed downloads, and cache bytes separately", async (t) => {
  const { manager } = await fixture(t);
  const result = await manager.summary();
  assert.equal(result.libraryBytes, Buffer.byteLength("raw-library") + Buffer.byteLength("watched") + Buffer.byteLength("fresh") + Buffer.byteLength("pinned"));
  assert.equal(result.cacheBytes, Buffer.byteLength("cache-data"));
  assert.ok(Number.isFinite(result.freeBytes));
  assert.ok(Number.isFinite(result.totalBytes));
  assert.deepEqual(result.downloads.map(({ id, pinned, watchedAt }) => ({ id, pinned, watchedAt })), [
    { id: "fresh", pinned: false, watchedAt: null }, { id: "pinned", pinned: false, watchedAt: null }, { id: "watched", pinned: false, watchedAt: null },
  ]);
});

test("policy defaults off, validates strictly, and pin/watched metadata persists", async (t) => {
  const { manager, paths, now } = await fixture(t);
  assert.deepEqual((await manager.summary()).policy, { enabled: false, watchedRetentionDays: 30 });
  await assert.rejects(manager.setPolicy({ enabled: 1 }), { status: 400 });
  await assert.rejects(manager.setPolicy({ typo: true }), { status: 400 });
  await assert.rejects(manager.setPolicy({ watchedRetentionDays: 0 }), { status: 400 });
  await assert.rejects(manager.setPinned("__proto__", true), { status: 400 });
  await assert.rejects(manager.setPinned("constructor", true), { status: 400 });
  await Promise.all([manager.setPinned("pinned", true), manager.markWatched("watched")]);
  await manager.setPolicy({ enabled: true, watchedRetentionDays: 12 });
  const saved = JSON.parse(await fs.readFile(path.join(paths.data, "storage-policy.json"), "utf8"));
  assert.equal(saved.enabled, true);
  assert.equal(saved.watchedRetentionDays, 12);
  assert.equal(saved.downloads.pinned.pinned, true);
  assert.equal(saved.downloads.watched.watchedAt, now);
  assert.equal((await manager.summary()).downloads.find((item) => item.id === "pinned").pinned, true);
  const restarted = createStorageManager({
    dataDir: paths.data, libraryDir: paths.library, processedRoot: paths.processed, processedDashRoot: paths.dash,
    cacheRoots: [], listDownloads: async () => [], removeDownload: async () => {}, removeCache: async () => {},
  });
  assert.deepEqual((await restarted.summary()).policy, { enabled: true, watchedRetentionDays: 12 });
});

test("preview and explicit cleanup remove only watched, expired, unpinned processed items", async (t) => {
  const { manager, paths, deleted, now, setNow } = await fixture(t);
  await manager.markWatched("watched");
  await manager.markWatched("pinned");
  await manager.setPinned("pinned", true);
  await manager.setPolicy({ enabled: true, watchedRetentionDays: 30 });
  const preview = await manager.cleanup({ apply: false });
  assert.deepEqual(preview.eligible.map((item) => item.id), []);
  // Advance the injected clock to simulate an episode older than the retention window.
  setNow(now + 31 * 86400000);
  const stale = await manager.cleanup({ apply: false });
  assert.deepEqual(stale.eligible.map((item) => item.id), ["watched"]);
  assert.equal(stale.eligible[0].cacheBytes, Buffer.byteLength("cache-watched"));
  await assert.rejects(manager.cleanup({ apply: true, ids: ["watched"] }, { busy: true }), { status: 409 });
  const applied = await manager.cleanup({ apply: true, ids: ["watched", "watched"] });
  assert.deepEqual(applied.removed.map((item) => item.id), ["watched"]);
  assert.equal(applied.reclaimedBytes, Buffer.byteLength("watched"));
  assert.equal(applied.reclaimedCacheBytes, Buffer.byteLength("cache-watched"));
  assert.deepEqual(deleted, ["watched", "cache:watched"]);
  await assert.rejects(fs.stat(path.join(paths.processed, "watched")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(paths.dash, "watched")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(paths.library, "raw.mp4"), "utf8"), "raw-library");
  assert.equal(await fs.readFile(path.join(paths.cloud, "original.mp4"), "utf8"), "original");
  assert.equal(await fs.readFile(path.join(paths.cache, "prepared.bin"), "utf8"), "cache-data");
});

test("cleanup rejects disabled apply, invalid IDs, and refuses symlinked item paths", async (t) => {
  const { manager, paths } = await fixture(t);
  await assert.rejects(manager.cleanup({ apply: true, ids: [] }), { status: 409 });
  await assert.rejects(manager.cleanup({ ids: ["../outside"] }), { status: 400 });
  await fs.rm(path.join(paths.processed, "fresh"), { recursive: true });
  await fs.symlink(paths.library, path.join(paths.processed, "fresh"));
  await assert.rejects(manager.markWatched("fresh"), { status: 404 });
  await manager.setPolicy({ enabled: true, watchedRetentionDays: 1 });
  assert.deepEqual((await manager.cleanup({ apply: false })).eligible, []);
  await assert.rejects(manager.cleanup({ apply: true, ids: Array(1001).fill("fresh") }), { status: 400 });
});

test("failed policy writes leave in-memory policy unchanged", async (t) => {
  const { manager, paths } = await fixture(t);
  await manager.summary();
  const policyFile = path.join(paths.data, "blocked-policy.json");
  const broken = createStorageManager({
    dataDir: paths.data, libraryDir: paths.library, processedRoot: paths.processed, processedDashRoot: paths.dash,
    policyFile, cacheRoots: [], listDownloads: async () => [],
    removeDownload: async () => {}, removeCache: async () => {},
  });
  await broken.summary();
  await fs.mkdir(policyFile);
  await assert.rejects(broken.setPolicy({ enabled: true }));
  assert.deepEqual((await broken.summary()).policy, { enabled: false, watchedRetentionDays: 30 });
});

test("corrupt policy reads can recover after the file is repaired", async (t) => {
  const { manager, paths } = await fixture(t);
  const policyFile = path.join(paths.data, "storage-policy.json");
  await fs.writeFile(policyFile, "{broken");
  await assert.rejects(manager.summary());
  await fs.writeFile(policyFile, JSON.stringify({ enabled: true, watchedRetentionDays: 7, downloads: {} }));
  assert.deepEqual((await manager.summary()).policy, { enabled: true, watchedRetentionDays: 7 });
});
