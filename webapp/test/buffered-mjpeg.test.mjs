import test from "node:test";
import assert from "node:assert/strict";
import { multipartFixture, splitUneven, jpegFrame } from "./fixtures/mjpeg-fixture.mjs";

await import("../public/buffered-mjpeg.js");
const {
  MultipartMjpegParser,
  BufferedFrameQueue,
  BufferPolicy,
  SessionGuard,
  boundaryFromContentType,
} = globalThis.BufferedMjpeg;

test("extracts boundary from quoted and unquoted content types", () => {
  assert.equal(boundaryFromContentType("multipart/x-mixed-replace; boundary=ffmpeg"), "ffmpeg");
  assert.equal(boundaryFromContentType('multipart/x-mixed-replace; boundary="abc-123"'), "abc-123");
});

test("multipart parser handles split boundaries, split headers, and multiple frames per chunk", () => {
  const source = multipartFixture({ frameCount: 7, closeBoundary: true });
  const parser = new MultipartMjpegParser("ffmpeg");
  const frames = [];
  for (const chunk of splitUneven(source)) frames.push(...parser.push(chunk));
  frames.push(...parser.end());
  assert.equal(frames.length, 7);
  assert.deepEqual([...frames[0].slice(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...frames[6].slice(-2)], [0xff, 0xd9]);
});

test("multipart parser supports parts without Content-Length using the next boundary", () => {
  const source = multipartFixture({ frameCount: 3, includeContentLength: false, closeBoundary: true });
  const parser = new MultipartMjpegParser("ffmpeg");
  const frames = parser.push(source);
  assert.equal(frames.length, 3);
  parser.end();
});

test("multipart parser accepts ffmpeg-style EOF without a final closing boundary", () => {
  const source = multipartFixture({ frameCount: 2, closeBoundary: false });
  const parser = new MultipartMjpegParser("ffmpeg");
  const frames = [];
  for (const chunk of splitUneven(source, [13, 5, 1, 71])) frames.push(...parser.push(chunk));
  assert.equal(frames.length, 2);
  assert.deepEqual(parser.end(), []);
});

test("multipart parser rejects truncated and malformed frames", () => {
  const truncated = multipartFixture({ frameCount: 1 }).slice(0, -8);
  const parser = new MultipartMjpegParser("ffmpeg");
  parser.push(truncated);
  assert.throws(() => parser.end(), /Truncated MJPEG frame/);

  const encoder = new TextEncoder();
  const bad = encoder.encode("--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: 4\r\n\r\nBAD!\r\n");
  const parser2 = new MultipartMjpegParser("ffmpeg");
  assert.throws(() => parser2.push(bad), /Malformed MJPEG frame/);
});

test("parser enforces frame and parser memory limits", () => {
  const source = multipartFixture({ frameCount: 1, frameBytes: 128 });
  const parser = new MultipartMjpegParser("ffmpeg", { maxFrameBytes: 64, maxParserBytes: 512 });
  assert.throws(() => parser.push(source), /exceeds/);
});

test("queue bounds duration and bytes and resumes after consumer progress", async () => {
  const queue = new BufferedFrameQueue({ fps: 2, maxDurationSeconds: 2, maxBytes: 100 });
  for (let i = 0; i < 4; i += 1) queue.push({ size: 20, index: i });
  assert.equal(queue.durationSeconds(), 2);
  assert.equal(queue.bytes, 80);
  assert.equal(queue.canAccept(20), false);

  const waiter = queue.waitForRoom(20);
  let resolved = false;
  waiter.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  queue.shift();
  await waiter;
  assert.equal(resolved, true);
  queue.push({ size: 20, index: 4 });
  assert.ok(queue.bytes <= 100);
  assert.ok(queue.durationSeconds() <= 2);
});

test("buffer policy starts short streams at EOF and uses separate startup/rebuffer thresholds", () => {
  const policy = new BufferPolicy({ startupSeconds: 3, rebufferSeconds: 1.5, maxSeconds: 5 });
  assert.equal(policy.startupReady(2.9, false, 40, true, true), false);
  assert.equal(policy.startupReady(3, false, 40, true, true), true);
  assert.equal(policy.startupReady(0.8, true, 10, true, true), true);
  assert.equal(policy.startupReady(3.5, false, 40, false, true), false);
  assert.equal(policy.resumeReady(1.49, false, 10, true, true), false);
  assert.equal(policy.resumeReady(1.5, false, 10, true, true), true);
  assert.equal(policy.shouldRebuffer(0, false), true);
  assert.equal(policy.shouldRebuffer(0, true), false);
});

test("4/8/2 candidate policy keeps queue bounded by duration and bytes", () => {
  const policy = new BufferPolicy({ startupSeconds: 4, rebufferSeconds: 2, maxSeconds: 8 });
  assert.equal(policy.startupReady(3.99, false, 48, true, true), false);
  assert.equal(policy.startupReady(4, false, 48, true, true), true);
  assert.equal(policy.resumeReady(1.99, false, 24, true, true), false);
  assert.equal(policy.resumeReady(2, false, 24, true, true), true);

  const durationQueue = new BufferedFrameQueue({
    fps: 12,
    maxDurationSeconds: 8,
    maxBytes: 24 * 1024 * 1024,
  });
  while (durationQueue.canAccept(64 * 1024)) durationQueue.push({ size: 64 * 1024 });
  assert.equal(durationQueue.length, 96);
  assert.equal(durationQueue.durationSeconds(), 8);
  assert.ok(durationQueue.bytes <= 24 * 1024 * 1024);
  assert.equal(durationQueue.canAccept(64 * 1024), false);

  const byteQueue = new BufferedFrameQueue({
    fps: 12,
    maxDurationSeconds: 8,
    maxBytes: 24 * 1024 * 1024,
  });
  while (byteQueue.canAccept(2 * 1024 * 1024)) byteQueue.push({ size: 2 * 1024 * 1024 });
  assert.equal(byteQueue.bytes, 24 * 1024 * 1024);
  assert.ok(byteQueue.durationSeconds() < 8);
  assert.equal(byteQueue.canAccept(2 * 1024 * 1024), false);
});

test("queue backpressure aborts cleanly instead of hanging", async () => {
  const queue = new BufferedFrameQueue({ fps: 1, maxDurationSeconds: 1, maxBytes: 64 });
  queue.push({ size: 32 });
  const controller = new AbortController();
  const waiting = queue.waitForRoom(32, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
});

test("session guard blocks stale callbacks after cancellation or session replacement", () => {
  let current = 7;
  const guard = new SessionGuard(7, (id) => id === current);
  assert.equal(guard.active(), true);
  current = 8;
  assert.equal(guard.active(), false);

  const guard2 = new SessionGuard(9, () => true);
  assert.equal(guard2.active(), true);
  guard2.cancel();
  assert.equal(guard2.active(), false);
});

test("deterministic fixture can model uneven delivery without unbounded queue growth", () => {
  const source = multipartFixture({ frameCount: 20, frameBytes: 40 });
  const parser = new MultipartMjpegParser("ffmpeg");
  const queue = new BufferedFrameQueue({ fps: 4, maxDurationSeconds: 2, maxBytes: 1024 });
  let index = 0;
  for (const chunk of splitUneven(source, [1, 97, 2, 5, 43])) {
    for (const bytes of parser.push(chunk)) {
      if (!queue.canAccept(bytes.byteLength)) queue.shift();
      queue.push({ size: bytes.byteLength, bytes, index: index++ });
      assert.ok(queue.durationSeconds() <= 2.25);
      assert.ok(queue.bytes <= 1024);
    }
  }
  parser.end();
  assert.equal(index, 20);
  assert.ok(queue.length <= 9);
});

test("fixture JPEG markers are deterministic", () => {
  assert.deepEqual([...jpegFrame(2, 8)], [255, 216, 64, 65, 66, 67, 255, 217]);
});

test("on-demand MJPEG production can run ahead while live and legacy paths stay realtime", async () => {
  const { buildMjpegArgs } = await import("../src/lib/stream.js");
  const params = { height: 480, fps: 24, quality: 7 };
  const bufferedHttp = buildMjpegArgs({
    input: "https://example.test/video.mp4",
    params,
    isLive: false,
    paceInput: false,
    allowBurst: true,
  });
  assert.equal(bufferedHttp.includes("-re"), false);

  const bufferedLocal = buildMjpegArgs({
    input: "/tmp/fixture.mp4",
    params,
    isLive: false,
    paceInput: false,
    allowBurst: true,
  });
  assert.equal(bufferedLocal.includes("-re"), false);

  const live = buildMjpegArgs({
    input: "https://example.test/live.m3u8",
    params,
    isLive: true,
    paceInput: false,
    allowBurst: true,
  });
  assert.equal(live.includes("-re"), true);

  const legacyLocal = buildMjpegArgs({
    input: "/tmp/fixture.mp4",
    params,
    isLive: false,
    paceInput: false,
    allowBurst: false,
  });
  assert.equal(legacyLocal.includes("-re"), true);
});

test("buffered player destroy cancels fetch state and makes stale callbacks inactive", () => {
  const canvas = {
    width: 1,
    height: 1,
    getContext() {
      return { drawImage() {}, clearRect() {} };
    },
  };
  const player = new globalThis.BufferedMjpeg.BufferedMjpegPlayer({
    url: "/fixture",
    canvas,
    fps: 12,
    sessionId: 41,
    isCurrent: (id) => id === 41,
    audioEnabled: () => false,
    startupSeconds: 4,
    rebufferSeconds: 2,
    maxQueueSeconds: 8,
  });
  assert.equal(player.policy.startupSeconds, 4);
  assert.equal(player.policy.rebufferSeconds, 2);
  assert.equal(player.queue.maxDurationSeconds, 8);
  assert.equal(player._active(), true);
  assert.equal(player.controller.signal.aborted, false);
  player.destroy();
  assert.equal(player.controller.signal.aborted, true);
  assert.equal(player._active(), false);
});
