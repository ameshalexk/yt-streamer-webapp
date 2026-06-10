// Thin wrapper around yt-dlp for: metadata, playlist expansion, direct stream URL, and downloads.
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";

function run(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
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

// Resolve a direct, ffmpeg-playable URL for a video at or below maxHeight.
// Returns { videoUrl, audioUrl|null }. Prefers a single muxed stream when available.
export async function getStreamUrls(url, maxHeight = config.download.maxHeight) {
  // Try a progressive (muxed) format first — simplest for ffmpeg.
  const muxedFmt = `best[height<=${maxHeight}][acodec!=none][vcodec!=none]/best[height<=${maxHeight}]`;
  try {
    const u = await run(["-g", "-f", muxedFmt, "--no-warnings", "--no-playlist", url]);
    const lines = u.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length === 1) return { videoUrl: lines[0], audioUrl: null };
    if (lines.length >= 2) return { videoUrl: lines[0], audioUrl: lines[1] };
  } catch {
    /* fall through to split streams */
  }
  // Fall back to separate best video + best audio.
  const splitFmt = `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`;
  const u = await run(["-g", "-f", splitFmt, "--no-warnings", "--no-playlist", url]);
  const lines = u.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error("no playable stream URL found");
  return { videoUrl: lines[0], audioUrl: lines[1] || null };
}

// Download a video to the library. Returns { filePath, info }. onProgress(pct, line) optional.
export function download(url, { maxHeight = config.download.maxHeight, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(config.libraryDir, "%(title).200B [%(id)s].%(ext)s");
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
        if (line.trim() && !line.startsWith("[") && line.includes(config.libraryDir)) {
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
