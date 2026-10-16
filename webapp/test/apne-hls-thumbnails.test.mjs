import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  parseApnePreviewManifest, boundedApneAsset, fetchApnePreviewMedia,
  createApneLiveThumbnailService, jpegFromApnePreview,
} from "../src/lib/apne-hls-thumbnails.js";

const base = "https://cdn.justfingram.com/hls/test/playlist.m3u8";
const segment = (n) => "https://cdn.justfingram.com/hls/test/seg_000" + n + ".ts";
const keyUrl = "https://justfingram.com/hls_key.php?id=abcd1234";
const manifest = (extra = "") => [
  "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-MEDIA-SEQUENCE:0", extra,
  "#EXT-X-KEY:METHOD=AES-128,URI=\"" + keyUrl + "\",IV=0x00000000000000000000000000000000",
  ...Array.from({ length: 8 }, (_, i) => "#EXTINF:10,\n" + segment(i)),
].join("\n");

function response(body, url) {
  const r = new Response(body, { status: 200 });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "apne-hls-c-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakePreviewSpawn(image, { fail = false, delay = 10 } = {}) {
  let calls = 0;
  let peak = 0;
  let active = 0;
  return {
    get calls() { return calls; }, get peak() { return peak; },
    spawnProcess: (_bin, args) => {
      calls++; active++; peak = Math.max(active, peak);
      assert.ok(args.includes("pipe:0") && args.includes("pipe:1"));
      assert.ok(args.includes("-protocol_whitelist"));
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        if (!fail) child.stdout.emit("data", image);
        active--; child.emit("close", fail ? 1 : 0, null);
      }, delay);
      return child;
    },
  };
}

async function wait(service, show, date, expected, max = 120) {
  for (let i = 0; i < max; i++) {
    const result = await service.request(show, date);
    if (result.status === expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  assert.fail("Timed out waiting for " + expected);
}

test("Phase C parser uses only two later TS segments with narrowly scoped key", () => {
  const parsed = parseApnePreviewManifest(manifest(), base);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, segment(3));
  assert.equal(parsed[1].url, segment(4));
  assert.equal(parsed[0].key.url, keyUrl);
  assert.equal(parsed[0].key.iv.toString("hex"), "0".repeat(32));
});

test("Phase C manifest rejects SSRF, unsupported media and master playlists", () => {
  for (const html of [
    manifest().replace(keyUrl, "https://169.254.169.254/hls_key.php?id=secret"),
    manifest().replace(segment(3), "https://evil-cdn.justfingram.com.evil.test/seg.ts"),
    manifest("#EXT-X-MAP:URI=\"https://cdn.justfingram.com/init.mp4\""),
    manifest("#EXT-X-BYTERANGE:200@0"),
    manifest().replace("AES-128", "SAMPLE-AES"),
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=250000\n" + base,
    manifest().replace(segment(3), "file:///etc/passwd"),
  ]) assert.throws(() => parseApnePreviewManifest(html, base));
});

test("Phase C bounded fetch rejects redirects, oversized media and local targets", async () => {
  await assert.rejects(boundedApneAsset("http://127.0.0.1/test.ts", {
    referer: base, maxBytes: 1024, fetchImpl: async () => { throw Error("should not fetch"); },
  }));
  await assert.rejects(boundedApneAsset(segment(0), {
    referer: base, maxBytes: 10,
    fetchImpl: async () => response(Buffer.alloc(25), segment(0)),
  }), /budget|exceeds/);
  await assert.rejects(boundedApneAsset(segment(0), {
    referer: base, maxBytes: 500,
    fetchImpl: async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/" } }),
  }));
});

test("Phase C HLS fetch performs in-memory AES-128 decrypt with bounded requests", async () => {
  const key = crypto.randomBytes(16);
  const clear = Buffer.alloc(188 * 6, 0x47);
  const encrypted = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
  const bytes = Buffer.concat([encrypted.update(clear), encrypted.final()]);
  const urls = [];
  const media = await fetchApnePreviewMedia({
    hlsUrl: base, referer: "https://justfingram.com/play.php?id=x",
  }, {
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === base) return response(manifest(), url);
      if (url === keyUrl) return response(key, url);
      if (url === segment(3) || url === segment(4)) return response(bytes, url);
      throw Error("Unexpected remote fetch");
    },
  });
  assert.equal(urls.length, 4);
  assert.equal(media.length, clear.length * 2);
  assert.deepEqual(media, Buffer.concat([clear, clear]));
});

test("Phase C JPEG accepts a real JPEG signature and ffmpeg is pipe-only", async () => {
  const jpeg = Buffer.concat([Buffer.from([255,216,255,224]), Buffer.alloc(280), Buffer.from([255,217])]);
  const ff = fakePreviewSpawn(jpeg);
  const result = await jpegFromApnePreview(Buffer.alloc(1000, 0x47), { spawnProcess: ff.spawnProcess });
  assert.deepEqual(result, jpeg);
  assert.equal(ff.calls, 1);
});

test("Phase C service caches and dedupes, survives display name changes", async (t) => {
  const dir = await tmp(t);
  const jpeg = Buffer.concat([Buffer.from([255,216]), Buffer.alloc(500), Buffer.from([255,217])]);
  const ff = fakePreviewSpawn(jpeg, { delay: 25 });
  let resolves = 0;
  const svc = createApneLiveThumbnailService({
    cacheDir: path.join(dir, "cache"), now: () => Date.parse("2026-10-14T17:00:00Z"),
    canPreview: async () => true,
    resolveEpisode: async () => { resolves++; return { hlsUrl: base, referer: base }; },
    fetchImpl: async (url) => {
      if (url === base) return response("#EXTM3U\n#EXTINF:10,\n" + segment(0), url);
      return response(Buffer.alloc(188 * 8), url);
    },
    spawnProcess: ff.spawnProcess,
  });
  const results = await Promise.all(Array.from({ length: 6 }, () => svc.request("anupamaa", "2026-10-14")));
  assert.ok(results.every((r) => r.status === "pending"));
  const result = await wait(svc, "anupamaa", "2026-10-14", "ready");
  assert.match(result.file, /anupamaa\/2026-10-14-v1\.jpg$/);
  assert.equal(ff.calls, 1);
  assert.equal(resolves, 1);
  assert.equal((await svc.request("anupamaa", "2026-10-14")).status, "ready");
});

test("Phase C request rejects invalid/old/unconfigured or saved episodes", async (t) => {
  const dir = await tmp(t);
  let attempted = 0;
  const svc = createApneLiveThumbnailService({
    cacheDir: dir, now: () => Date.parse("2026-10-14T17:00:00Z"),
    canPreview: async () => false,
    resolveEpisode: async () => { attempted++; return { hlsUrl: base }; },
  });
  for (const [show, date, expected] of [
    ["../etc", "2026-10-14", "invalid"], ["anupamaa", "2026-02-30", "invalid"],
    ["anupamaa", "2026-01-14", "missing"], ["anupamaa", "2026-10-14", "missing"],
  ]) assert.equal((await svc.request(show, date)).status, expected);
  assert.equal(attempted, 0);
});

test("Phase C failed HLS fetch cools down instead of repeatedly fetching", async (t) => {
  const dir = await tmp(t);
  let attempted = 0;
  const svc = createApneLiveThumbnailService({
    cacheDir: dir, now: () => Date.parse("2026-10-14T17:00:00Z"),
    canPreview: async () => true,
    resolveEpisode: async () => { attempted++; throw Error("upstream changed"); },
  });
  assert.equal((await svc.request("anupamaa", "2026-10-14")).status, "pending");
  assert.equal((await wait(svc, "anupamaa", "2026-10-14", "cooldown")).status, "cooldown");
  assert.equal(attempted, 1);
});

test("Phase C route requires signed Cloudflare Access", async () => {
  const server = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /app\.get\("\/apne\/live-thumb\/:showId\/:dateKey\.jpg", requireApneNativeAccess/);
  assert.match(server, /hasConfiguredApneShow\(showId\)/);
  assert.match(server, /!\(await apneThumbnailSavedEpisode\(showId, dateKey\)\)/);
  const ui = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(ui, /isSaved \? "\/apne\/thumb\/" : "\/apne\/live-thumb\/"/);
});

test("Phase C cache symlink guard prevents escaping preview directory", async (t) => {
  const dir = await tmp(t);
  const cacheDir = path.join(dir, "cache");
  const outside = path.join(dir, "outside");
  await fs.mkdir(cacheDir);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(cacheDir, "anupamaa"));
  let resolves = 0;
  const svc = createApneLiveThumbnailService({
    cacheDir, now: () => Date.parse("2026-10-14T17:00:00Z"),
    canPreview: async () => true,
    resolveEpisode: async () => { resolves++; return { hlsUrl: base, referer: base }; },
    fetchImpl: async (url) => url === base
      ? response("#EXTM3U\n#EXTINF:10,\n" + segment(0), url)
      : response(Buffer.alloc(188 * 8, 0x47), url),
    spawnProcess: fakePreviewSpawn(Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(400), Buffer.from([255, 217])])).spawnProcess,
  });
  assert.equal((await svc.request("anupamaa", "2026-10-14")).status, "pending");
  await wait(svc, "anupamaa", "2026-10-14", "cooldown");
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(resolves, 1);
});

test("Phase C queues stay bounded and only one decode executes", async (t) => {
  const dir = await tmp(t);
  const jpeg = Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(400), Buffer.from([255, 217])]);
  const ff = fakePreviewSpawn(jpeg, { delay: 45 });
  const svc = createApneLiveThumbnailService({
    cacheDir: dir, now: () => Date.parse("2026-10-14T17:00:00Z"), maxPending: 1,
    canPreview: async () => true,
    resolveEpisode: async () => ({ hlsUrl: base, referer: base }),
    fetchImpl: async (url) => url === base
      ? response("#EXTM3U\n#EXTINF:10,\n" + segment(0), url)
      : response(Buffer.alloc(188 * 8, 0x47), url),
    spawnProcess: ff.spawnProcess,
  });
  assert.equal((await svc.request("anupamaa", "2026-10-11")).status, "pending");
  assert.equal((await svc.request("anupamaa", "2026-10-12")).status, "pending");
  assert.equal((await svc.request("anupamaa", "2026-10-13")).status, "busy");
  await wait(svc, "anupamaa", "2026-10-11", "ready");
  await wait(svc, "anupamaa", "2026-10-12", "ready");
  assert.equal(ff.peak, 1);
});

test("Phase C ffmpeg shared gate serializes saved and live thumbnail decode", async () => {
  const { withApneThumbnailWorker } = await import("../src/lib/apne-thumbnails.js");
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 7 }, () => withApneThumbnailWorker(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active--;
  })));
  assert.equal(peak, 1);
});
