import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { buildMjpegArgs, pipeFfmpegOutput } from "../src/lib/stream.js";
import { encodeEautoFrame } from "../src/lib/eauto-framing.js";

await import("../public/e-auto.js");

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const streamSource = fs.readFileSync(new URL("../src/lib/stream.js", import.meta.url), "utf8");

test("production quality controls expose adaptive Auto and the three fixed profiles", () => {
  const controls = html.match(/id="playerQualityPresets"[\s\S]*?<\/div>/)?.[0] || "";
  const profiles = [...controls.matchAll(/data-stream-profile="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(profiles, ["auto", "low", "medium", "high"]);
  assert.match(app, /AUTO_STREAM_QUALITY_ID = "auto"/);
  assert.match(app, /maybeAdaptAutoQuality\(stats\)/);
  assert.equal(typeof globalThis.YtExperimentalAuto.ExperimentalMjpegPlayer, "function");
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

test("experimental EAJF preserves seek timestamps and rejects stale sessions before queueing", async () => {
  const E = globalThis.YtExperimentalAuto;
  let queued = 0;
  const ctx = { expectedSessionId: 45, queue: { waitForRoom: () => { queued++; } } };
  await E.ExperimentalMjpegPlayer.prototype._enqueueFramed.call(ctx, {sessionId: 44}, 0);
  assert.equal(queued, 0);
  const jpeg = new Uint8Array([255,216,255,217]);
  const [frame] = new E.EajfParser().push(encodeEautoFrame({sessionId:45,sequence:0,videoTimestamp:35_000_000,fps:15,quality:7,height:480},jpeg));
  assert.equal(frame.sessionId,45);
  assert.equal(frame.videoTimestampUs,35_000_000);
});

test("child close waits for pending and unread stdout frames before ending", async () => {
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
  ff.stdout = new Readable({ read() {} });
  ff.stdout.unpipe = () => {};
  ff.stderr = new EventEmitter();
  ff.killed = false;
  ff.kill = () => { ff.killed = true; };

  pipeFfmpegOutput(req, res, ff, {
    headers: { "Content-Type": "test/framed" }, label: "test",
    transformChunk: (chunk) => chunk.toString() === "first"
      ? [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")]
      : [Buffer.from("unread")],
  });
  ff.stdout.push(Buffer.from("first"));
  ff.stdout.push(Buffer.from("second"));
  ff.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["a"]);
  // A natural child close must retain every already-framed output while the
  // response is applying backpressure and stdout has unread buffered bytes.
  ff.emit("close", 0);
  assert.equal(res.ended, undefined);
  res.emit("drain");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["a", "b", "c", "unread"]);
  assert.equal(res.ended, true);
});

test("natural close waits for delayed framed output", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const writes = [];
  res.destroyed = false;
  res.headersSent = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = (chunk) => { writes.push(Buffer.from(chunk).toString()); return true; };
  res.end = () => { res.ended = true; };
  res.destroy = () => { res.destroyed = true; };
  const ff = new EventEmitter();
  ff.stdout = new EventEmitter();
  ff.stdout.pause = () => {};
  ff.stdout.resume = () => {};
  ff.stdout.unpipe = () => {};
  ff.stderr = new EventEmitter();
  ff.killed = false;
  ff.kill = () => { ff.killed = true; };

  pipeFfmpegOutput(req, res, ff, {
    headers: { "Content-Type": "test/framed" }, label: "test", outputDelayMs: 20,
    transformChunk: () => [Buffer.from("delayed")],
  });
  ff.stdout.emit("data", Buffer.from("source"));
  ff.emit("close", 0);
  ff.stdout.emit("end");
  assert.equal(res.ended, undefined);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(writes, ["delayed"]);
  assert.equal(res.ended, true);
  ff.stdout.emit("data", Buffer.from("late"));
  assert.deepEqual(writes, ["delayed"]);
});
