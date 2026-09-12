// Thin wrapper around yt-dlp for: metadata, playlist expansion, direct stream URL, and downloads.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

function run(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, ["--ignore-config", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp not found or failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `yt-dlp exited ${code}`));
    });
  });
}

// Single video/stream metadata (no download).
export async function getInfo(url) {
  const json = await run(["-J", "--no-warnings", "--no-playlist", url]);
  const info = JSON.parse(json);
  return {
    id: info.id,
    title: info.title,
    duration: info.duration,
    thumbnail: info.thumbnail,
    uploader: info.uploader,
    isLive: !!info.is_live,
    webpage_url: info.webpage_url || url,
  };
}

// Expand a YouTube playlist/channel URL into a flat list of entries (fast, no per-video fetch).
export async function getPlaylistEntries(url) {
  const json = await run(["-J", "--flat-playlist", "--no-warnings", url], { timeoutMs: 90000 });
  const info = JSON.parse(json);
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  return {
    playlistTitle: info.title || null,
    entries: entries
      .filter((e) => e && e.id)
      .map((e) => ({
        id: e.id,
        title: e.title || e.id,
        url: e.url && e.url.startsWith("http") ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
        duration: e.duration || null,
        thumbnail: e.thumbnails?.[0]?.url || null,
      })),
  };
}

function bestThumbnail(entry) {
  const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  const sorted = thumbs
    .filter((thumb) => thumb?.url)
    .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  return sorted[0]?.url || entry.thumbnail || null;
}

// Search YouTube without requiring OAuth. Returns flat video entries that can be streamed later.
export async function searchVideos(query, { limit = 20 } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("search query required");
  const count = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
  const json = await run(["-J", "--flat-playlist", "--no-warnings", `ytsearch${count}:${q}`], { timeoutMs: 90000 });
  const info = JSON.parse(json);
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return {
    query: q,
    items: entries
      .filter((entry) => entry && entry.id)
      .map((entry) => {
        const url = entry.webpage_url || (entry.url && entry.url.startsWith("http") ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`);
        const liveStatus = String(entry.live_status || "").toLowerCase();
        return {
          id: entry.id,
          title: entry.title || entry.id,
          url,
          duration: entry.duration || null,
          thumbnail: bestThumbnail(entry),
          channelTitle: entry.uploader || entry.channel || entry.channel_name || null,
          publishedAt: entry.timestamp ? new Date(entry.timestamp * 1000).toISOString() : null,
          viewCount: entry.view_count || null,
          isLive: Boolean(entry.is_live) || liveStatus === "is_live",
          isUpcoming: liveStatus === "is_upcoming",
        };
      }),
  };
}

// Resolve direct media URLs and the request headers yt-dlp associates with them.
// Keeping the headers matters because YouTube can bind signed googlevideo URLs to
// a particular client identity.
export function selectedStreamInfo(info) {
  const requested = Array.isArray(info?.requested_formats) ? info.requested_formats.filter(Boolean) : [];
  if (requested.length) {
    const video = requested.find((format) => format.vcodec && format.vcodec !== "none") || requested[0];
    const audio = requested.find((format) => format !== video && format.acodec && format.acodec !== "none") || null;
    return {
      videoUrl: video?.url || null,
      audioUrl: audio?.url || null,
      videoHeaders: { ...(info.http_headers || {}), ...(video?.http_headers || {}) },
      audioHeaders: audio ? { ...(info.http_headers || {}), ...(audio.http_headers || {}) } : null,
    };
  }
  return {
    videoUrl: info?.url || null,
    audioUrl: null,
    videoHeaders: { ...(info?.http_headers || {}) },
    audioHeaders: null,
  };
}

async function resolveFormatSelection(url, format) {
  const json = await run(["--check-formats", "-j", "-f", format, "--no-warnings", "--no-playlist", url]);
  const info = JSON.parse(json);
  const selected = selectedStreamInfo(info);
  if (!selected.videoUrl) throw new Error("no playable stream URL found");
  return selected;
}

// Resolve a direct, ffmpeg-playable URL for a video at or below maxHeight.
// Returns signed media URLs plus yt-dlp's request headers. Prefers a muxed stream.
export async function getStreamUrls(url, maxHeight = config.download.maxHeight) {
  const muxedFmt = `best[height<=${maxHeight}][acodec!=none][vcodec!=none]/best[height<=${maxHeight}]`;
  try {
    return await resolveFormatSelection(url, muxedFmt);
  } catch {
    /* fall through to split streams */
  }
  const splitFmt = `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`;
  return resolveFormatSelection(url, splitFmt);
}

// Download a video to the library. Returns { filePath, info }. onProgress(pct, line) optional.
export async function downloadToDirectory(url, {
  directory,
  maxHeight = config.download.maxHeight,
  onProgress,
  outputTemplate = "%(title).200B [%(id)s].%(ext)s",
} = {}) {
  if (!directory) throw new Error("download directory required");
  await fs.mkdir(directory, { recursive: true });
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(directory, outputTemplate);
    const fmt = `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`;
    const args = [
      "-f", fmt,
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--print", "after_move:filepath",
      "-o", outTmpl,
      url,
    ];
    const child = spawn(config.ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let filePath = "";
    let err = "";
    child.stdout.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m && onProgress) onProgress(parseFloat(m[1]), line.trim());
        // The --print line is the final resolved filepath.
        if (line.trim() && !line.startsWith("[") && path.isAbsolute(line.trim())) {
          filePath = line.trim();
        }
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`yt-dlp failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0 && filePath) resolve({ filePath });
      else reject(new Error(err.trim() || `download failed (exit ${code})`));
    });
  });
}

export function download(url, { maxHeight = config.download.maxHeight, onProgress } = {}) {
  return downloadToDirectory(url, {
    directory: config.libraryDir,
    maxHeight,
    onProgress,
  });
}
