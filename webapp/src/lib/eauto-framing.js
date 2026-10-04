// Fixed-size framing for E Auto's raw image2pipe JPEG transport.
// All integer fields are unsigned big-endian. A frame is HEADER + JPEG bytes.

export const EAUTO_MAGIC = "EAJF";
export const EAUTO_VERSION = 1;
export const EAUTO_HEADER_LENGTH = 48;
export const EAUTO_DEFAULT_MAX_JPEG_BYTES = 8 * 1024 * 1024;
export const EAUTO_DEFAULT_MAX_BUFFER_BYTES = EAUTO_HEADER_LENGTH + EAUTO_DEFAULT_MAX_JPEG_BYTES;

const MAGIC_BYTES = new TextEncoder().encode(EAUTO_MAGIC);
const PROFILE_NAMES = Object.freeze({
  0: "unknown", 1: "low", 2: "medium", 3: "high", 4: "auto",
  5: "economy", 6: "balanced", 7: "smooth", 8: "e-auto",
});
const PROFILE_CODES = Object.freeze({
  unknown: 0, low: 1, medium: 2, high: 3, auto: 4,
  economy: 5, balanced: 6, smooth: 7, "e-auto": 8,
});

// Offsets are part of the wire format. The remaining 6 bytes are reserved.
const OFFSETS = Object.freeze({
  version: 4, headerLength: 5, sessionId: 6, sequence: 10,
  videoTimestamp: 14, encodeTimestamp: 22, jpegLength: 30, fpsX100: 34,
  quality: 36, profile: 37, width: 38, height: 40,
});

function asUint(value, name, max) {
  const n = typeof value === "bigint" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new RangeError(`${name} must be an unsigned integer <= ${max}`);
  return n;
}

function profileCode(profile) {
  if (typeof profile === "string") {
    const code = PROFILE_CODES[profile.toLowerCase()];
    if (code === undefined) throw new RangeError(`unknown E Auto profile: ${profile}`);
    return code;
  }
  return asUint(profile ?? 0, "profile", 255);
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("JPEG must be a Uint8Array or ArrayBuffer");
}

function assertJpeg(jpeg) {
  if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.byteLength - 2] !== 0xff || jpeg[jpeg.byteLength - 1] !== 0xd9) {
    throw new RangeError("payload is not a complete JPEG");
  }
}

function timestamp(value, name) {
  if (value === undefined || value === null) return 0n;
  const n = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError(`${name} is outside uint64 range`);
  return n;
}

function decodedTimestamp(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export function encodeEautoHeader(metadata = {}) {
  const header = new Uint8Array(EAUTO_HEADER_LENGTH);
  header.set(MAGIC_BYTES, 0);
  const view = new DataView(header.buffer);
  view.setUint8(OFFSETS.version, metadata.version ?? EAUTO_VERSION);
  view.setUint8(OFFSETS.headerLength, EAUTO_HEADER_LENGTH);
  view.setUint32(OFFSETS.sessionId, asUint(metadata.sessionId ?? 0, "sessionId", 0xffffffff));
  view.setUint32(OFFSETS.sequence, asUint(metadata.sequence ?? 0, "sequence", 0xffffffff));
  view.setBigUint64(OFFSETS.videoTimestamp, timestamp(metadata.videoTimestamp, "videoTimestamp"));
  view.setBigUint64(OFFSETS.encodeTimestamp, timestamp(metadata.encodeTimestamp ?? metadata.sendTimestamp, "encodeTimestamp"));
  view.setUint32(OFFSETS.jpegLength, asUint(metadata.jpegLength ?? metadata.jpegSize ?? 0, "jpegLength", 0xffffffff));
  const fpsX100 = metadata.fpsX100 ?? Math.round(Number(metadata.fps ?? 0) * 100);
  view.setUint16(OFFSETS.fpsX100, asUint(fpsX100, "fpsX100", 0xffff));
  view.setUint8(OFFSETS.quality, asUint(metadata.quality ?? 0, "quality", 255));
  view.setUint8(OFFSETS.profile, profileCode(metadata.profile));
  view.setUint16(OFFSETS.width, asUint(metadata.width ?? 0, "width", 0xffff));
  view.setUint16(OFFSETS.height, asUint(metadata.height ?? 0, "height", 0xffff));
  return header;
}

export function parseEautoHeader(input) {
  const header = bytes(input);
  if (header.byteLength < EAUTO_HEADER_LENGTH) throw new RangeError("truncated E Auto header");
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (header[i] !== MAGIC_BYTES[i]) throw new Error("invalid E Auto frame magic");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const version = view.getUint8(OFFSETS.version);
  const headerLength = view.getUint8(OFFSETS.headerLength);
  if (version !== EAUTO_VERSION) throw new Error(`unsupported E Auto frame version: ${version}`);
  if (headerLength !== EAUTO_HEADER_LENGTH) throw new Error(`invalid E Auto header length: ${headerLength}`);
  const code = view.getUint8(OFFSETS.profile);
  return {
    version, headerLength,
    sessionId: view.getUint32(OFFSETS.sessionId),
    sequence: view.getUint32(OFFSETS.sequence),
    videoTimestamp: decodedTimestamp(view.getBigUint64(OFFSETS.videoTimestamp)),
    videoTimestampUs: decodedTimestamp(view.getBigUint64(OFFSETS.videoTimestamp)),
    encodeTimestamp: decodedTimestamp(view.getBigUint64(OFFSETS.encodeTimestamp)),
    sendTimestamp: decodedTimestamp(view.getBigUint64(OFFSETS.encodeTimestamp)),
    serverTimestampMs: decodedTimestamp(view.getBigUint64(OFFSETS.encodeTimestamp)),
    jpegLength: view.getUint32(OFFSETS.jpegLength),
    fpsX100: view.getUint16(OFFSETS.fpsX100), fps: view.getUint16(OFFSETS.fpsX100) / 100,
    quality: view.getUint8(OFFSETS.quality), jpegQuality: view.getUint8(OFFSETS.quality),
    profile: PROFILE_NAMES[code] ?? code, profileCode: code,
    width: view.getUint16(OFFSETS.width), height: view.getUint16(OFFSETS.height),
  };
}

export function encodeEautoFrame(metadata = {}, jpeg) {
  // Also accept encodeEautoFrame(jpeg, metadata) for stream adapters.
  if (metadata instanceof Uint8Array || metadata instanceof ArrayBuffer || ArrayBuffer.isView(metadata)) {
    [metadata, jpeg] = [jpeg ?? {}, metadata];
  }
  const payload = bytes(jpeg ?? metadata.jpeg ?? metadata.payload);
  assertJpeg(payload);
  const header = encodeEautoHeader({ ...metadata, jpegLength: payload.byteLength });
  const frame = new Uint8Array(header.byteLength + payload.byteLength);
  frame.set(header); frame.set(payload, header.byteLength);
  return frame;
}

export class EautoJpegParser {
  #buffer = new Uint8Array(0);
  #maxJpegBytes;
  #maxBufferBytes;
  constructor({ maxJpegBytes = EAUTO_DEFAULT_MAX_JPEG_BYTES, maxBufferBytes = EAUTO_DEFAULT_MAX_BUFFER_BYTES } = {}) {
    if (!Number.isSafeInteger(maxJpegBytes) || maxJpegBytes < 4) throw new RangeError("maxJpegBytes is too small");
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < EAUTO_HEADER_LENGTH) throw new RangeError("maxBufferBytes is too small");
    this.#maxJpegBytes = maxJpegBytes; this.#maxBufferBytes = Math.max(maxBufferBytes, EAUTO_HEADER_LENGTH + maxJpegBytes);
  }
  push(chunk) {
    const part = bytes(chunk);
    if (!part.byteLength) return [];
    if (this.#buffer.byteLength + part.byteLength > this.#maxBufferBytes) throw new RangeError("E Auto parser buffer limit exceeded");
    const joined = new Uint8Array(this.#buffer.byteLength + part.byteLength);
    joined.set(this.#buffer); joined.set(part, this.#buffer.byteLength); this.#buffer = joined;
    const frames = [];
    while (this.#buffer.byteLength >= EAUTO_HEADER_LENGTH) {
      const header = parseEautoHeader(this.#buffer.subarray(0, EAUTO_HEADER_LENGTH));
      if (header.jpegLength < 4 || header.jpegLength > this.#maxJpegBytes) throw new RangeError("E Auto JPEG length exceeds limit");
      const total = EAUTO_HEADER_LENGTH + header.jpegLength;
      if (this.#buffer.byteLength < total) break;
      const payload = this.#buffer.slice(EAUTO_HEADER_LENGTH, total);
      assertJpeg(payload);
      frames.push({ ...header, jpeg: payload });
      this.#buffer = this.#buffer.slice(total);
    }
    return frames;
  }
  end() {
    if (this.#buffer.byteLength) throw new Error("truncated E Auto frame");
    return [];
  }
  get bufferedBytes() { return this.#buffer.byteLength; }
}

// Splits FFmpeg's image2pipe output into complete JPEG images before framing.
// JPEG entropy-coded 0xff bytes are escaped, so an unescaped EOI marker is a
// safe frame boundary. Memory remains bounded even when upstream is malformed.
export class RawJpegStreamParser {
  #buffer = new Uint8Array(0);
  #maxJpegBytes;
  #maxBufferBytes;
  constructor({ maxJpegBytes = EAUTO_DEFAULT_MAX_JPEG_BYTES, maxBufferBytes = 16 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxJpegBytes) || maxJpegBytes < 4) throw new RangeError("maxJpegBytes is too small");
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < maxJpegBytes) throw new RangeError("maxBufferBytes is too small");
    this.#maxJpegBytes = maxJpegBytes;
    this.#maxBufferBytes = maxBufferBytes;
  }
  push(chunk) {
    const part = bytes(chunk);
    if (!part.byteLength) return [];
    // Enforce the transport ceiling before allocating/copying the joined
    // buffer. It may hold several complete JPEGs, so it is separate from the
    // per-JPEG limit enforced below.
    if (part.byteLength > this.#maxBufferBytes || this.#buffer.byteLength + part.byteLength > this.#maxBufferBytes) {
      throw new RangeError("raw JPEG parser buffer limit exceeded");
    }
    const joined = new Uint8Array(this.#buffer.byteLength + part.byteLength);
    joined.set(this.#buffer);
    joined.set(part, this.#buffer.byteLength);
    this.#buffer = joined;
    const frames = [];
    while (this.#buffer.byteLength >= 4) {
      let start = -1;
      for (let i = 0; i < this.#buffer.byteLength - 1; i += 1) {
        if (this.#buffer[i] === 0xff && this.#buffer[i + 1] === 0xd8) { start = i; break; }
      }
      if (start < 0) {
        this.#buffer = this.#buffer.slice(-1);
        break;
      }
      if (start > 0) this.#buffer = this.#buffer.slice(start);
      let end = -1;
      for (let i = 2; i < this.#buffer.byteLength - 1; i += 1) {
        if (this.#buffer[i] === 0xff && this.#buffer[i + 1] === 0xd9) { end = i + 2; break; }
      }
      if (end < 0) {
        if (this.#buffer.byteLength > this.#maxJpegBytes) throw new RangeError("raw JPEG exceeds limit");
        break;
      }
      const frame = this.#buffer.slice(0, end);
      if (frame.byteLength > this.#maxJpegBytes) throw new RangeError("raw JPEG exceeds limit");
      frames.push(frame);
      this.#buffer = this.#buffer.slice(end);
    }
    return frames;
  }
  end() {
    if (this.#buffer.byteLength && !(this.#buffer.byteLength === 1 && this.#buffer[0] === 0xff)) {
      throw new Error("truncated raw JPEG stream");
    }
    this.#buffer = new Uint8Array(0);
    return [];
  }
  get bufferedBytes() { return this.#buffer.byteLength; }
}

export const EAutoJpegParser = EautoJpegParser;
export const EAutoFrameParser = EautoJpegParser;
export const encodeHeader = encodeEautoHeader;
export const parseHeader = parseEautoHeader;
export const encodeFrame = encodeEautoFrame;
