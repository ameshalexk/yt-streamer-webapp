// ffmpeg -> multipart MJPEG (mpjpeg) piped straight to the HTTP response.
// The browser renders it in a plain <img src="/stream/...">. No HLS, no fallbacks.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { config } from "../config.js";

let active = 0;
const hlsSessions = new Map();
const audioHlsSessions = new Map();

export function activeStreamCount() {
  return active;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function summarizeFfmpegError(stderr) {
  const clean = stderr.split("\n").map((s) => s.trim()).filter(Boolean);
  const tail = clean.slice(-4).join(" | ") || "unknown ffmpeg error";
  if (/screen recording|not authorized|permission|TCC|cannot capture/i.test(stderr)) {
    return `macOS denied screen capture. Grant Screen Recording permission to the terminal/app running Node, then restart it. ${tail}`;
  }
  if (/403 Forbidden|access denied/i.test(stderr)) {
    return `source denied the stream (HTTP 403). VPN/geo-blocking or missing referer/user-agent is likely. ${tail}`;
  }
  if (/matches no streams|does not contain any stream|Output file does not contain any stream/i.test(stderr)) {
    return `source did not expose a playable video stream. VPN/geo-blocking or an offline channel is likely. ${tail}`;
  }
  return tail;
}

function pipeFfmpegOutput(req, res, ff, { headers, label, stderrLimit = 8000, onCleanup }) {
  let stderr = "";
  let started = false;
  let cleaned = false;

  const cleanup = (kill = true) => {
    if (cleaned) return;
    cleaned = true;
    try { ff.stdout.unpipe(res); } catch {}
    if (kill && !ff.killed) ff.kill("SIGKILL");
    onCleanup?.();
  };

  ff.stderr.on("data", (d) => {
    stderr += d;
    if (stderr.length > stderrLimit) stderr = stderr.slice(-stderrLimit);
  });

  ff.stdout.on("data", (chunk) => {
    if (cleaned || res.destroyed) return;
    if (!started) {
      started = true;
      res.writeHead(200, headers);
    }
    if (!res.write(chunk)) {
      ff.stdout.pause();
      res.once("drain", () => {
        if (!cleaned) ff.stdout.resume();
      });
    }
  });

  ff.stdout.on("end", () => {
    if (started && !res.destroyed) {
      try { res.end(); } catch {}
    }
  });

  ff.on("error", (e) => {
    console.error(`[${label}] ffmpeg error:`, e.message);
    if (!started && !res.headersSent) {
      res.status(500).type("text/plain").end(`ffmpeg failed to start: ${e.message}`);
    }
    cleanup(false);
  });

  ff.on("close", (code) => {
    if (cleaned) return;
    const summary = summarizeFfmpegError(stderr);
    if (code && code !== 0 && code !== 255) {
      console.error(`[${label}] ffmpeg exited ${code}: ${summary}`);
    }
    if (!started && !res.headersSent) {
      res.status(502).type("text/plain").end(`ffmpeg could not produce video output: ${summary}`);
    } else {
      try { res.end(); } catch {}
    }
    cleanup(false);
  });

  req.on("close", () => cleanup(true));
  res.on("close", () => cleanup(true));
}

// Target video bitrate (kbps) by height, before the quality multiplier.
const RATE_BY_HEIGHT = { 0: 3500, 240: 500, 360: 900, 480: 1600, 720: 3500, 1080: 6000 };
// Quality select values (4/7/12/18) -> x264 CRF + bitrate multiplier.
const QUALITY_MAP = {
  4: { crf: 20, mul: 1.3 }, 7: { crf: 23, mul: 1.0 }, 12: { crf: 27, mul: 0.6 }, 18: { crf: 30, mul: 0.45 },
};

export function normalizeParams(query = {}) {
  const m = config.mjpeg;
  let height = clampInt(query.height, 0, 2160, m.height);
  if (!m.allowedHeights.includes(height)) {
    height = m.allowedHeights
      .filter((h) => h !== 0)
      .reduce((a, b) => (Math.abs(b - height) < Math.abs(a - height) ? b : a), m.height);
  }
  const quality = clampInt(query.quality, m.minQuality, m.maxQuality, m.quality);
  const q = QUALITY_MAP[quality] || { crf: 25, mul: 0.8 };
  const maxrateK = Math.round((RATE_BY_HEIGHT[height] ?? 2500) * q.mul);
  return {
    quality,
    fps: clampInt(query.fps, m.minFps, m.maxFps, m.fps),
    height,
    crf: q.crf,
    maxrateK,
  };
}

function seekSeconds(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? Math.max(0, n) : 0;
}

function buildArgs({ input, audioInput, params, isLive, userAgent, referer, startAt = 0, paceInput = false }) {
  const vf = [];
  if (params.height && params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);

  const args = ["-hide_banner", "-loglevel", "error"];
  const seek = seekSeconds(startAt);

  // Reconnect logic + optional headers for flaky/protected network sources (HLS/HTTP).
  if (/^https?:\/\//i.test(input)) {
    if (userAgent) args.push("-user_agent", userAgent);
    if (referer) args.push("-headers", `Referer: ${referer}\r\n`);
    args.push(
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-rw_timeout", "15000000"
    );
  }
  // Pace inputs in real time so ffmpeg doesn't burst buffered media and make the client catch up.
  if (paceInput || isLive || !/^https?:\/\//i.test(input)) args.push("-re");
  if (seek) args.push("-ss", String(seek));

  args.push("-i", input);
  if (audioInput) args.push("-i", audioInput); // present but unused by mjpeg output

  args.push(
    "-an", // MJPEG carries no audio
    "-map", "0:v:0",
    "-vf", vf.join(","),
    "-q:v", String(params.quality),
    "-f", "mpjpeg",
    "pipe:1"
  );
  return args;
}

// Spawns ffmpeg and streams MJPEG to `res`. Cleans up on client disconnect.
// input: m3u8 URL, direct http(s) URL, or local file path.
export function streamMjpeg(req, res, { input, audioInput = null, params, isLive = false, userAgent = "", referer = "", startAt = 0, paceInput = false }) {
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;

  const args = buildArgs({ input, audioInput, params, isLive, userAgent, referer, startAt, paceInput });
  const ff = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  pipeFfmpegOutput(req, res, ff, {
    label: "stream",
    headers: {
      "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
    onCleanup: () => {
      active = Math.max(0, active - 1);
    },
  });
}

function buildDesktopArgs({ params }) {
  const vf = [];
  if (params.height && params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "avfoundation",
    "-framerate", String(params.fps),
  ];
  if (config.desktop.captureCursor) args.push("-capture_cursor", "1");
  if (config.desktop.captureClicks) args.push("-capture_mouse_clicks", "1");
  args.push(
    "-i", config.desktop.input,
    "-an",
    "-vf", vf.join(","),
    "-q:v", String(params.quality),
    "-f", "mpjpeg",
    "pipe:1"
  );
  return args;
}

function normalizeAudioInput(value) {
  const raw = String(value ?? config.desktop.audioInput ?? "").trim();
  if (!raw || raw === "none") return "";
  if (/^\d+$/.test(raw)) return `none:${raw}`;
  if (/^none:(\d+|[A-Za-z][^:]*)$/.test(raw)) return raw;
  if (/^[A-Za-z][^:]*$/.test(raw)) return `none:${raw}`;
  return "";
}

function desktopAvInput(audio) {
  const audioInput = normalizeAudioInput(audio).match(/^none:(.+)$/)?.[1] || "none";
  const videoInput = String(config.desktop.input || "0:none").split(":")[0] || "0";
  return `${videoInput}:${audioInput}`;
}

function buildDesktopAudioArgs({ audio }) {
  const input = normalizeAudioInput(audio);
  if (!input) return null;
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "avfoundation",
    "-i", input,
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-ar", "44100",
    "-write_xing", "0",
    "-flush_packets", "1",
    "-f", "mp3",
    "pipe:1",
  ];
}

export function streamDesktopMjpeg(req, res, { params }) {
  if (!config.desktop.enabled) {
    res.status(404).type("text/plain").end("Desktop streaming is disabled.");
    return;
  }
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;
  const ff = spawn(config.ffmpegPath, buildDesktopArgs({ params }), { stdio: ["ignore", "pipe", "pipe"] });
  pipeFfmpegOutput(req, res, ff, {
    label: "desktop",
    headers: {
      "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
    onCleanup: () => {
      active = Math.max(0, active - 1);
    },
  });
}

export function streamDesktopAudio(req, res, { audio }) {
  if (!config.desktop.enabled) {
    res.status(404).type("text/plain").end("Desktop streaming is disabled.");
    return;
  }
  const args = buildDesktopAudioArgs({ audio });
  if (!args) {
    res.status(404).type("text/plain").end("No desktop audio device selected.");
    return;
  }
  audioActive++;
  const ff = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  pipeFfmpegOutput(req, res, ff, {
    label: "desktop-audio",
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
    onCleanup: () => {
      audioActive = Math.max(0, audioActive - 1);
    },
  });
}

function buildDesktopTSArgs({ params, audio }) {
  const vf = [];
  if (params.height && params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);

  const hasAudio = Boolean(normalizeAudioInput(audio));
  const gop = Math.max(2, params.fps);
  const rate = `${params.maxrateK}k`;
  const bufsize = `${params.maxrateK * 2}k`;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-f", "avfoundation",
    "-framerate", String(params.fps),
  ];
  if (config.desktop.captureCursor) args.push("-capture_cursor", "1");
  if (config.desktop.captureClicks) args.push("-capture_mouse_clicks", "1");
  args.push("-i", desktopAvInput(audio), "-map", "0:v:0");
  if (hasAudio) args.push("-map", "0:a:0?");
  args.push("-vf", vf.join(","));

  if (config.video.encoder === "h264_videotoolbox") {
    args.push(
      "-c:v", "h264_videotoolbox", "-realtime", "1", "-pix_fmt", "yuv420p",
      "-b:v", rate, "-maxrate", rate, "-bufsize", bufsize
    );
  } else {
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
      "-crf", String(params.crf), "-maxrate", rate, "-bufsize", bufsize
    );
  }

  args.push("-g", String(gop), "-keyint_min", String(params.fps), "-sc_threshold", "0");
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", `${config.video.audioBitrateK}k`, "-ac", "2", "-ar", "44100");
  } else {
    args.push("-an");
  }
  args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  return args;
}

function buildDesktopMp4Args({ params, audio }) {
  const vf = [];
  if (params.height && params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);

  const hasAudio = Boolean(normalizeAudioInput(audio));
  const gop = Math.max(2, params.fps * 2);
  const rate = `${params.maxrateK}k`;
  const bufsize = `${params.maxrateK * 2}k`;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-f", "avfoundation",
    "-framerate", String(params.fps),
  ];
  if (config.desktop.captureCursor) args.push("-capture_cursor", "1");
  if (config.desktop.captureClicks) args.push("-capture_mouse_clicks", "1");
  args.push("-i", desktopAvInput(audio), "-map", "0:v:0");
  if (hasAudio) args.push("-map", "0:a:0?");
  args.push("-vf", vf.join(","));

  if (config.video.encoder === "h264_videotoolbox") {
    args.push(
      "-c:v", "h264_videotoolbox", "-realtime", "1", "-pix_fmt", "yuv420p",
      "-b:v", rate, "-maxrate", rate, "-bufsize", bufsize
    );
  } else {
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
      "-crf", String(params.crf), "-maxrate", rate, "-bufsize", bufsize
    );
  }

  args.push("-g", String(gop), "-keyint_min", String(params.fps), "-sc_threshold", "0");
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", `${config.video.audioBitrateK}k`, "-ac", "2", "-ar", "44100");
  } else {
    args.push("-an");
  }
  args.push(
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "500000",
    "pipe:1"
  );
  return args;
}

export function streamDesktopTS(req, res, { params, audio }) {
  if (!config.desktop.enabled) {
    res.status(404).type("text/plain").end("Desktop streaming is disabled.");
    return;
  }
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;
  const ff = spawn(config.ffmpegPath, buildDesktopTSArgs({ params, audio }), { stdio: ["ignore", "pipe", "pipe"] });
  pipeFfmpegOutput(req, res, ff, {
    label: "desktop-ts",
    headers: {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
    onCleanup: () => {
      active = Math.max(0, active - 1);
    },
  });
}

export function streamDesktopMp4(req, res, { params, audio }) {
  if (!config.desktop.enabled) {
    res.status(404).type("text/plain").end("Desktop streaming is disabled.");
    return;
  }
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;
  const ff = spawn(config.ffmpegPath, buildDesktopMp4Args({ params, audio }), { stdio: ["ignore", "pipe", "pipe"] });
  pipeFfmpegOutput(req, res, ff, {
    label: "desktop-mp4",
    headers: {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
    onCleanup: () => {
      active = Math.max(0, active - 1);
    },
  });
}

function hlsRoot() {
  return path.join(config.dataDir, "desktop-hls");
}

function audioHlsRoot() {
  return path.join(config.dataDir, "desktop-audio-hls");
}

function buildDesktopHlsArgs({ params, audio, playlistPath, segmentPattern }) {
  const vf = [];
  if (params.height && params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);

  const hasAudio = Boolean(normalizeAudioInput(audio));
  const gop = Math.max(2, params.fps * 2);
  const rate = `${params.maxrateK}k`;
  const bufsize = `${params.maxrateK * 2}k`;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-use_wallclock_as_timestamps", "1",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-f", "avfoundation",
    "-framerate", String(params.fps),
  ];
  if (config.desktop.captureCursor) args.push("-capture_cursor", "1");
  if (config.desktop.captureClicks) args.push("-capture_mouse_clicks", "1");
  args.push("-i", desktopAvInput(audio), "-map", "0:v:0");
  if (hasAudio) args.push("-map", "0:a:0?");
  args.push("-vf", vf.join(","));

  if (config.video.encoder === "h264_videotoolbox") {
    args.push(
      "-c:v", "h264_videotoolbox", "-realtime", "1", "-pix_fmt", "yuv420p",
      "-b:v", rate, "-maxrate", rate, "-bufsize", bufsize
    );
  } else {
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
      "-crf", String(params.crf), "-maxrate", rate, "-bufsize", bufsize
    );
  }

  args.push("-g", String(gop), "-keyint_min", String(params.fps), "-sc_threshold", "0");
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", `${config.video.audioBitrateK}k`, "-ac", "2", "-ar", "44100");
  } else {
    args.push("-an");
  }
  args.push(
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", "6",
    "-hls_flags", "delete_segments+omit_endlist+independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    playlistPath
  );
  return args;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function waitForHlsReady(session, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.closed) throw httpError(502, `Desktop HLS stopped before it was ready: ${summarizeFfmpegError(session.stderr)}`);
    try {
      const text = await fs.readFile(session.playlistPath, "utf8");
      if (/seg-\d+\.ts/.test(text)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw httpError(504, "Desktop HLS did not become ready in time.");
}

async function removeHlsSession(session) {
  if (!session || session.cleaned) return;
  session.cleaned = true;
  hlsSessions.delete(session.id);
  if (session.timer) clearTimeout(session.timer);
  try { session.ff?.stdout?.unpipe(session.segmenter?.stdin); } catch {}
  try { session.segmenter?.stdin?.destroy(); } catch {}
  for (const proc of [session.ff, session.segmenter]) {
    if (proc && !proc.killed) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }
  active = Math.max(0, active - 1);
  await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

export async function startDesktopHls({ params, audio }) {
  if (!config.desktop.enabled) throw httpError(404, "Desktop streaming is disabled.");
  if (active >= config.maxConcurrentStreams) throw httpError(429, "Too many active streams. Stop one and retry.");

  await fs.mkdir(hlsRoot(), { recursive: true });
  const id = crypto.randomUUID().slice(0, 12);
  const dir = path.join(hlsRoot(), id);
  await fs.mkdir(dir, { recursive: true });
  const playlistPath = path.join(dir, "live.m3u8");
  const segmentPattern = path.join(dir, "seg-%05d.ts");
  const session = {
    id, dir, playlistPath, stderr: "", closed: false, cleaned: false, ff: null, segmenter: null, timer: null,
  };
  active++;
  session.ff = spawn(config.ffmpegPath, buildDesktopTSArgs({ params, audio }), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.segmenter = spawn(config.ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", "6",
    "-hls_flags", "delete_segments+omit_endlist+independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    playlistPath,
  ], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  session.ff.stdout.pipe(session.segmenter.stdin);
  session.ff.stdout.on("error", (e) => {
    if (e.code !== "EPIPE") session.stderr += `\n${e.message}`;
  });
  session.segmenter.stdin.on("error", (e) => {
    if (e.code !== "EPIPE") session.stderr += `\n${e.message}`;
  });
  hlsSessions.set(id, session);
  session.timer = setTimeout(() => {
    removeHlsSession(session).catch(() => {});
  }, 30 * 60 * 1000);
  session.ff.stderr.on("data", (d) => {
    session.stderr += d;
    if (session.stderr.length > 8000) session.stderr = session.stderr.slice(-8000);
  });
  session.segmenter.stderr.on("data", (d) => {
    session.stderr += d;
    if (session.stderr.length > 8000) session.stderr = session.stderr.slice(-8000);
  });
  session.ff.on("error", (e) => {
    session.stderr += `\n${e.message}`;
    session.closed = true;
  });
  session.segmenter.on("error", (e) => {
    session.stderr += `\n${e.message}`;
    session.closed = true;
  });
  session.ff.on("close", (code) => {
    session.closed = true;
    if (code && code !== 0 && code !== 255) {
      console.error(`[desktop-hls] ffmpeg exited ${code}: ${summarizeFfmpegError(session.stderr)}`);
    }
  });
  session.segmenter.on("close", (code) => {
    session.closed = true;
    if (code && code !== 0 && code !== 255) {
      console.error(`[desktop-hls] segmenter exited ${code}: ${summarizeFfmpegError(session.stderr)}`);
    }
  });
  try {
    await waitForHlsReady(session);
    return { id, url: `/stream/hls/desktop/${id}/live.m3u8` };
  } catch (err) {
    await removeHlsSession(session);
    throw err;
  }
}

export async function stopDesktopHls(id) {
  const session = hlsSessions.get(id);
  if (!session) return false;
  await removeHlsSession(session);
  return true;
}

export function desktopHlsFilePath(id, file) {
  if (!/^[a-f0-9-]{12}$/i.test(String(id || ""))) return null;
  if (!/^(live\.m3u8|seg-\d+\.ts)$/.test(String(file || ""))) return null;
  const session = hlsSessions.get(id);
  if (!session) return null;
  const resolved = path.resolve(session.dir, file);
  if (!resolved.startsWith(path.resolve(session.dir) + path.sep)) return null;
  if (!fssync.existsSync(resolved)) return null;
  return resolved;
}

async function waitForAudioHlsReady(session, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.closed) throw httpError(502, `Desktop audio HLS stopped before it was ready: ${summarizeFfmpegError(session.stderr)}`);
    try {
      const text = await fs.readFile(session.playlistPath, "utf8");
      if (/seg-\d+\.ts/.test(text)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw httpError(504, "Desktop audio HLS did not become ready in time.");
}

async function removeAudioHlsSession(session) {
  if (!session || session.cleaned) return;
  session.cleaned = true;
  audioHlsSessions.delete(session.id);
  if (session.timer) clearTimeout(session.timer);
  if (session.ff && !session.ff.killed) {
    try { session.ff.kill("SIGKILL"); } catch {}
  }
  audioActive = Math.max(0, audioActive - 1);
  await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

function buildDesktopAudioHlsArgs({ audio, playlistPath, segmentPattern }) {
  const input = normalizeAudioInput(audio);
  if (!input) return null;
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "avfoundation",
    "-i", input,
    "-vn",
    "-c:a", "aac",
    "-b:a", `${config.video.audioBitrateK}k`,
    "-ac", "2",
    "-ar", "44100",
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", "6",
    "-hls_flags", "delete_segments+omit_endlist",
    "-hls_segment_filename", segmentPattern,
    playlistPath,
  ];
}

export async function startDesktopAudioHls({ audio }) {
  if (!config.desktop.enabled) throw httpError(404, "Desktop streaming is disabled.");
  const argsInput = normalizeAudioInput(audio);
  if (!argsInput) throw httpError(400, "No desktop audio device selected.");
  if (audioActive >= config.maxConcurrentStreams) throw httpError(429, "Too many active audio streams. Stop one and retry.");

  await fs.mkdir(audioHlsRoot(), { recursive: true });
  const id = crypto.randomUUID().slice(0, 12);
  const dir = path.join(audioHlsRoot(), id);
  await fs.mkdir(dir, { recursive: true });
  const playlistPath = path.join(dir, "live.m3u8");
  const segmentPattern = path.join(dir, "seg-%05d.ts");
  const session = {
    id, dir, playlistPath, stderr: "", closed: false, cleaned: false, ff: null, timer: null,
  };
  const args = buildDesktopAudioHlsArgs({ audio, playlistPath, segmentPattern });
  audioActive++;
  session.ff = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  audioHlsSessions.set(id, session);
  session.timer = setTimeout(() => {
    removeAudioHlsSession(session).catch(() => {});
  }, 30 * 60 * 1000);
  session.ff.stderr.on("data", (d) => {
    session.stderr += d;
    if (session.stderr.length > 8000) session.stderr = session.stderr.slice(-8000);
  });
  session.ff.on("error", (e) => {
    session.stderr += `\n${e.message}`;
    session.closed = true;
  });
  session.ff.on("close", (code) => {
    session.closed = true;
    if (code && code !== 0 && code !== 255) {
      console.error(`[desktop-audio-hls] ffmpeg exited ${code}: ${summarizeFfmpegError(session.stderr)}`);
    }
  });
  try {
    await waitForAudioHlsReady(session);
    return { id, url: `/stream/hls/desktop-audio/${id}/live.m3u8` };
  } catch (err) {
    await removeAudioHlsSession(session);
    throw err;
  }
}

export async function stopDesktopAudioHls(id) {
  const session = audioHlsSessions.get(id);
  if (!session) return false;
  await removeAudioHlsSession(session);
  return true;
}

export function desktopAudioHlsFilePath(id, file) {
  if (!/^[a-f0-9-]{12}$/i.test(String(id || ""))) return null;
  if (!/^(live\.m3u8|seg-\d+\.ts)$/.test(String(file || ""))) return null;
  const session = audioHlsSessions.get(id);
  if (!session) return null;
  const resolved = path.resolve(session.dir, file);
  if (!resolved.startsWith(path.resolve(session.dir) + path.sep)) return null;
  if (!fssync.existsSync(resolved)) return null;
  return resolved;
}

function recommendedDesktopAudio(audioDevices) {
  const preferred = [
    /blackhole/i,
    /virtual desktop speakers/i,
    /loopback/i,
    /soundflower/i,
    /reincubate/i,
  ].map((pattern) => audioDevices.find((d) => pattern.test(d.name))).find(Boolean);
  const configured = normalizeAudioInput(config.desktop.audioInput).match(/^none:(.+)$/)?.[1] || "";
  const configuredDevice = configured ? audioDevices.find((d) => String(d.index) === configured) : null;
  return preferred ? String(preferred.index) : (configuredDevice ? String(configuredDevice.index) : configured);
}

export function listDesktopSources(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!config.desktop.enabled) {
      resolve({ enabled: false, input: config.desktop.input, video: [], audio: [] });
      return;
    }
    const ff = spawn(config.ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      ff.kill("SIGKILL");
      resolve({ enabled: true, input: config.desktop.input, video: [], audio: [], error: "device probe timed out" });
    }, timeoutMs);
    ff.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    ff.on("error", (e) => {
      clearTimeout(timer);
      resolve({ enabled: true, input: config.desktop.input, video: [], audio: [], error: e.message });
    });
    ff.on("close", () => {
      clearTimeout(timer);
      const audio = parseAvfoundationDevices(stderr, "audio");
      resolve({
        enabled: true,
        input: config.desktop.input,
        video: parseAvfoundationDevices(stderr, "video"),
        audio,
        recommendedAudio: recommendedDesktopAudio(audio),
      });
    });
  });
}

function parseAvfoundationDevices(stderr, kind) {
  const lines = stderr.split("\n");
  const startRe = new RegExp(`AVFoundation ${kind} devices:`, "i");
  const otherRe = /AVFoundation (video|audio) devices:/i;
  const deviceRe = /\[(\d+)\]\s+(.+)$/;
  const out = [];
  let activeKind = false;
  for (const line of lines) {
    if (startRe.test(line)) {
      activeKind = true;
      continue;
    }
    if (otherRe.test(line)) {
      activeKind = false;
      continue;
    }
    if (!activeKind) continue;
    const match = line.match(deviceRe);
    if (match) out.push({ index: Number(match[1]), name: match[2].trim() });
  }
  return out;
}

// ---- Single synced stream: H.264 + AAC in MPEG-TS (for mpegts.js / MSE) ----
function buildTSArgs({ input, params, isLive, userAgent, referer, paceInput = false, startAt = 0 }) {
  const isHttp = /^https?:\/\//i.test(input);
  const args = ["-hide_banner", "-loglevel", "error"];
  const seek = seekSeconds(startAt);
  if (isHttp) {
    if (userAgent) args.push("-user_agent", userAgent);
    if (referer) args.push("-headers", `Referer: ${referer}\r\n`);
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "15000000");
    if (isLive) args.push("-fflags", "nobuffer", "-flags", "low_delay");
  }
  if (paceInput || isLive || !isHttp) args.push("-re"); // pace inputs in real time
  if (seek) args.push("-ss", String(seek));

  args.push("-i", input);

  const vf = [];
  if (params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);
  const gop = Math.max(2, params.fps * 2);
  const rate = `${params.maxrateK}k`;
  const bufsize = `${params.maxrateK * 2}k`;

  args.push("-map", "0:v:0", "-map", "0:a:0?", "-vf", vf.join(","));

  if (config.video.encoder === "h264_videotoolbox") {
    // Mac hardware encoder: bitrate-based, very light CPU.
    args.push(
      "-c:v", "h264_videotoolbox", "-realtime", "1", "-pix_fmt", "yuv420p",
      "-b:v", rate, "-maxrate", rate, "-bufsize", bufsize
    );
  } else {
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
      "-crf", String(params.crf), "-maxrate", rate, "-bufsize", bufsize
    );
  }
  args.push(
    "-g", String(gop), "-keyint_min", String(params.fps), "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", `${config.video.audioBitrateK}k`, "-ac", "2", "-ar", "44100",
    "-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1"
  );
  return args;
}

// Streams MPEG-TS (synced A/V) to `res`. One ffmpeg per playback.
export function streamTS(req, res, { input, params, isLive = false, userAgent = "", referer = "", paceInput = false, startAt = 0 }) {
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;
  const ff = spawn(config.ffmpegPath, buildTSArgs({ input, params, isLive, userAgent, referer, paceInput, startAt }), { stdio: ["ignore", "pipe", "pipe"] });
  pipeFfmpegOutput(req, res, ff, {
    label: "ts",
    headers: {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
    onCleanup: () => {
      active = Math.max(0, active - 1);
    },
  });
}

// ---- Audio: a separate mp3 stream played alongside the MJPEG video ----
let audioActive = 0;
export function activeAudioCount() { return audioActive; }

function buildAudioArgs({ input, userAgent, referer, isLive, startAt = 0 }) {
  const args = ["-hide_banner", "-loglevel", "error"];
  const seek = seekSeconds(startAt);
  if (/^https?:\/\//i.test(input)) {
    if (userAgent) args.push("-user_agent", userAgent);
    if (referer) args.push("-headers", `Referer: ${referer}\r\n`);
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "15000000");
  }
  if (!isLive && !/^https?:\/\//i.test(input)) args.push("-re");
  if (seek) args.push("-ss", String(seek));
  args.push("-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-f", "mp3", "pipe:1");
  return args;
}

// Streams mp3 audio to `res`. Tolerant of sources with no audio track (just ends).
export function streamAudio(req, res, { input, userAgent = "", referer = "", isLive = false, startAt = 0 }) {
  audioActive++;
  const ff = spawn(config.ffmpegPath, buildAudioArgs({ input, userAgent, referer, isLive, startAt }), { stdio: ["ignore", "pipe", "pipe"] });
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "close",
    "X-Accel-Buffering": "no",
  });
  ff.stdout.pipe(res);
  let stderr = "";
  ff.stderr.on("data", (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  const cleanup = () => {
    audioActive = Math.max(0, audioActive - 1);
    try { ff.stdout.unpipe(res); } catch {}
    if (!ff.killed) ff.kill("SIGKILL");
  };
  ff.on("error", () => { if (!res.headersSent) res.status(500).end(); cleanup(); });
  ff.on("close", () => { try { res.end(); } catch {} cleanup(); });
  req.on("close", cleanup);
  res.on("close", cleanup);
}

// Quick probe used by the UI to validate an m3u8/url before saving.
export function probe(input, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-loglevel", "error", "-rw_timeout", "10000000", "-i", input, "-t", "0.1", "-f", "null", "-"];
    const ff = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => { ff.kill("SIGKILL"); resolve({ ok: false, error: "probe timed out" }); }, timeoutMs);
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    ff.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.split("\n").filter(Boolean).pop() || "unplayable" });
    });
  });
}
