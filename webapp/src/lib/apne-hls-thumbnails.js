// Phase C: bounded, on-demand previews for UNSAVED APNE HLS episodes.
// Never hand an upstream URL to ffmpeg: fetch only allowlisted HTTPS assets,
// decrypt at most two TS segments in memory and decode one JPEG via stdin.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { validatedApneLiveAsset } from "./apne-live-relay.js";
import { validApneThumbnailKey, withApneThumbnailWorker } from "./apne-thumbnails.js";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const VERSION = "v1";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SEGMENT_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 6 * 1024 * 1024;
const MAX_JPEG_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const FAILURE_COOLDOWN_MS = 15 * 60_000;

export function parseApnePreviewManifest(text, base) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_MANIFEST_BYTES ||
      !text.startsWith("#EXTM3U")) throw Error("Invalid HLS manifest");
  const segments = [];
  let sequence = 0;
  let currentKey = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF") || line.startsWith("#EXT-X-MAP") ||
        line.startsWith("#EXT-X-BYTERANGE") || line.startsWith("#EXT-X-SESSION-KEY"))
      throw Error("Unsupported HLS preview format");
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      if (segments.length || !/^#EXT-X-MEDIA-SEQUENCE:\d+$/.test(line)) throw Error("Invalid sequence");
      sequence = Number(line.split(":")[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw Error("Invalid sequence");
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const method = /(?:^|[:,])METHOD=([A-Z0-9-]+)/.exec(line)?.[1];
      if (method === "NONE") { currentKey = null; continue; }
      if (method !== "AES-128") throw Error("Unsupported encryption");
      const uri = /(?:^|[:,])URI="([^"]+)"/.exec(line)?.[1];
      const validated = uri && validatedApneLiveAsset(uri, base);
      if (!validated || validated.ext !== "key") throw Error("Untrusted HLS key");
      const iv = /(?:^|[:,])IV=0x([0-9A-Fa-f]+)/.exec(line)?.[1];
      if (iv && iv.length !== 32) throw Error("Invalid HLS IV");
      currentKey = { url: validated.url, iv: iv ? Buffer.from(iv, "hex") : null };
      continue;
    }
    if (line.startsWith("#")) continue;
    const validated = validatedApneLiveAsset(line, base);
    if (!validated || validated.ext !== "ts") throw Error("Untrusted segment");
    segments.push({ url: validated.url, key: currentKey, sequence: sequence++ });
    if (segments.length > 1200) throw Error("Oversized HLS sequence");
  }
  if (!segments.length) throw Error("No TS media segments");
  // Use segment 4 and 5 (~30-50s) to skip introductory/logo frames.
  const index = segments.length >= 6 ? 3 : 0;
  return segments.slice(index, index + 2);
}

export async function boundedApneAsset(url, { referer, maxBytes, fetchImpl = fetch, timeoutMs = 8500 } = {}) {
  const asset = validatedApneLiveAsset(url);
  if (!asset || !["m3u8", "key", "ts"].includes(asset.ext)) throw Error("Untrusted APNE media URL");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TOTAL_MEDIA_BYTES) throw Error("Invalid byte limit");
  const response = await fetchImpl(asset.url, {
    redirect: "manual",
    headers: { "User-Agent": USER_AGENT, "Referer": referer, "Accept": "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200 || response.redirected || response.url !== asset.url) {
    await response.body?.cancel().catch(() => {});
    throw Error("Upstream media failed");
  }
  const stated = Number(response.headers.get("content-length"));
  if (Number.isFinite(stated) && stated > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw Error("Media exceeds preview budget");
  }
  if (!response.body) throw Error("Missing media body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw Error("Preview byte budget exceeded");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (!length) throw Error("Empty media");
  return Buffer.concat(chunks, length);
}

export async function fetchApnePreviewMedia({ hlsUrl, referer }, { fetchImpl = fetch } = {}) {
  const playlist = validatedApneLiveAsset(hlsUrl);
  if (!playlist || playlist.ext !== "m3u8") throw Error("Untrusted HLS source");
  // No remote playlist redirects or nested/master fetches; the APNE resolver
  // gives us a direct TS media playlist. A changed format falls back safely.
  const manifest = await boundedApneAsset(playlist.url, {
    referer, maxBytes: MAX_MANIFEST_BYTES, fetchImpl,
  });
  const chosen = parseApnePreviewManifest(manifest.toString("utf8"), playlist.url);
  let total = 0;
  const keyCache = new Map();
  const output = [];
  for (const segment of chosen) {
    const encrypted = await boundedApneAsset(segment.url, {
      referer, maxBytes: MAX_SEGMENT_BYTES, fetchImpl,
    });
    total += encrypted.length;
    if (total > MAX_TOTAL_MEDIA_BYTES) throw Error("Preview media budget exceeded");
    let decoded = encrypted;
    if (segment.key) {
      let key = keyCache.get(segment.key.url);
      if (!key) {
        key = await boundedApneAsset(segment.key.url, { referer, maxBytes: 16, fetchImpl });
        if (key.length !== 16) throw Error("Invalid APNE AES key");
        keyCache.set(segment.key.url, key);
      }
      const iv = segment.key.iv || (() => {
        const v = Buffer.alloc(16); v.writeBigUInt64BE(BigInt(segment.sequence), 8); return v;
      })();
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
      decoded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    }
    output.push(decoded);
  }
  return Buffer.concat(output);
}

export function jpegFromApnePreview(tsData, {
  ffmpegPath = "ffmpeg", timeoutMs = 12_000, spawnProcess = spawn,
} = {}) {
  if (!Buffer.isBuffer(tsData) || !tsData.length || tsData.length > MAX_TOTAL_MEDIA_BYTES)
    return Promise.reject(Error("Invalid bounded video input"));
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe",
      "-f", "mpegts", "-i", "pipe:0", "-ss", "1",
      "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
      "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
      "-q:v", "5", "-f", "image2pipe", "pipe:1",
    ];
    let child;
    try { child = spawnProcess(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { reject(error); return; }
    let done = false;
    let n = 0;
    const chunks = [];
    let errorTail = "";
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (piece) => {
      n += piece.length;
      if (n > MAX_JPEG_BYTES) child.kill("SIGKILL");
      else chunks.push(piece);
    });
    child.stderr.on("data", (piece) => { errorTail = (errorTail + String(piece)).slice(-700); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const image = Buffer.concat(chunks);
      if (code === 0 && image.length > 100 && image.length <= MAX_JPEG_BYTES &&
          image[0] === 0xff && image[1] === 0xd8 && image.at(-2) === 0xff && image.at(-1) === 0xd9)
        finish(null, image);
      else finish(Error("APNE frame extraction failed: " + (errorTail || code)));
    });
    child.stdin.end(tsData);
  });
}

export function createApneLiveThumbnailService({
  cacheDir, canPreview, resolveEpisode, ffmpegPath = "ffmpeg",
  fetchImpl = fetch, spawnProcess = spawn, cooldownMs = FAILURE_COOLDOWN_MS,
  maxPending = 6, now = Date.now,
} = {}) {
  if (!cacheDir || typeof canPreview !== "function" || typeof resolveEpisode !== "function")
    throw TypeError("Preview cache and episode eligibility checks are required");
  const pending = [];
  const queued = new Set();
  const cooldowns = new Map();
  let working = false;

  async function cached(file, showId) {
    const [root, folder] = await Promise.all([
      fs.realpath(cacheDir).catch(() => null),
      fs.realpath(path.dirname(file)).catch(() => null),
    ]);
    if (!root || !folder || path.relative(root, folder) !== showId) return false;
    const stat = await fs.lstat(file).catch(() => null);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size > 100 &&
      stat.size < MAX_JPEG_BYTES && now() - stat.mtimeMs < CACHE_TTL_MS);
  }

  async function create({ showId, dateKey, file }) {
    if (!await canPreview(showId, dateKey)) throw Error("Episode no longer eligible");
    const source = await resolveEpisode(showId, dateKey);
    const media = await fetchApnePreviewMedia(source, { fetchImpl });
    const image = await withApneThumbnailWorker(() =>
      jpegFromApnePreview(media, { ffmpegPath, spawnProcess }));
    const folder = path.dirname(file);
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const [root, realFolder] = await Promise.all([fs.realpath(cacheDir), fs.realpath(folder)]);
    if (path.relative(root, realFolder) !== showId) throw Error("Unsafe preview cache");
    const temp = path.join(folder, "." + path.basename(file) + "." + crypto.randomUUID() + ".tmp");
    try {
      await fs.writeFile(temp, image, { flag: "wx", mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function drain() {
    if (working) return;
    working = true;
    try {
      while (pending.length) {
        const task = pending.shift();
        try { await create(task); cooldowns.delete(task.key); }
        catch { cooldowns.set(task.key, now() + cooldownMs); }
        finally { queued.delete(task.key); }
      }
    } finally { working = false; }
  }

  async function request(showId, dateKey) {
    if (!validApneThumbnailKey(showId, dateKey)) return { status: "invalid" };
    const episodeDate = Date.parse(dateKey + "T00:00:00Z");
    if (now() - episodeDate > 105 * 86400_000 || episodeDate - now() > 3 * 86400_000)
      return { status: "missing" };
    if (!await canPreview(showId, dateKey)) return { status: "missing" };
    const key = showId + "/" + dateKey;
    const file = path.join(cacheDir, showId, dateKey + "-" + VERSION + ".jpg");
    if (await cached(file, showId)) return { status: "ready", file };
    if (queued.has(key)) return { status: "pending" };
    if ((cooldowns.get(key) || 0) > now()) return { status: "cooldown" };
    if (pending.length >= maxPending) return { status: "busy" };
    pending.push({ key, showId, dateKey, file });
    queued.add(key);
    void drain();
    return { status: "pending" };
  }
  return { request, stats: () => ({ active: Number(working), queued: pending.length }) };
}
