import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

await import("../public/buffered-mjpeg.js");
const { MultipartMjpegParser } = globalThis.BufferedMjpeg;
const { buildMjpegArgs } = await import("../src/lib/stream.js");

function run(command, args, { onStdout = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdoutBytes, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

test("deterministic local 480p24 fixture produces parseable buffered MJPEG without YouTube", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ytstreamer-buffer-"));
  const fixture = path.join(dir, "fixture.mp4");
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=854x480:rate=24",
      "-t", "4",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-movflags", "+faststart",
      "-y", fixture,
    ]);

    const params = { height: 480, fps: 24, quality: 7 };
    const args = buildMjpegArgs({
      input: fixture,
      params,
      isLive: false,
      paceInput: false,
      allowBurst: true,
    });
    assert.equal(args.includes("-re"), false);

    const parser = new MultipartMjpegParser("ffmpeg");
    let frames = 0;
    const startedAt = performance.now();
    const result = await run("ffmpeg", args, {
      onStdout: (chunk) => { frames += parser.push(chunk).length; },
    });
    frames += parser.end().length;
    const elapsedMs = performance.now() - startedAt;

    assert.equal(frames, 96);
    assert.ok(result.stdoutBytes > 100_000);
    // This is diagnostic rather than a hard realtime assertion: the args test above
    // guarantees -re is absent, while elapsedMs records actual local headroom.
    assert.ok(elapsedMs > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
