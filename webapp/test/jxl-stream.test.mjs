import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJxlArgs, frameSizeFromCrcLine, JxlFrameAssembler,
  multipartJxlFrame, jxlEncoderStatus, jxlFfmpegPath,
} from "../src/lib/jxl-stream.js";

await import("../public/buffered-mjpeg.js");
const { MultipartMjpegParser } = globalThis.BufferedMjpeg;

function fakeJxl(index = 0) {
  return Buffer.from([0xff, 0x0a, index, 42, 9, 7]);
}

test("framecrc extracts the size of each encoded packet", () => {
  assert.equal(frameSizeFromCrcLine("#tb 0: 1/12"), null);
  assert.equal(frameSizeFromCrcLine("0,          2,          2,        1,     2290, 0x47cb60d9"), 2290);
  assert.throws(() => frameSizeFromCrcLine("0, 2, 2, 1, 5000000, 0x00"), /excessive/);
  assert.throws(() => frameSizeFromCrcLine("0, 2, 2, 1, NaN, 0x00"), /Invalid/);
});

test("assembles interleaved frame lengths and byte chunks regardless of arrival order", () => {
  const frames = [];
  const one = fakeJxl(1);
  const two = fakeJxl(2);
  const three = fakeJxl(3);
  const assembler = new JxlFrameAssembler((frame) => frames.push(frame));
  assembler.data(Buffer.concat([one, two.subarray(0, 2)]));
  assembler.metadata(Buffer.from("#software: Lavf\n0, 0, 0, 1, 6, 0xabc\n0, 1, 1, 1, 6, 0xabc\n"));
  assert.equal(frames.length, 1);
  assembler.data(Buffer.concat([two.subarray(2), three]));
  assert.equal(frames.length, 2);
  assembler.metadata(Buffer.from("0, 2, 2, 1, 6, 0xabc\n"));
  assert.deepEqual(frames, [one, two, three]);
  assert.equal(assembler.bytes, 0);
});

test("JPEG XL multipart is accepted by the frame parser but rejected in JPEG mode", () => {
  const jxl = fakeJxl(11);
  const source = Buffer.concat([multipartJxlFrame(jxl), Buffer.from("--ytstreamer-jxl--\r\n")]);
  const parser = new MultipartMjpegParser("ytstreamer-jxl", { frameMimeType: "image/jxl" });
  assert.deepEqual(parser.push(source), [jxl]);
  assert.deepEqual(parser.end(), []);
  assert.throws(() =>
    new MultipartMjpegParser("ytstreamer-jxl").push(source), /content type/);
});

test("JPEG XL mode rejects JPEG and unrelated data even with correct MIME header", () => {
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const part = Buffer.concat([
    Buffer.from("--ytstreamer-jxl\r\nContent-Type: image/jxl\r\nContent-Length: 4\r\n\r\n"),
    body,
    Buffer.from("\r\n"),
  ]);
  assert.throws(() => new MultipartMjpegParser("ytstreamer-jxl", {
    frameMimeType: "image/jxl",
  }).push(part), /Malformed JPEG XL/);
});

test("JXL encoder config keeps the original MJPEG streaming command isolated", () => {
  const base = ["-hide_banner", "-i", "example.mp4", "-map", "0:v:0", "-vf", "fps=12", "-q:v", "7", "-f", "mpjpeg", "pipe:1"];
  const before = [...base];
  const jxl = buildJxlArgs(base, 7);
  assert.deepEqual(base, before);
  assert.deepEqual(jxl.slice(-3), ["-f", "tee", "[f=image2pipe]pipe:1|[f=framecrc]pipe:3"]);
  assert.ok(jxl.includes("libjxl"));
  assert.equal(jxl.includes("mpjpeg"), false);
  assert.throws(() => buildJxlArgs(["-f", "hls", "x"]), /Unexpected/);
});

test("codec availability accurately reports a supported or unsupported FFmpeg build", () => {
  const status = jxlEncoderStatus();
  assert.equal(typeof status.available, "boolean");
  if (!status.available) assert.match(status.reason, /libjxl/);
});

test("JXL requires an explicit standalone absolute encoder path", () => {
  const previous = process.env.JXL_FFMPEG_PATH;
  try {
    delete process.env.JXL_FFMPEG_PATH;
    assert.equal(jxlFfmpegPath(), null);
    assert.equal(jxlEncoderStatus().available, false);
    process.env.JXL_FFMPEG_PATH = "ffmpeg";
    assert.equal(jxlFfmpegPath(), null);
    assert.equal(jxlEncoderStatus().available, false);
    process.env.JXL_FFMPEG_PATH = "/this/path/does/not/exist/ffmpeg";
    assert.equal(jxlFfmpegPath(), null);
    assert.equal(jxlEncoderStatus().available, false);
  } finally {
    if (previous === undefined) delete process.env.JXL_FFMPEG_PATH;
    else process.env.JXL_FFMPEG_PATH = previous;
  }
});
