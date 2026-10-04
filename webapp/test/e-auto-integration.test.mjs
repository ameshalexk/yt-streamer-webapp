import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { buildMjpegArgs, pipeFfmpegOutput } from "../src/lib/stream.js";
import { encodeEautoFrame } from "../src/lib/eauto-framing.js";

await import("../public/e-auto.js");

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const streamSource = fs.readFileSync(new URL("../src/lib/stream.js", import.meta.url), "utf8");

test("E Auto is a fifth mode and normal Auto remains distinct", () => {
  const controls = html.match(/id="playerQualityPresets"[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(controls, /data-stream-profile="low"[\s\S]*data-stream-profile="medium"[\s\S]*data-stream-profile="high"[\s\S]*data-stream-profile="auto"[\s\S]*data-stream-profile="e-auto"/);
  assert.match(app, /AUTO_STREAM_QUALITY_ID = "auto"/);
  assert.match(app, /E_AUTO_STREAM_QUALITY_ID = "e-auto"/);
  assert.match(app, /ExperimentalMjpegPlayer/);
  assert.match(app, /maybeAdaptAutoQuality\(stats\)/);
  assert.match(app, /maybeAdaptEAutoQuality\(stats, player\)/);
});

test("framed mode uses image2pipe while normal MJPEG remains multipart", () => {
  const base = { input: "/tmp/video.mp4", params: { height: 480, fps: 15, quality: 7 }, isLive: false };
  const normal = buildMjpegArgs(base);
  const framed = buildMjpegArgs({ ...base, framed: true, allowBurst: true });
  assert.deepEqual(normal.slice(-3), ["-f", "mpjpeg", "pipe:1"]);
  assert.deepEqual(framed.slice(-5), ["-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"]);
  assert.match(streamSource, /application\/vnd\.ytstreamer\.eauto\+jpeg/);
  assert.match(server, /eautoSession/);
});

test("server and browser agree on the 48-byte EAJF protocol", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const encoded = encodeEautoFrame({
    sessionId: 44, sequence: 9, videoTimestamp: 2_500_000,
    encodeTimestamp: 1_700_000_000_000, fps: 15, quality: 7,
    profile: "auto", width: 0, height: 480,
  }, jpeg);
  const parser = new globalThis.YtExperimentalAuto.EajfParser();
  const [frame] = parser.push(encoded);
  assert.equal(frame.headerLength, 48);
  assert.equal(frame.sessionId, 44);
  assert.equal(frame.sequence, 9);
  assert.equal(frame.videoTimestampUs, 2_500_000);
  assert.equal(frame.fps, 15);
  assert.equal(frame.jpegQuality, 7);
  assert.equal(frame.height, 480);
  assert.deepEqual(frame.jpeg, jpeg);
});

test("E Auto seek and quality restarts preserve measurements but rotate sessions", () => {
  assert.match(app, /preserveExperimentOnCleanup = true;\s*replayFn\(target\)/);
  assert.match(app, /withUrlParam\(bufferedUrl, "eautoSession", attempt\)/);
  assert.match(fs.readFileSync(new URL("../public/e-auto.js", import.meta.url), "utf8"), /metadata\.sessionId >>> 0\).*expectedSessionId/);
  assert.match(app, /finalizeExperimentMeasurement\("ended"\)/);
  assert.match(html, /id="eAutoDebug"/);
});

test("framed outputs from one ffmpeg chunk survive HTTP backpressure", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const writes = [];
  let first = true;
  res.destroyed = false;
  res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = (chunk) => { writes.push(Buffer.from(chunk).toString()); if (first) { first = false; return false; } return true; };
  res.end = () => { res.ended = true; };
  res.destroy = () => { res.destroyed = true; };

  const ff = new EventEmitter();
  ff.stdout = new EventEmitter();
  ff.stdout.pause = () => { ff.paused = true; };
  ff.stdout.resume = () => { ff.paused = false; };
  ff.stdout.unpipe = () => {};
  ff.stderr = new EventEmitter();
  ff.killed = false;
  ff.kill = () => { ff.killed = true; };

  pipeFfmpegOutput(req, res, ff, {
    headers: { "Content-Type": "test/framed" }, label: "test",
    transformChunk: () => [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")],
  });
  ff.stdout.emit("data", Buffer.from("source"));
  assert.deepEqual(writes, ["a"]);
  assert.equal(ff.paused, true);
  res.emit("drain");
  assert.deepEqual(writes, ["a", "b", "c"]);
  ff.stdout.emit("end");
  assert.equal(res.ended, true);
});
