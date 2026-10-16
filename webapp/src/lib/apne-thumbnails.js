// On-demand APNE still thumbnails, derived only from registered local MP4s.
// Single ffmpeg worker; no downloads, source modifications or network access.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const SHOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = "v1";
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 30 * 86400_000;

export function validApneThumbnailKey(showId, dateKey) {
  if (!SHOW_ID.test(showId) || !DATE_KEY.test(dateKey)) return false;
  const parsed = new Date(dateKey + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateKey;
}

// Share one ffmpeg slot across saved-MP4 and unsaved-HLS thumbnails.
let thumbnailWorkerTail = Promise.resolve();
export async function withApneThumbnailWorker(operation) {
  const previous = thumbnailWorkerTail;
  let release;
  thumbnailWorkerTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
}

export function createApneThumbnailService({
  cacheDir,
  ffmpegPath = "ffmpeg",
  resolveSaved,
  timeoutMs = 15_000,
  cooldownMs = 10 * 60_000,
  maxPending = 12,
  seekSeconds = 90,
  now = () => Date.now(),
  spawnProcess = spawn,
} = {}) {
  if (!cacheDir || typeof resolveSaved !== "function") throw new TypeError("Thumbnail cache and saved resolver required");
  const queued = new Map();
  const failures = new Map();
  const tasks = [];
  let active = false;

  async function cached(file) {
    // Reject symlinked cache folders as well as symlinked images.
    const [root, folder] = await Promise.all([
      fs.realpath(cacheDir).catch(() => null),
      fs.realpath(path.dirname(file)).catch(() => null),
    ]);
    if (!root || !folder || path.relative(root, folder) !== path.basename(path.dirname(file))) return false;
    const stat = await fs.lstat(file).catch(() => null);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size > 100 &&
      stat.size <= MAX_BYTES && now() - stat.mtimeMs < TTL_MS);
  }

  async function extract(task) {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(task.folder, { recursive: true, mode: 0o700 });
    const [root, folder] = await Promise.all([fs.realpath(cacheDir), fs.realpath(task.folder)]);
    if (path.relative(root, folder) !== task.showId) throw new Error("Unsafe thumbnail cache directory");
    const temporary = path.join(folder, "." + path.basename(task.file) + "." + crypto.randomUUID() + ".jpg");
    try {
      await new Promise((resolve, reject) => {
        const args = [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
          "-filter_threads", "1", "-ss", String(seekSeconds), "-i", task.source,
          "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
          "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
          "-q:v", "5", "-f", "image2", "-y", temporary,
        ];
        let child;
        try { child = spawnProcess(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); }
        catch (err) { reject(err); return; }
        let stderr = "";
        child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-1000); });
        const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        timeout.unref?.();
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(signal ? "ffmpeg timed out or terminated" : (stderr || "ffmpeg exited " + code)));
        });
      });
      const stat = await fs.lstat(temporary);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 100 || stat.size > MAX_BYTES)
        throw new Error("Invalid thumbnail output");
      await fs.rename(temporary, task.file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function drain() {
    if (active) return;
    active = true;
    try {
      while (tasks.length) {
        const task = tasks.shift();
        try {
          await withApneThumbnailWorker(() => extract(task));
          failures.delete(task.key);
        } catch {
          failures.set(task.key, now() + cooldownMs);
        } finally {
          queued.delete(task.key);
        }
      }
    } finally { active = false; }
  }

  async function request(showId, dateKey) {
    if (!validApneThumbnailKey(showId, dateKey)) return { status: "invalid" };
    // Resolve each request afresh: a deleted/deregistered MP4 never remains accessible.
    const saved = await resolveSaved(showId, dateKey);
    if (!saved?.filePath) return { status: "missing" };
    const stat = await fs.stat(saved.filePath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) return { status: "missing" };
    const stamp = crypto.createHash("sha256")
      .update([saved.filePath, stat.size, stat.mtimeMs].join("|")).digest("hex").slice(0, 16);
    const key = showId + "/" + dateKey + "/" + stamp;
    const folder = path.join(cacheDir, showId);
    const file = path.join(folder, dateKey + "-" + VERSION + "-" + stamp + ".jpg");
    if (await cached(file)) return { status: "ready", file };
    if (queued.has(key)) return { status: "pending" };
    if ((failures.get(key) || 0) > now()) return { status: "cooldown" };
    if (tasks.length >= maxPending) return { status: "busy" };
    const task = { key, showId, dateKey, folder, file, source: saved.filePath };
    tasks.push(task);
    queued.set(key, task);
    void drain();
    return { status: "pending" };
  }

  return {
    request,
    stats: () => ({ active: Number(active), pending: tasks.length, inFlight: queued.size }),
  };
}
