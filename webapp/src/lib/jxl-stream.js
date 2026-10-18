// Experimental JPEG XL frame transport. This never replaces the MJPEG/MPEG-TS paths.
// FFmpeg's tee muxer emits the same encoded packets as raw JXL bytes (fd 1)
// and framecrc packet-length records (fd 3). The two streams are reassembled
// into length-delimited multipart image/jxl frames for buffered canvas playback.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BOUNDARY = "ytstreamer-jxl";
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_PENDING = 20 * 1024 * 1024;
let cachedStatus = null;

// JXL requires an explicitly configured *separate* absolute executable.
// This branch must never silently pick the production/Homebrew FFmpeg.
export function jxlFfmpegPath() {
  const candidate = (process.env.JXL_FFMPEG_PATH || "").trim();
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    if (!fs.statSync(candidate).isFile()) return null;
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

export function jxlEncoderStatus() {
  const ffmpegPath = jxlFfmpegPath();
  if (!ffmpegPath) {
    return {
      available: false,
      reason: "JPEG XL requires an explicitly configured absolute JXL_FFMPEG_PATH to a separate libjxl-enabled FFmpeg.",
    };
  }
  if (cachedStatus?.path === ffmpegPath && Date.now() - cachedStatus.at < 30_000) {
    return cachedStatus.value;
  }
  const probe = spawnSync(ffmpegPath, ["-hide_banner", "-encoders"], {
    timeout: 4000, encoding: "utf8", maxBuffer: 1_000_000,
  });
  const available = probe.status === 0 && /^\s*V\S*\s+libjxl\s/m.test(probe.stdout || "");
  const value = {
    available,
    reason: available ? null : "The configured JXL_FFMPEG_PATH does not provide libjxl encoding.",
  };
  cachedStatus = { path: ffmpegPath, at: Date.now(), value };
  return value;
}

export function buildJxlArgs(baseArgs, quality = 7) {
  if (baseArgs.slice(-5).join("|").includes("-q:v") === false ||
      baseArgs.at(-2) !== "mpjpeg" || baseArgs.at(-1) !== "pipe:1") {
    throw new Error("Unexpected MJPEG FFmpeg argument layout");
  }
  const distance = Math.max(0.5, Math.min(5, 1.1 + (Number(quality) || 7) * 0.21));
  return [
    ...baseArgs.slice(0, -5),
    "-pix_fmt", "rgb24", "-c:v", "libjxl",
    "-distance", String(Math.round(distance * 10) / 10),
    "-effort", "1", "-threads", "2",
    "-f", "tee", "[f=image2pipe]pipe:1|[f=framecrc]pipe:3",
  ];
}

export function frameSizeFromCrcLine(line) {
  const trimmed = String(line).trim();
  if (!/^\d+\s*,/.test(trimmed)) return null; // framecrc headers start with #
  const parts = trimmed.split(",").map((part) => part.trim());
  const size = Number(parts[4]);
  if (parts.length < 6 || !Number.isSafeInteger(size) || size <= 0 || size > MAX_FRAME) {
    throw new Error("Invalid or excessive JXL frame size in framecrc");
  }
  return size;
}

export function multipartJxlFrame(frame) {
  const header = Buffer.from(
    "--" + BOUNDARY + "\r\nContent-Type: image/jxl\r\nContent-Length: " +
    frame.length + "\r\n\r\n", "ascii"
  );
  return Buffer.concat([header, frame, Buffer.from("\r\n")]);
}

export class JxlFrameAssembler {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.sizes = [];
    this.chunks = [];
    this.bytes = 0;
    this.count = 0;
    this.metaBuffer = "";
  }

  metadata(chunk) {
    this.metaBuffer += chunk.toString("utf8");
    if (this.metaBuffer.length > 16_384) throw new Error("JXL frame index overflow");
    let newline;
    while ((newline = this.metaBuffer.indexOf("\n")) !== -1) {
      const line = this.metaBuffer.slice(0, newline).trim();
      this.metaBuffer = this.metaBuffer.slice(newline + 1);
      const size = frameSizeFromCrcLine(line);
      if (size != null) this.sizes.push(size);
    }
    this.drain();
  }

  data(chunk) {
    this.bytes += chunk.length;
    if (this.bytes > MAX_PENDING) throw new Error("JXL frame buffer limit exceeded");
    this.chunks.push(chunk);
    this.drain();
  }

  drain() {
    while (this.sizes.length && this.bytes >= this.sizes[0]) {
      let left = this.sizes.shift();
      const pieces = [];
      while (left > 0) {
        const chunk = this.chunks[0];
        if (chunk.length <= left) {
          pieces.push(chunk);
          this.chunks.shift();
          left -= chunk.length;
        } else {
          pieces.push(chunk.subarray(0, left));
          this.chunks[0] = chunk.subarray(left);
          left = 0;
        }
      }
      const frame = Buffer.concat(pieces);
      this.bytes -= frame.length;
      this.count++;
      this.onFrame(frame);
    }
  }
}

export function streamJxl(req, res, options, buildBaseArgs, onCleanup = () => {}) {
  const status = jxlEncoderStatus();
  if (!status.available) {
    res.status(503).json({ error: status.reason, fallback: "mjpeg" });
    return false;
  }
  const params = { ...options.params, fps: Math.min(12, options.params.fps) };
  const args = buildJxlArgs(buildBaseArgs({ ...options, params, framed: false }), params.quality);
  const ffmpegPath = jxlFfmpegPath();
  const ff = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let opened = false;
  let cleaned = false;
  let clogged = false;
  let stderr = "";
  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    if (!ff.killed && ff.exitCode === null) ff.kill("SIGTERM");
    onCleanup();
  };
  const fail = (message) => {
    if (cleaned) return;
    if (!res.headersSent) {
      res.status(502).json({ error: "JPEG XL encoding failed: " + message, fallback: "mjpeg" });
    } else if (!res.destroyed) {
      res.destroy();
    }
    finish();
  };
  const assembler = new JxlFrameAssembler((frame) => {
    if (cleaned) return;
    if (!opened) {
      opened = true;
      res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=" + BOUNDARY,
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-MJPEG-FPS": String(params.fps),
        "X-JXL-Experimental": "1",
      });
    }
    if (!res.write(multipartJxlFrame(frame))) {
      clogged = true;
      ff.stdout.pause();
      ff.stdio[3].pause();
    }
  });
  const readSafely = (fn) => (chunk) => {
    if (cleaned) return;
    try { fn(chunk); } catch (error) { fail(error.message); }
  };
  ff.stdout.on("data", readSafely((chunk) => assembler.data(chunk)));
  ff.stdio[3].on("data", readSafely((chunk) => assembler.metadata(chunk)));
  res.on("drain", () => {
    if (clogged && !cleaned) {
      clogged = false;
      ff.stdout.resume();
      ff.stdio[3].resume();
    }
  });
  ff.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2500); });
  ff.on("error", (error) => fail(error.message));
  ff.on("close", (code) => {
    if (cleaned) return;
    try { assembler.drain(); } catch (error) { fail(error.message); return; }
    if (code !== 0 && !opened) return fail(stderr.trim().split("\n").at(-1) || "FFmpeg exited " + code);
    if (assembler.bytes || assembler.sizes.length) return fail("Incomplete JXL frame sequence");
    if (!opened) return fail("No JPEG XL frames received");
    if (!res.destroyed) res.end("--" + BOUNDARY + "--\r\n");
    finish();
  });
  res.on("close", finish);
  return true;
}
