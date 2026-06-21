import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

const ROOT = path.join(config.dataDir, "processed-library");
const TMP = path.join(config.dataDir, "processed-tmp");
const PLAYLISTS_FILE = path.join(ROOT, "playlists.json");
const SUPPORTED_RESOLUTIONS = [720, 480, 360, 240];
const DEFAULT_PLAYLIST_URL = "https://youtube.com/playlist?list=PLNl8vnMvFc8OibRz6GZKn0jFn_GArpMwn&si=3vUwGvdtu_KLQemn";
const DEFAULT_PLAYLIST_ID = "default-plnl8vnmvfc8";

function safeId(id) {
  return String(id || crypto.randomBytes(6).toString("hex")).replace(/[^-\w.]/g, "").slice(0, 100);
}

function runCapture(bin, args, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(bin)} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `${path.basename(bin)} exited ${code}`));
    });
  });
}

function runProgress(bin, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    const read = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) onLine?.(line);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 8000) err = err.slice(-8000);
      read(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `${path.basename(bin)} exited ${code}`));
    });
  });
}

async function ensureDirs() {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(TMP, { recursive: true });
}

function defaultPlaylist() {
  return {
    id: DEFAULT_PLAYLIST_ID,
    name: "Default YouTube Playlist",
    url: DEFAULT_PLAYLIST_URL,
    createdAt: 0,
    builtin: true,
  };
}

async function readPlaylistsFile() {
  await ensureDirs();
  try {
    const parsed = JSON.parse(await fs.readFile(PLAYLISTS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return [];
  }
}

async function writePlaylistsFile(playlists) {
  await ensureDirs();
  const tmp = `${PLAYLISTS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(playlists, null, 2), "utf8");
  await fs.rename(tmp, PLAYLISTS_FILE);
}

export async function listPlaylists() {
  const playlists = await readPlaylistsFile();
  if (!playlists.some((playlist) => playlist.id === DEFAULT_PLAYLIST_ID || playlist.url === DEFAULT_PLAYLIST_URL)) {
    playlists.unshift(defaultPlaylist());
    await writePlaylistsFile(playlists);
  }
  return playlists;
}

export async function addPlaylist({ url, name }) {
  if (!url || !String(url).trim()) throw new Error("playlist url required");
  const cleanUrl = String(url).trim();
  const playlists = await listPlaylists();
  const existing = playlists.find((playlist) => playlist.url === cleanUrl);
  if (existing) return { ...existing, duplicate: true };
  let title = String(name || "").trim();
  if (!title) {
    try { title = await playlistTitle(cleanUrl); } catch {}
  }
  const playlist = {
    id: crypto.randomBytes(8).toString("hex"),
    name: title || cleanUrl,
    url: cleanUrl,
    createdAt: Date.now(),
  };
  playlists.push(playlist);
  await writePlaylistsFile(playlists);
  return playlist;
}

export async function deletePlaylist(id) {
  const playlists = await listPlaylists();
  const next = playlists.filter((playlist) => playlist.id !== id || playlist.builtin);
  await writePlaylistsFile(next);
  return next.length !== playlists.length;
}

async function getRawInfo(url) {
  const json = await runCapture(config.ytdlpPath, ["-J", "--no-warnings", "--no-playlist", url]);
  return JSON.parse(json);
}

function availableHeights(info) {
  const heights = new Set();
  for (const f of info.formats || []) {
    if (f?.vcodec && f.vcodec !== "none" && Number.isFinite(f.height)) heights.add(f.height);
  }
  return [...heights].sort((a, b) => b - a);
}

function selectResolutions(requested, available) {
  const choices = [...new Set((requested || [])
    .map((r) => parseInt(r, 10))
    .filter((r) => SUPPORTED_RESOLUTIONS.includes(r)))]
    .sort((a, b) => b - a);
  const selected = [];
  for (const res of choices.length ? choices : [config.download.maxHeight]) {
    const actual = available.filter((h) => h <= res).sort((a, b) => b - a)[0];
    if (actual && actual >= 240 && !selected.includes(actual)) selected.push(actual);
  }
  return selected;
}

export async function formats(url) {
  const info = await getRawInfo(url);
  return {
    id: info.id,
    title: info.title || "Untitled",
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    availableResolutions: availableHeights(info),
    supportedResolutions: SUPPORTED_RESOLUTIONS,
  };
}

export async function playlistTitle(url) {
  const json = await runCapture(config.ytdlpPath, ["-J", "--flat-playlist", "--no-warnings", url], { timeoutMs: 90000 });
  const info = JSON.parse(json);
  return info.title || "Untitled Playlist";
}

export async function playlistEntries(url) {
  const json = await runCapture(config.ytdlpPath, ["-J", "--flat-playlist", "--no-warnings", url], { timeoutMs: 120000 });
  const info = JSON.parse(json);
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return entries
    .filter((entry) => entry && entry.id)
    .map((entry) => ({
      id: entry.id,
      title: entry.title || entry.id,
      url: entry.url && entry.url.startsWith("http") ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
      duration: entry.duration || null,
      thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || null,
    }));
}

async function copyExistingFiles(id, sessionDir) {
  const existingDir = path.join(ROOT, id);
  try {
    const names = await fs.readdir(existingDir);
    for (const name of names) {
      if (/^(video_\d+\.mp4|audio\.mp3|info\.json)$/.test(name)) {
        await fs.copyFile(path.join(existingDir, name), path.join(sessionDir, name)).catch(() => {});
      }
    }
  } catch {}
}

export async function list() {
  await ensureDirs();
  let dirs = [];
  try { dirs = await fs.readdir(ROOT, { withFileTypes: true }); } catch {}
  const items = [];
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(ROOT, dirent.name);
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, "info.json"), "utf8"));
      const files = await fs.readdir(dir);
      const resolutions = files
        .map((name) => name.match(/^video_(\d+)\.mp4$/)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => b - a);
      if (resolutions.length) items.push({ ...info, id: dirent.name, resolutions });
    } catch {}
  }
  return items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function get(id) {
  const safe = safeId(id);
  const infoPath = path.join(ROOT, safe, "info.json");
  try {
    const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
    const files = await fs.readdir(path.join(ROOT, safe));
    const resolutions = files
      .map((name) => name.match(/^video_(\d+)\.mp4$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => b - a);
    return { ...info, id: safe, resolutions };
  } catch {
    return null;
  }
}

export function videoPath(id, resolution) {
  return path.join(ROOT, safeId(id), `video_${parseInt(resolution, 10)}.mp4`);
}

export function audioPath(id) {
  return path.join(ROOT, safeId(id), "audio.mp3");
}

export async function remove(id) {
  await fs.rm(path.join(ROOT, safeId(id)), { recursive: true, force: true });
}

export async function processDownload(url, { resolutions, onProgress } = {}) {
  await ensureDirs();
  onProgress?.(2, "Fetching video information");
  const info = await getRawInfo(url);
  const id = safeId(info.id);
  const title = info.title || "Untitled";
  const heights = availableHeights(info);
  const selected = selectResolutions(resolutions, heights);
  if (!selected.length) throw new Error(`No supported downloadable resolutions. Available: ${heights.join(", ") || "none"}`);

  const sessionDir = path.join(TMP, `${Date.now()}-${id}`);
  await fs.mkdir(sessionDir, { recursive: true });
  await copyExistingFiles(id, sessionDir);

  try {
    const downloaded = [];
    for (let i = 0; i < selected.length; i++) {
      const res = selected[i];
      const outBase = path.join(sessionDir, `download_${res}`);
      const finalPath = path.join(sessionDir, `video_${res}.mp4`);
      const phaseBase = 5 + Math.round((i / selected.length) * 58);
      const phaseSize = Math.max(8, Math.round(58 / selected.length));
      const fmt = `bestvideo[height<=${res}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${res}]+bestaudio/best[height<=${res}]`;
      onProgress?.(phaseBase, `Downloading ${res}p`);
      await runProgress(config.ytdlpPath, [
        "-f", fmt,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "-o", `${outBase}.%(ext)s`,
        url,
      ], {
        onLine: (line) => {
          const m = line.match(/\[download\]\s+([\d.]+)%/);
          if (m) onProgress?.(phaseBase + (parseFloat(m[1]) / 100) * phaseSize, `Downloading ${res}p`);
        },
      });
      const produced = `${outBase}.mp4`;
      await fs.rename(produced, finalPath);
      downloaded.push({ resolution: res, path: finalPath });
    }

    const best = downloaded[0];
    onProgress?.(68, "Extracting seekable audio");
    await runProgress(config.ffmpegPath, [
      "-hide_banner", "-nostdin", "-y",
      "-i", best.path,
      "-map", "0:a:0",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-write_xing", "0",
      "-ar", "44100",
      "-ac", "2",
      path.join(sessionDir, "audio.mp3"),
    ], { onLine: () => {} });

    for (let i = 0; i < downloaded.length; i++) {
      const entry = downloaded[i];
      const tempNoAudio = `${entry.path}.noaudio.mp4`;
      onProgress?.(78 + Math.round((i / downloaded.length) * 14), `Preparing ${entry.resolution}p video`);
      await runProgress(config.ffmpegPath, [
        "-hide_banner", "-nostdin", "-y",
        "-i", entry.path,
        "-an",
        "-c:v", "copy",
        tempNoAudio,
      ], { onLine: () => {} });
      await fs.rename(tempNoAudio, entry.path);
    }

    const finalDir = path.join(ROOT, id);
    const allFiles = await fs.readdir(sessionDir);
    const allResolutions = allFiles
      .map((name) => name.match(/^video_(\d+)\.mp4$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => b - a);
    const infoJson = {
      id,
      originalYoutubeId: info.id || id,
      title,
      duration: info.duration || null,
      thumbnail: info.thumbnail || null,
      originalUrl: info.webpage_url || url,
      savedAt: Date.now(),
      resolutions: allResolutions,
    };
    await fs.writeFile(path.join(sessionDir, "info.json"), JSON.stringify(infoJson, null, 2), "utf8");
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(sessionDir, finalDir);
    onProgress?.(100, "Ready");
    return infoJson;
  } catch (err) {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
