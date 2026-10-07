// Bounded yt-dlp adapter for metadata, stream resolution, and downloads.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { classifyExtractorError, probeExtractorCandidates, sanitizeExtractorMessage } from "./extractor-health.js";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_DOWNLOAD_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;
const JS_RUNTIME = String(process.env.YTDLP_JS_RUNTIME || "node").trim() || "node";

function boundedTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, n)) : fallback;
}

export function commonArgs(args = []) {
  return ["--ignore-config", "--js-runtimes", JS_RUNTIME, ...args];
}

function appendBounded(current, chunk, maxBytes, keepTail = false) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= maxBytes) return next;
  const suffix = "\n[output truncated]";
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  if (keepTail) return Buffer.from(next).subarray(-available).toString("utf8") + suffix;
  return Buffer.from(next).subarray(0, available).toString("utf8") + suffix;
}

function run(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_CAPTURE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, commonArgs(args), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`${path.basename(bin)} failed to start: ${sanitizeExtractorMessage(error.message)}`));
      return;
    }
    let out = "";
    let err = "";
    let outputExceeded = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`${path.basename(bin)} timed out`);
      error.code = "ETIMEDOUT";
      finish(reject, error);
    }, boundedTimeout(timeoutMs));
    child.stdout.on("data", (d) => {
      if (Buffer.byteLength(out) + d.length > maxOutputBytes) outputExceeded = true;
      out = appendBounded(out, d, maxOutputBytes);
    });
    child.stderr.on("data", (d) => { err = appendBounded(err, d, MAX_ERROR_BYTES, true); });
    child.on("error", (error) => finish(reject, new Error(`${path.basename(bin)} failed to start: ${sanitizeExtractorMessage(error.message)}`)));
    child.on("close", (code) => {
      if (code === 0 && outputExceeded) {
        const error = new Error("yt-dlp output exceeded limit");
        error.code = "EOUTPUTLIMIT";
        finish(reject, error);
      } else if (code === 0) finish(resolve, out.trim());
      else {
        const message = sanitizeExtractorMessage(err.trim() || `${path.basename(bin)} exited ${code}`);
        const error = new Error(message);
        error.exitCode = code;
        error.extractorClass = classifyExtractorError(message);
        finish(reject, error);
      }
    });
  });
}

function fallbackPath() {
  if (process.env.YTDLP_FALLBACK_PATH !== undefined) return String(process.env.YTDLP_FALLBACK_PATH).trim() || null;
  const retained = path.join(config.dataDir, "extractor-backup", "bin", "yt-dlp");
  return existsSync(retained) ? retained : null;
}

function candidatePaths() {
  return [...new Set([config.ytdlpPath, fallbackPath()].filter(Boolean))];
}

export async function capture(args, options = {}) {
  try {
    return await run(config.ytdlpPath, args, options);
  } catch (error) {
    const fallback = fallbackPath();
    if (!fallback || path.resolve(fallback) === path.resolve(config.ytdlpPath) || !error.extractorClass) throw error;
    try {
      return await run(fallback, args, options);
    } catch (fallbackError) {
      fallbackError.primaryExtractorClass = error.extractorClass;
      throw fallbackError;
    }
  }
}

// Local-only probes: executable version plus a bounded help invocation. No network or installation.
export async function getExtractorDiagnostics() {
  return probeExtractorCandidates(candidatePaths(), { jsRuntime: JS_RUNTIME });
}

// Explicit self-test for callers to mount behind their own authorization boundary.
export async function selfTestExtractorCandidates() {
  return probeExtractorCandidates(candidatePaths(), { jsRuntime: JS_RUNTIME, selfTest: true });
}

const PLAYBACK_TEST_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

function validatePlaybackTestUrl(rawUrl) {
  const raw = String(rawUrl ?? "");
  if (!raw || raw.length > 2048 || raw !== raw.trim() || raw.includes("#")) throw new Error("playback test URL is invalid");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("playback test URL is invalid"); }
  if (parsed.protocol !== "https:" || !PLAYBACK_TEST_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.port) {
    throw new Error("playback test URL must be HTTPS on a supported YouTube host");
  }
  return parsed;
}

// Explicit network canary. Each configured executable is tested independently;
// this function never falls back between candidates or changes executable selection.
export async function testExtractorPlayback(url) {
  const parsedUrl = validatePlaybackTestUrl(url);
  const safeInput = parsedUrl.href;
  const results = [];
  for (const binary of candidatePaths()) {
    const result = { executable: path.basename(binary), ok: false, sourceId: null, error: null };
    try {
      const json = await run(binary, ["-J", "--no-playlist", "--skip-download", "-f", "bestvideo[height<=480]+bestaudio/best", safeInput], {
        timeoutMs: 15_000,
        maxOutputBytes: MAX_CAPTURE_BYTES,
      });
      const info = JSON.parse(json);
      const selected = selectedStreamInfo(info);
      const sourceId = String(info?.id || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) throw new Error("extractor returned no valid source id");
      if (typeof selected.videoUrl !== "string" || !selected.videoUrl.trim()) throw new Error("extractor returned no playable video output");
      result.ok = true;
      result.sourceId = sourceId;
    } catch (error) {
      result.error = sanitizeExtractorMessage(error.message || "playback canary failed");
    }
    results.push(result);
  }
  return results;
}

// Single video/stream metadata (no download).
export async function getInfo(url) {
  const json = await capture(["-J", "--no-warnings", "--no-playlist", url]);
  const info = JSON.parse(json);
  return { id: info.id, title: info.title, duration: info.duration, thumbnail: info.thumbnail, uploader: info.uploader, isLive: !!info.is_live, webpage_url: info.webpage_url || url };
}

// Expand a YouTube playlist/channel URL into a flat list of entries.
export async function getPlaylistEntries(url) {
  const json = await capture(["-J", "--flat-playlist", "--no-warnings", url], { timeoutMs: 90_000 });
  const info = JSON.parse(json);
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  return { playlistTitle: info.title || null, entries: entries.filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title || e.id, url: e.url && e.url.startsWith("http") ? e.url : `https://www.youtube.com/watch?v=${e.id}`, duration: e.duration || null, thumbnail: e.thumbnails?.[0]?.url || null })) };
}

function bestThumbnail(entry) {
  const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  return thumbs.filter((thumb) => thumb?.url).sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0]?.url || entry.thumbnail || null;
}

export async function searchVideos(query, { limit = 20 } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("search query required");
  const count = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
  const json = await capture(["-J", "--flat-playlist", "--no-warnings", `ytsearch${count}:${q}`], { timeoutMs: 90_000 });
  const info = JSON.parse(json);
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return { query: q, items: entries.filter((entry) => entry && entry.id).map((entry) => {
    const url = entry.webpage_url || (entry.url && entry.url.startsWith("http") ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`);
    const liveStatus = String(entry.live_status || "").toLowerCase();
    return { id: entry.id, title: entry.title || entry.id, url, duration: entry.duration || null, thumbnail: bestThumbnail(entry), channelTitle: entry.uploader || entry.channel || entry.channel_name || null, publishedAt: entry.timestamp ? new Date(entry.timestamp * 1000).toISOString() : null, viewCount: entry.view_count || null, isLive: Boolean(entry.is_live) || liveStatus === "is_live", isUpcoming: liveStatus === "is_upcoming" };
  }) };
}

export function selectedStreamInfo(info) {
  const metadata = { isLive: Boolean(info?.is_live) || info?.live_status === "is_live", duration: info?.duration != null && info.duration !== "" && Number.isFinite(Number(info.duration)) ? Number(info.duration) : null, title: info?.title || null };
  const requested = Array.isArray(info?.requested_formats) ? info.requested_formats.filter(Boolean) : [];
  if (requested.length) {
    const video = requested.find((format) => format.vcodec && format.vcodec !== "none") || requested[0];
    const audio = requested.find((format) => format !== video && format.acodec && format.acodec !== "none") || null;
    return { ...metadata, videoUrl: video?.url || null, audioUrl: audio?.url || null, videoHeaders: { ...(info.http_headers || {}), ...(video?.http_headers || {}) }, audioHeaders: audio ? { ...(info.http_headers || {}), ...(audio?.http_headers || {}) } : null };
  }
  return { ...metadata, videoUrl: info?.url || null, audioUrl: null, videoHeaders: { ...(info?.http_headers || {}) }, audioHeaders: null };
}

async function resolveFormatSelection(url, format) {
  const json = await capture(["--check-formats", "-j", "-f", format, "--no-warnings", "--no-playlist", url]);
  const selected = selectedStreamInfo(JSON.parse(json));
  if (!selected.videoUrl) throw new Error("no playable stream URL found");
  return selected;
}

export async function getStreamUrls(url, maxHeight = config.download.maxHeight) {
  const height = Math.max(144, Math.min(config.download.maxHeight, Number(maxHeight) || config.download.maxHeight));
  const format = [`best[height<=${height}][acodec!=none][vcodec!=none]`, `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio`, `bestvideo[height<=${height}]+bestaudio`, `best[height<=${height}]`].join("/");
  return resolveFormatSelection(url, format);
}

// Downloads deliberately use only the primary executable and are never retried.
export async function downloadToDirectory(url, { directory, maxHeight = config.download.maxHeight, onProgress, outputTemplate = "%(title).200B [%(id)s].%(ext)s" } = {}) {
  if (!directory) throw new Error("download directory required");
  await fs.mkdir(directory, { recursive: true });
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(directory, outputTemplate);
    const fmt = `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`;
    const args = commonArgs(["-f", fmt, "--merge-output-format", "mp4", "--no-playlist", "--no-warnings", "--newline", "--print", "after_move:filepath", "-o", outTmpl, url]);
    const child = spawn(config.ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let filePath = "";
    let err = "";
    let stdoutBytes = 0;
    let stdoutPending = "";
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); const error = new Error("yt-dlp download timed out"); error.code = "ETIMEDOUT"; finish(reject, error); }, DOWNLOAD_TIMEOUT_MS);
    const processLine = (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m && onProgress) onProgress(parseFloat(m[1]), sanitizeExtractorMessage(line.trim()));
      if (line.trim() && !line.startsWith("[") && path.isAbsolute(line.trim())) filePath = line.trim();
    };
    child.stdout.on("data", (d) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_DOWNLOAD_STDOUT_BYTES) { child.kill("SIGKILL"); finish(reject, new Error("yt-dlp download output exceeded limit")); return; }
      const lines = (stdoutPending + d.toString()).split(/\r?\n/);
      stdoutPending = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (d) => { err = appendBounded(err, d, MAX_ERROR_BYTES, true); });
    child.on("error", (e) => finish(reject, new Error(`yt-dlp failed to start: ${sanitizeExtractorMessage(e.message)}`)));
    child.on("close", (code) => {
      if (stdoutPending) processLine(stdoutPending);
      if (code === 0 && filePath) finish(resolve, { filePath });
      else finish(reject, new Error(sanitizeExtractorMessage(err.trim() || `download failed (exit ${code})`)));
    });
  });
}

export function download(url, { maxHeight = config.download.maxHeight, onProgress } = {}) {
  return downloadToDirectory(url, { directory: config.libraryDir, maxHeight, onProgress });
}
