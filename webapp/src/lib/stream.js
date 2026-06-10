// ffmpeg -> multipart MJPEG (mpjpeg) piped straight to the HTTP response.
// The browser renders it in a plain <img src="/stream/...">. No HLS, no fallbacks.
import { spawn } from "node:child_process";
import { config } from "../config.js";

let active = 0;

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

function buildArgs({ input, audioInput, params, isLive, userAgent, referer }) {
  const vf = [];
  if (params.height && params.height > 0) vf.push(`scale=-2:${params.height}`);
  vf.push(`fps=${params.fps}`);

  const args = ["-hide_banner", "-loglevel", "error"];

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
  if (isLive || !/^https?:\/\//i.test(input)) args.push("-re");

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
export function streamMjpeg(req, res, { input, audioInput = null, params, isLive = false, userAgent = "", referer = "" }) {
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;

  const args = buildArgs({ input, audioInput, params, isLive, userAgent, referer });
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

// ---- Single synced stream: H.264 + AAC in MPEG-TS (for mpegts.js / MSE) ----
function buildTSArgs({ input, params, isLive, userAgent, referer }) {
  const isHttp = /^https?:\/\//i.test(input);
  const args = ["-hide_banner", "-loglevel", "error"];
  if (isHttp) {
    if (userAgent) args.push("-user_agent", userAgent);
    if (referer) args.push("-headers", `Referer: ${referer}\r\n`);
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "15000000");
    if (isLive) args.push("-fflags", "nobuffer", "-flags", "low_delay");
  }
  if (isLive || !isHttp) args.push("-re"); // pace inputs in real time

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
export function streamTS(req, res, { input, params, isLive = false, userAgent = "", referer = "" }) {
  if (active >= config.maxConcurrentStreams) {
    res.status(429).type("text/plain").end("Too many active streams. Stop one and retry.");
    return;
  }
  active++;
  const ff = spawn(config.ffmpegPath, buildTSArgs({ input, params, isLive, userAgent, referer }), { stdio: ["ignore", "pipe", "pipe"] });
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

function buildAudioArgs({ input, userAgent, referer, isLive }) {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (/^https?:\/\//i.test(input)) {
    if (userAgent) args.push("-user_agent", userAgent);
    if (referer) args.push("-headers", `Referer: ${referer}\r\n`);
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-rw_timeout", "15000000");
  }
  if (!isLive && !/^https?:\/\//i.test(input)) args.push("-re");
  args.push("-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-f", "mp3", "pipe:1");
  return args;
}

// Streams mp3 audio to `res`. Tolerant of sources with no audio track (just ends).
export function streamAudio(req, res, { input, userAgent = "", referer = "", isLive = false }) {
  audioActive++;
  const ff = spawn(config.ffmpegPath, buildAudioArgs({ input, userAgent, referer, isLive }), { stdio: ["ignore", "pipe", "pipe"] });
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
