import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const sessions = new Map();
const IDLE_TTL_MS = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);
let initialBurstSupport;

// The HA image ships FFmpeg 5.1; newer Mac FFmpeg builds expose this option.
// Probe the actual binary once rather than assuming support from the platform.
async function supportsInitialBurst() {
  initialBurstSupport ??= execFileAsync(config.ffmpegPath, ["-hide_banner", "-h", "full"], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  }).then(({ stdout }) => /^-readrate_initial_burst\s/m.test(stdout)).catch(() => false);
  return initialBurstSupport;
}

function rootDir() {
  return path.join(config.dataDir, "cyberdash-dash");
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function safeSeek(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function safePlaybackRate(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, parsed));
}

function bitrateForHeight(height) {
  if (height >= 1080) return { target: 4500, max: 5500 };
  if (height >= 720) return { target: 2500, max: 3200 };
  if (height >= 480) return { target: 1400, max: 1900 };
  return { target: 850, max: 1200 };
}

export function buildCyberdashDashArgs({
  videoInput,
  audioInput = null,
  height = 720,
  fps = 30,
  startAt = 0,
  playbackRate = 1,
  encoder = config.video.dashEncoder,
  initialBurstSupported = true,
  manifestPath,
}) {
  if (!videoInput) throw new Error("video input required");
  if (!manifestPath) throw new Error("manifest path required");

  const outHeight = clampInt(height, 240, 1080, 720);
  const outFps = clampInt(fps, 5, 60, 30);
  const seek = safeSeek(startAt);
  const rate = bitrateForHeight(outHeight);
  const speed = safePlaybackRate(playbackRate);
  // Keep a large producer margin at fast playback. YouTube normally reads pre-encoded
  // segments much faster than real time; our live transcode needs similar headroom so a brief
  // network/decoder hiccup does not immediately drain the client buffer.
  const inputReadRate = speed > 1
    ? Math.min(5, Math.max(1.6, speed * 1.6))
    : 1.15;
  const initialBurst = speed > 1
    ? Math.min(15, Math.max(6, speed * 5))
    : 4;
  const args = ["-hide_banner", "-loglevel", "warning", "-y"];
  const addInput = (input) => {
    if (seek) args.push("-ss", String(seek));
    args.push("-readrate", String(inputReadRate));
    if (initialBurstSupported) args.push("-readrate_initial_burst", String(initialBurst));
    args.push("-i", String(input));
  };

  addInput(videoInput);
  if (audioInput) addInput(audioInput);

  args.push("-map", "0:v:0");
  args.push("-map", audioInput ? "1:a:0" : "0:a:0?");

  args.push(
    "-vf", `scale=-2:${outHeight},fps=${outFps}`,
    "-c:v", encoder,
    "-pix_fmt", "yuv420p",
    "-b:v", `${rate.target}k`,
    "-maxrate", `${rate.max}k`,
    "-bufsize", `${rate.max * 2}k`,
    "-g", String(outFps),
    // Speed audio on the server with FFmpeg's time-stretch filter. Unlike
    // AudioBufferSourceNode.playbackRate, atempo preserves speech pitch.
    "-af", `atempo=${speed}`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-f", "dash",
    "-seg_duration", "1",
    "-frag_duration", "1",
    "-use_template", "1",
    "-use_timeline", "1",
    "-window_size", "0",
    "-extra_window_size", "0",
    "-remove_at_exit", "0",
    "-init_seg_name", "init-$RepresentationID$.m4s",
    "-media_seg_name", "chunk-$RepresentationID$-$Number%05d$.m4s",
    "-adaptation_sets", "id=0,streams=v id=1,streams=a",
    manifestPath,
  );

  return args;
}

export function parseDashManifest(text = "") {
  const manifest = String(text || "");
  const durationText = (manifest.match(/mediaPresentationDuration="([^"]+)"/) || [])[1] || "";
  const durationMatch = durationText.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  const durationSec = durationMatch
    ? (Number(durationMatch[1] || 0) * 3600) + (Number(durationMatch[2] || 0) * 60) + Number(durationMatch[3] || 0)
    : null;
  const adaptationSets = [...manifest.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)];
  const result = {
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    video: null,
    audio: null,
  };

  for (const match of adaptationSets) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const contentType = (attrs.match(/contentType="([^"]+)"/) || [])[1] || "";
    const mimeType = (attrs.match(/mimeType="([^"]+)"/) || [])[1] || "";
    const kind = contentType || (mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "");
    if (kind !== "video" && kind !== "audio") continue;

    const rep = body.match(/<Representation\b([^>]*)>/);
    if (!rep) continue;
    const repAttrs = rep[1] || "";
    const id = (repAttrs.match(/\bid="([^"]+)"/) || [])[1] || null;
    const codec =
      (repAttrs.match(/\bcodecs="([^"]+)"/) || [])[1] ||
      (attrs.match(/\bcodecs="([^"]+)"/) || [])[1] ||
      null;
    const bandwidth = Number((repAttrs.match(/\bbandwidth="([0-9]+)"/) || [])[1]) || null;
    const width = Number((repAttrs.match(/\bwidth="([0-9]+)"/) || [])[1]) || null;
    const height = Number((repAttrs.match(/\bheight="([0-9]+)"/) || [])[1]) || null;
    const frameRate =
      (repAttrs.match(/\bframeRate="([^"]+)"/) || [])[1] ||
      (attrs.match(/\bframeRate="([^"]+)"/) || [])[1] ||
      null;
    result[kind] = { id, codec, bandwidth, width, height, frameRate };
  }

  return result;
}

function summarizeError(stderr) {
  const lines = String(stderr || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-6).join(" | ").slice(0, 1600) || "ffmpeg exited without output";
}

async function listSessionFiles(session) {
  let names = [];
  try {
    names = await fs.readdir(session.dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let manifestText = "";
  if (names.includes("manifest.mpd")) {
    try {
      manifestText = await fs.readFile(path.join(session.dir, "manifest.mpd"), "utf8");
    } catch {}
  }
  const manifest = parseDashManifest(manifestText);

  const segmentNames = (repId) => {
    if (repId == null) return [];
    const prefix = `chunk-${repId}-`;
    return names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".m4s"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  };

  return {
    manifestReady: names.includes("manifest.mpd"),
    manifest,
    init: {
      video: manifest.video?.id != null && names.includes(`init-${manifest.video.id}.m4s`) ? `init-${manifest.video.id}.m4s` : null,
      audio: manifest.audio?.id != null && names.includes(`init-${manifest.audio.id}.m4s`) ? `init-${manifest.audio.id}.m4s` : null,
    },
    available: {
      video: segmentNames(manifest.video?.id),
      audio: segmentNames(manifest.audio?.id),
    },
  };
}

async function pruneIdleSessions() {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastAccessAt >= cutoff && !session.stopped) continue;
    if (session.child && !session.closed) {
      try { session.child.kill("SIGKILL"); } catch {}
    }
    sessions.delete(id);
    try { await fs.rm(session.dir, { recursive: true, force: true }); } catch {}
  }
}

export async function startYouTubeDashSession({
  videoInput,
  audioInput = null,
  sourceUrl = "",
  height = 720,
  fps = 30,
  startAt = 0,
  playbackRate = 1,
} = {}) {
  await pruneIdleSessions();
  await fs.mkdir(rootDir(), { recursive: true });

  const id = crypto.randomBytes(12).toString("base64url");
  const dir = path.join(rootDir(), id);
  await fs.mkdir(dir, { recursive: true });

  const manifestPath = path.join(dir, "manifest.mpd");
  const args = buildCyberdashDashArgs({
    videoInput,
    audioInput,
    height,
    fps,
    startAt,
    playbackRate,
    manifestPath,
    initialBurstSupported: await supportsInitialBurst(),
  });

  const now = Date.now();
  const session = {
    id,
    dir,
    sourceUrl: String(sourceUrl || ""),
    height: clampInt(height, 240, 1080, 720),
    fps: clampInt(fps, 5, 60, 30),
    startAt: safeSeek(startAt),
    playbackRate: safePlaybackRate(playbackRate),
    createdAt: now,
    lastAccessAt: now,
    stderr: "",
    child: null,
    closed: false,
    stopped: false,
    exitCode: null,
    error: null,
  };
  sessions.set(id, session);

  const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  session.child = child;

  child.stderr.on("data", (chunk) => {
    session.stderr += chunk.toString();
    if (session.stderr.length > 12000) session.stderr = session.stderr.slice(-12000);
  });
  child.on("error", (error) => {
    session.error = `ffmpeg failed to start: ${error.message}`;
    session.closed = true;
  });
  child.on("close", (code) => {
    session.exitCode = code;
    session.closed = true;
    if (!session.stopped && code && code !== 0 && code !== 255) {
      session.error = summarizeError(session.stderr);
    }
  });

  return {
    id,
    height: session.height,
    fps: session.fps,
    startAt: session.startAt,
    playbackRate: session.playbackRate,
    statusUrl: `/api/experimental/cyberdash/${id}/status`,
    manifestUrl: `/stream/experimental/cyberdash/${id}/manifest.mpd`,
  };
}

export async function getSessionStatus(id) {
  await pruneIdleSessions();
  const session = sessions.get(String(id || ""));
  if (!session) return null;
  session.lastAccessAt = Date.now();
  const files = await listSessionFiles(session);
  return {
    id: session.id,
    state: session.error ? "error" : session.closed ? "done" : "running",
    done: session.closed,
    stopped: session.stopped,
    exitCode: session.exitCode,
    error: session.error,
    height: session.height,
    fps: session.fps,
    startAt: session.startAt,
    playbackRate: session.playbackRate,
    createdAt: session.createdAt,
    ...files,
  };
}

export async function stopSession(id, { removeFiles = true } = {}) {
  const session = sessions.get(String(id || ""));
  if (!session) return false;
  session.stopped = true;
  session.lastAccessAt = 0;
  if (session.child && !session.closed) {
    try { session.child.kill("SIGKILL"); } catch {}
  }
  sessions.delete(session.id);
  if (removeFiles) {
    try { await fs.rm(session.dir, { recursive: true, force: true }); } catch {}
  }
  return true;
}

export function sessionFilePath(id, file) {
  const session = sessions.get(String(id || ""));
  if (!session) return null;
  const name = String(file || "");
  if (!/^(manifest\.mpd|init-[A-Za-z0-9_.-]+\.m4s|chunk-[A-Za-z0-9_.-]+\.m4s)$/.test(name)) return null;
  const resolved = path.resolve(session.dir, name);
  if (!resolved.startsWith(path.resolve(session.dir) + path.sep)) return null;
  session.lastAccessAt = Date.now();
  return resolved;
}

export async function cleanupStaleDashFiles() {
  for (const session of sessions.values()) {
    if (session.child && !session.closed) {
      try { session.child.kill("SIGKILL"); } catch {}
    }
  }
  sessions.clear();
  await fs.rm(rootDir(), { recursive: true, force: true });
  await fs.mkdir(rootDir(), { recursive: true });
}

export function activeSessionCount() {
  return sessions.size;
}
