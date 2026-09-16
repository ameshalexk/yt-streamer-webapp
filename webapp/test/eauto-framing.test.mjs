import test from "node:test";
import assert from "node:assert/strict";
import { EAUTO_HEADER_LENGTH, EautoJpegParser, RawJpegStreamParser, encodeEautoFrame, encodeEautoHeader, parseEautoHeader } from "../src/lib/eauto-framing.js";

const jpeg = (...body) => new Uint8Array([0xff, 0xd8, ...body, 0xff, 0xd9]);
const metadata = { sessionId: 0x12345678, sequence: 17, videoTimestamp: 123456789, encodeTimestamp: 987654321, fps: 24, quality: 7, profile: "medium", width: 854, height: 480 };

test("header and frame preserve exact metadata", () => {
  const frame = encodeEautoFrame(metadata, jpeg(1, 2, 3));
  assert.equal(frame.byteLength, EAUTO_HEADER_LENGTH + 7);
  assert.deepEqual(parseEautoHeader(frame), {
    version: 1, headerLength: 48, ...metadata,
    videoTimestampUs: metadata.videoTimestamp,
    sendTimestamp: metadata.encodeTimestamp,
    serverTimestampMs: metadata.encodeTimestamp,
    jpegLength: 7, fpsX100: 2400, jpegQuality: 7, profileCode: 2,
  });
});

test("parser handles split header/payload and coalesced frames", () => {
  const first = encodeEautoFrame({ ...metadata, sequence: 1 }, jpeg(1, 2));
  const second = encodeEautoFrame({ ...metadata, sequence: 2, profile: "high" }, jpeg(3, 4, 5));
  const parser = new EautoJpegParser({ maxJpegBytes: 100 });
  assert.deepEqual(parser.push(first.subarray(0, 3)), []);
  assert.deepEqual(parser.push(new Uint8Array([...first.subarray(3), ...second])), [
    { ...metadata, sequence: 1, version: 1, headerLength: 48, videoTimestampUs: metadata.videoTimestamp, sendTimestamp: metadata.encodeTimestamp, serverTimestampMs: metadata.encodeTimestamp, jpegLength: 6, fpsX100: 2400, jpegQuality: 7, profileCode: 2, jpeg: jpeg(1, 2) },
    { ...metadata, sequence: 2, version: 1, headerLength: 48, videoTimestampUs: metadata.videoTimestamp, sendTimestamp: metadata.encodeTimestamp, serverTimestampMs: metadata.encodeTimestamp, jpegLength: 7, fpsX100: 2400, jpegQuality: 7, profile: "high", profileCode: 3, jpeg: jpeg(3, 4, 5) },
  ]);
  assert.equal(parser.bufferedBytes, 0);
});

test("parser rejects malformed, oversize, and truncated data", () => {
  const parser = new EautoJpegParser({ maxJpegBytes: 8 });
  assert.throws(() => parser.push(new Uint8Array(EAUTO_HEADER_LENGTH)), /magic/);
  assert.throws(() => new EautoJpegParser({ maxJpegBytes: 8 }).push(encodeEautoHeader({ ...metadata, jpegLength: 9 })), /exceeds/);
  const valid = encodeEautoFrame(metadata, jpeg(1));
  const truncated = new EautoJpegParser();
  truncated.push(valid.subarray(0, -1));
  assert.throws(() => truncated.end(), /truncated/);
  assert.throws(() => new EautoJpegParser().push(encodeEautoFrame(metadata, new Uint8Array([1, 2, 3]))), /JPEG/);
});

test("raw image2pipe parser handles split and coalesced JPEGs with bounded failure", () => {
  const first = jpeg(1, 2, 3);
  const second = jpeg(4, 5);
  const parser = new RawJpegStreamParser({ maxJpegBytes: 16 });
  assert.deepEqual(parser.push(first.subarray(0, 3)), []);
  assert.deepEqual(parser.push(new Uint8Array([...first.subarray(3), ...second])), [first, second]);
  assert.deepEqual(parser.end(), []);
  const oversize = new RawJpegStreamParser({ maxJpegBytes: 5 });
  assert.throws(() => oversize.push(new Uint8Array([0xff, 0xd8, 1, 2, 3, 4])), /exceeds/);
  const bounded = new RawJpegStreamParser({ maxJpegBytes: 8, maxBufferBytes: 12 });
  assert.throws(() => bounded.push(new Uint8Array(13)), /buffer limit/);
  const truncated = new RawJpegStreamParser();
  truncated.push(new Uint8Array([0xff, 0xd8, 1]));
  assert.throws(() => truncated.end(), /truncated/);
});
