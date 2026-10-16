import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createApneThumbnailService, validApneThumbnailKey } from "../src/lib/apne-thumbnails.js";

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apne-thumbs-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "registered.mp4");
  await fs.writeFile(source, "safe local media fixture");
  return { root, source };
}

function fakeFfmpeg({ delay = 20, fail = false } = {}) {
  let calls = 0;
  let running = 0;
  let peak = 0;
  const spawnProcess = (_command, args) => {
    calls++;
    running++;
    peak = Math.max(peak, running);
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {
      if (proc.ended) return;
      proc.ended = true;
      running--;
      proc.emit("close", null, "SIGKILL");
    };
    setTimeout(async () => {
      if (proc.ended) return;
      if (!fail) {
        try { await fs.writeFile(args.at(-1), Buffer.alloc(500, 0xff)); }
        catch {}
      }
      if (proc.ended) return;
      proc.ended = true;
      running--;
      proc.emit("close", fail ? 1 : 0, null);
    }, delay);
    return proc;
  };
  return { spawnProcess, get calls() { return calls; }, get peak() { return peak; } };
}

async function awaitStatus(service, show, date, expected = "ready") {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await service.request(show, date);
    if (state.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected thumbnail state: " + expected);
}

test("APNE thumbnail keys permit only safe stable show IDs and genuine dates", () => {
  assert.equal(validApneThumbnailKey("dr-aarambhi", "2026-10-14"), true);
  for (const [show, date] of [
    ["../foo", "2026-10-14"], ["anupamaa/../", "2026-10-14"],
    ["Anupamaa", "2026-10-14"], ["anupamaa", "../../secret"],
    ["anupamaa", "2026-02-30"], ["anupamaa", "2026-00-15"],
  ]) assert.equal(validApneThumbnailKey(show, date), false);
});

test("saved MP4 thumbnail is generated once, cached and keyed without display name", async (t) => {
  const { root, source } = await temporary(t);
  const ff = fakeFfmpeg({ delay: 35 });
  const service = createApneThumbnailService({
    cacheDir: path.join(root, "cache"), resolveSaved: async () => ({ filePath: source }),
    spawnProcess: ff.spawnProcess, timeoutMs: 1000,
  });
  const requests = await Promise.all(Array.from({ length: 8 }, () => service.request("anupamaa", "2026-10-14")));
  assert.ok(requests.every((result) => result.status === "pending"));
  const ready = await awaitStatus(service, "anupamaa", "2026-10-14");
  assert.match(ready.file, /anupamaa\/2026-10-14-v1-[a-f0-9]{16}\.jpg$/);
  assert.equal(ff.calls, 1);
  assert.equal((await service.request("anupamaa", "2026-10-14")).file, ready.file);
  assert.equal(ff.calls, 1);
  await fs.utimes(source, new Date(1_700_000_000_000), new Date(Date.now() - 86400_000));
  assert.equal((await service.request("anupamaa", "2026-10-14")).status, "pending");
  const changed = await awaitStatus(service, "anupamaa", "2026-10-14");
  assert.notEqual(changed.file, ready.file);
  assert.equal(ff.calls, 2);
});

test("thumbnail generation is one-worker even for different episodes", async (t) => {
  const { root, source } = await temporary(t);
  const ff = fakeFfmpeg({ delay: 35 });
  const service = createApneThumbnailService({
    cacheDir: path.join(root, "cache"), resolveSaved: async () => ({ filePath: source }),
    spawnProcess: ff.spawnProcess,
  });
  await Promise.all(["2026-10-13", "2026-10-14", "2026-10-15"].map((date) => service.request("anupamaa", date)));
  await Promise.all(["2026-10-13", "2026-10-14", "2026-10-15"].map((date) => awaitStatus(service, "anupamaa", date)));
  assert.equal(ff.calls, 3);
  assert.equal(ff.peak, 1);
});

test("unregistered or missing files do not invoke ffmpeg", async (t) => {
  const { root } = await temporary(t);
  const ff = fakeFfmpeg();
  const service = createApneThumbnailService({
    cacheDir: path.join(root, "cache"), resolveSaved: async () => null,
    spawnProcess: ff.spawnProcess,
  });
  assert.equal((await service.request("anupamaa", "2026-10-14")).status, "missing");
  assert.equal((await service.request("../escape", "2026-10-14")).status, "invalid");
  assert.equal(ff.calls, 0);
});

test("ffmpeg failure imposes cooldown without a retry storm", async (t) => {
  const { root, source } = await temporary(t);
  const ff = fakeFfmpeg({ delay: 10, fail: true });
  const service = createApneThumbnailService({
    cacheDir: path.join(root, "cache"), resolveSaved: async () => ({ filePath: source }),
    spawnProcess: ff.spawnProcess, cooldownMs: 600_000,
  });
  assert.equal((await service.request("anupamaa", "2026-10-14")).status, "pending");
  assert.equal((await awaitStatus(service, "anupamaa", "2026-10-14", "cooldown")).status, "cooldown");
  assert.equal((await service.request("anupamaa", "2026-10-14")).status, "cooldown");
  assert.equal(ff.calls, 1);
});

test("hung ffmpeg worker is killed within timeout and cooled down", async (t) => {
  const { root, source } = await temporary(t);
  const ff = fakeFfmpeg({ delay: 200 });
  const service = createApneThumbnailService({
    cacheDir: path.join(root, "cache"), resolveSaved: async () => ({ filePath: source }),
    spawnProcess: ff.spawnProcess, timeoutMs: 20,
  });
  assert.equal((await service.request("anupamaa", "2026-10-14")).status, "pending");
  assert.equal((await awaitStatus(service, "anupamaa", "2026-10-14", "cooldown")).status, "cooldown");
  assert.equal(ff.calls, 1);
});

test("thumbnail endpoint enforces same signed access and registered saved sources", async () => {
  const server = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /app\.get\("\/apne\/thumb\/:showId\/:dateKey\.jpg", requireApneNativeAccess/);
  assert.match(server, /item\.meta\?\.apneShowId === showId && item\.meta\?\.apneEpisodeDate === dateKey/);
  assert.match(server, /return apneNativeSavedItem\(match\.id\)/);
});

test("symlinked cache subfolder cannot expose or overwrite outside files", async (t) => {
  const { root, source } = await temporary(t);
  const cacheDir = path.join(root, "cache");
  const outside = path.join(root, "outside");
  await fs.mkdir(cacheDir);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(cacheDir, "anupamaa"));
  const ff = fakeFfmpeg();
  const service = createApneThumbnailService({
    cacheDir, resolveSaved: async () => ({ filePath: source }),
    spawnProcess: ff.spawnProcess,
  });
  assert.equal((await service.request("anupamaa", "2026-10-14")).status, "pending");
  await awaitStatus(service, "anupamaa", "2026-10-14", "cooldown");
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(ff.calls, 0);
});

test("bounded queue rejects excess requests without running more workers", async (t) => {
  const { root, source } = await temporary(t);
  const ff = fakeFfmpeg({ delay: 50 });
  const service = createApneThumbnailService({
    cacheDir: path.join(root, "cache"), resolveSaved: async () => ({ filePath: source }),
    spawnProcess: ff.spawnProcess, maxPending: 1,
  });
  assert.equal((await service.request("anupamaa", "2026-10-11")).status, "pending");
  assert.equal((await service.request("anupamaa", "2026-10-12")).status, "pending");
  assert.equal((await service.request("anupamaa", "2026-10-13")).status, "busy");
  await awaitStatus(service, "anupamaa", "2026-10-11");
  await awaitStatus(service, "anupamaa", "2026-10-12");
  assert.equal(ff.peak, 1);
});
