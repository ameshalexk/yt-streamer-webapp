import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import * as processedLibrary from "./processed-library.js";
import { parseDashManifest } from "./cyberdash-dash.js";

const ROOT = path.join(config.dataDir, "processed-dash-cache");
const TMP = path.join(config.dataDir, "processed-dash-tmp");
export const SEGMENT_SOURCE_SECONDS = 2;
export const SUPPORTED_PLAYBACK_RATES = [1, 1.25, 1.5, 2, 3, 4];
const CACHE_VERSION = 1;

function safeId(value) {
  return String(value || "").replace(/[^-\w.]/g, "").slice(0, 100);
}

function safeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  const exact = SUPPORTED_PLAYBACK_RATES.find((candidate) => Math.abs(candidate - rate) < 0.001);
  return exact ?? 1;
}

function rateKey(rate) {
  return String(safeRate(rate)).replace(".", "_");
}

function bitrateForHeight(height) {
  if (height >= 1080) return { target: 4500, max: 5500 };
  if (height >= 720) return { target: 2500, max: 3200 };
  if (height >= 480) return { target: 1400, max: 1900 };
  return { target: 850, max: 1200 };
}

async function ensureDirs() {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(TMP, { recursive: true });
}

async function sourceSignature(item) {
  const audio = await fs.stat(processedLibrary.audioPath(item.id));
  const videos = {};
  for (const resolution of item.resolutions || []) {
    const stat = await fs.stat(processedLibrary.videoPath(item.id, resolution));
    videos[String(resolution)] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  }
  return {
    audio: { size: audio.size, mtimeMs: Math.round(audio.mtimeMs) },
    videos,
  };
}

function signaturesEqual(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function runFfmpeg(args, { durationSec = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:2", "-nostats",
      ...args,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let buffer = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/);
        if (match && durationSec > 0) {
          const outSec = Number(match[1]) / 1e6;
          onProgress?.(Math.max(0, Math.min(1, outSec / durationSec)));
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(stderr.trim().slice(-4000) || `ffmpeg exited ${code}`));
      }
    });
  });
}

async function countSegments(dir) {
  const names = await fs.readdir(dir);
  return names.filter((name) => /^chunk-\d+\.m4s$/.test(name)).length;
}

async function parseManifestFile(file) {
  const text = await fs.readFile(file, "utf8");
  return parseDashManifest(text);
}

async function buildVideo({ item, resolution, outDir, onProgress }) {
  await fs.mkdir(outDir, { recursive: true });
  const input = processedLibrary.videoPath(item.id, resolution);
  const rate = bitrateForHeight(resolution);
  const manifestPath = path.join(outDir, "manifest.mpd");
  await runFfmpeg([
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-an",
    "-vf", `scale=-2:${resolution}`,
    "-c:v", config.video.dashEncoder,
    "-pix_fmt", "yuv420p",
    "-b:v", `${rate.target}k`,
    "-maxrate", `${rate.max}k`,
    "-bufsize", `${rate.max * 2}k`,
    "-bf", "0",
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SOURCE_SECONDS})`,
    "-f", "dash",
    "-seg_duration", String(SEGMENT_SOURCE_SECONDS),
    "-frag_duration", "1",
    "-use_template", "1",
    "-use_timeline", "1",
    "-window_size", "0",
    "-extra_window_size", "0",
    "-remove_at_exit", "0",
    "-init_seg_name", "init.m4s",
    "-media_seg_name", "chunk-$Number%05d$.m4s",
    "-adaptation_sets", "id=0,streams=v",
    manifestPath,
  ], { durationSec: Number(item.duration) || 0, onProgress });

  const manifest = await parseManifestFile(manifestPath);
  if (!manifest.video?.codec?.startsWith("avc1")) throw new Error(`Prepared ${resolution}p cache is not H.264`);
  const segmentCount = await countSegments(outDir);
  if (!segmentCount) throw new Error(`Prepared ${resolution}p cache has no video segments`);
  await fs.access(path.join(outDir, "init.m4s"));
  return {
    height: manifest.video.height || resolution,
    width: manifest.video.width || null,
    codec: manifest.video.codec,
    bandwidth: manifest.video.bandwidth,
    frameRate: manifest.video.frameRate,
    segmentCount,
    dir: `video/${resolution}`,
    init: "init.m4s",
    segmentPattern: "chunk-%05d.m4s",
  };
}

async function buildAudio({ item, rate, outDir, onProgress }) {
  await fs.mkdir(outDir, { recursive: true });
  const input = processedLibrary.audioPath(item.id);
  const outputDuration = (Number(item.duration) || 0) / rate;
  const manifestPath = path.join(outDir, "manifest.mpd");
  await runFfmpeg([
    "-y",
    "-i", input,
    "-map", "0:a:0",
    "-vn",
    "-af", `atempo=${rate}`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-f", "dash",
    "-seg_duration", String(SEGMENT_SOURCE_SECONDS / rate),
    "-frag_duration", String(Math.min(1, SEGMENT_SOURCE_SECONDS / rate)),
    "-use_template", "1",
    "-use_timeline", "1",
    "-window_size", "0",
    "-extra_window_size", "0",
    "-remove_at_exit", "0",
    "-init_seg_name", "init.m4s",
    "-media_seg_name", "chunk-$Number%05d$.m4s",
    "-adaptation_sets", "id=0,streams=a",
    manifestPath,
  ], { durationSec: outputDuration, onProgress });

  const manifest = await parseManifestFile(manifestPath);
  if (!manifest.audio?.codec?.startsWith("mp4a")) throw new Error(`Prepared ${rate}x audio cache is not AAC`);
  const segmentCount = await countSegments(outDir);
  if (!segmentCount) throw new Error(`Prepared ${rate}x audio cache has no segments`);
  await fs.access(path.join(outDir, "init.m4s"));
  return {
    rate,
    codec: manifest.audio.codec,
    bandwidth: manifest.audio.bandwidth,
    segmentCount,
    dir: `audio/${rateKey(rate)}`,
    init: "init.m4s",
    segmentPattern: "chunk-%05d.m4s",
  };
}

export async function get(id) {
  const cleanId = safeId(id);
  if (!cleanId) return null;
  try {
    const index = JSON.parse(await fs.readFile(path.join(ROOT, cleanId, "index.json"), "utf8"));
    if (index.version !== CACHE_VERSION || index.id !== cleanId) return null;
    return index;
  } catch {
    return null;
  }
}

export async function status(id) {
  const item = await processedLibrary.get(id);
  if (!item) return { status: "missing-source" };
  const index = await get(item.id);
  if (!index) return { status: "not-ready" };
  const signature = await sourceSignature(item).catch(() => null);
  if (!signature || !signaturesEqual(signature, index.sourceSignature)) return { status: "stale" };
  return {
    status: "ready",
    preparedAt: index.preparedAt,
    resolutions: Object.keys(index.resolutions || {}).map(Number).sort((a, b) => b - a),
    playbackRates: Object.keys(index.audioRates || {}).map(Number).sort((a, b) => a - b),
    segmentSourceSeconds: index.segmentSourceSeconds,
  };
}

export async function prepare(id, { resolutions = null, playbackRates = SUPPORTED_PLAYBACK_RATES, onProgress } = {}) {
  await ensureDirs();
  const item = await processedLibrary.get(id);
  if (!item) throw new Error("processed library item not found");
  const cleanId = safeId(item.id);
  const selectedResolutions = [...new Set((resolutions || item.resolutions || [])
    .map(Number)
    .filter((resolution) => item.resolutions?.includes(resolution)))]
    .sort((a, b) => b - a);
  const selectedRates = [...new Set((playbackRates || SUPPORTED_PLAYBACK_RATES).map(safeRate))]
    .sort((a, b) => a - b);
  if (!selectedResolutions.length) throw new Error("no processed video resolutions available");

  const signature = await sourceSignature(item);
  const existing = await get(cleanId);
  const existingReady = existing &&
    signaturesEqual(signature, existing.sourceSignature) &&
    selectedResolutions.every((resolution) => existing.resolutions?.[String(resolution)]) &&
    selectedRates.every((rate) => existing.audioRates?.[String(rate)]);
  if (existingReady) return existing;

  const sessionDir = path.join(TMP, `${Date.now()}-${cleanId}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(sessionDir, { recursive: true });
  const videoWeight = 0.82;
  const audioWeight = 0.18;
  try {
    const videoEntries = {};
    for (let i = 0; i < selectedResolutions.length; i++) {
      const resolution = selectedResolutions[i];
      const base = videoWeight * (i / selectedResolutions.length);
      const span = videoWeight / selectedResolutions.length;
      onProgress?.(Math.round(base * 100), `Preparing CDN video ${resolution}p`);
      videoEntries[String(resolution)] = await buildVideo({
        item,
        resolution,
        outDir: path.join(sessionDir, "video", String(resolution)),
        onProgress: (fraction) => onProgress?.(Math.round((base + span * fraction) * 100), `Preparing CDN video ${resolution}p`),
      });
    }

    const audioEntries = {};
    for (let i = 0; i < selectedRates.length; i++) {
      const rate = selectedRates[i];
      const base = videoWeight + audioWeight * (i / selectedRates.length);
      const span = audioWeight / selectedRates.length;
      onProgress?.(Math.round(base * 100), `Preparing CDN audio ${rate}x`);
      audioEntries[String(rate)] = await buildAudio({
        item,
        rate,
        outDir: path.join(sessionDir, "audio", rateKey(rate)),
        onProgress: (fraction) => onProgress?.(Math.round((base + span * fraction) * 100), `Preparing CDN audio ${rate}x`),
      });
    }

    const index = {
      version: CACHE_VERSION,
      id: cleanId,
      title: item.title,
      originalYoutubeId: item.originalYoutubeId || cleanId,
      originalUrl: item.originalUrl || null,
      duration: Number(item.duration) || null,
      segmentSourceSeconds: SEGMENT_SOURCE_SECONDS,
      preparedAt: Date.now(),
      sourceSignature: signature,
      resolutions: videoEntries,
      audioRates: audioEntries,
    };
    await fs.writeFile(path.join(sessionDir, "index.json"), JSON.stringify(index, null, 2), "utf8");

    const finalDir = path.join(ROOT, cleanId);
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(sessionDir, finalDir);
    onProgress?.(100, "CDN cache ready");
    return index;
  } catch (error) {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function chooseResolution(index, requested) {
  const available = Object.keys(index.resolutions || {}).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  if (!available.length) return null;
  const desired = Number(requested);
  if (!Number.isFinite(desired) || desired <= 0) return available[0];
  return available.find((height) => height <= desired) || available[available.length - 1];
}

export async function start(id, { resolution = 0, playbackRate = 1, startAt = 0 } = {}) {
  const index = await get(id);
  if (!index) throw new Error("prepared CDN cache not ready");
  const selectedResolution = chooseResolution(index, resolution);
  const rate = safeRate(playbackRate);
  const video = index.resolutions?.[String(selectedResolution)];
  const audio = index.audioRates?.[String(rate)];
  if (!video || !audio) throw new Error("requested prepared CDN variant is not ready");

  const duration = Number(index.duration) || 0;
  const requestedStartAt = Math.max(0, Number(startAt) || 0);
  const boundedStartAt = duration > 0 ? Math.min(requestedStartAt, Math.max(0, duration - 0.25)) : requestedStartAt;
  const startIndex = Math.max(1, Math.floor(boundedStartAt / index.segmentSourceSeconds) + 1);
  const segmentStartAt = (startIndex - 1) * index.segmentSourceSeconds;
  const segmentOffsetSourceSec = Math.max(0, boundedStartAt - segmentStartAt);
  const parseFrameRate = (value) => {
    const text = String(value || "");
    if (text.includes("/")) {
      const [n, d] = text.split("/").map(Number);
      if (Number.isFinite(n) && Number.isFinite(d) && d > 0) return n / d;
    }
    const n = Number(text);
    return Number.isFinite(n) ? n : 30;
  };

  return {
    id: `prepared-${safeId(id)}-${selectedResolution}-${rateKey(rate)}`,
    preparedStatic: true,
    cacheMode: "processed-static-fmp4",
    manifestReady: true,
    done: true,
    height: selectedResolution,
    fps: parseFrameRate(video.frameRate),
    startAt: segmentStartAt,
    requestedStartAt: boundedStartAt,
    segmentOffsetSourceSec,
    playbackRate: rate,
    duration,
    title: index.title,
    manifest: {
      durationSec: Math.max(0, duration - segmentStartAt),
      video: {
        id: "video",
        codec: video.codec,
        bandwidth: video.bandwidth,
        width: video.width,
        height: video.height,
        frameRate: video.frameRate,
      },
      audio: {
        id: "audio",
        codec: audio.codec,
        bandwidth: audio.bandwidth,
        width: null,
        height: null,
        frameRate: null,
      },
    },
    init: {
      video: `${video.dir}/${video.init}`,
      audio: `${audio.dir}/${audio.init}`,
    },
    staticTracks: {
      baseUrl: `/stream/processed-dash/${encodeURIComponent(safeId(id))}`,
      cacheVersion: index.preparedAt,
      segmentSourceSeconds: index.segmentSourceSeconds,
      video: {
        dir: video.dir,
        startIndex,
        totalSegments: video.segmentCount,
      },
      audio: {
        dir: audio.dir,
        startIndex: Math.min(startIndex, audio.segmentCount),
        totalSegments: audio.segmentCount,
      },
    },
  };
}

export function filePath(id, relativePath) {
  const cleanId = safeId(id);
  if (!cleanId) return null;
  const root = path.resolve(ROOT, cleanId);
  const relative = String(relativePath || "").replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return null;
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function remove(id) {
  const cleanId = safeId(id);
  if (!cleanId) return;
  await fs.rm(path.join(ROOT, cleanId), { recursive: true, force: true });
}
