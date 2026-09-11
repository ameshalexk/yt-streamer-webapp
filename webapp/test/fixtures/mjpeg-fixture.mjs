export function jpegFrame(id = 0, payloadBytes = 24) {
  const body = new Uint8Array(Math.max(4, payloadBytes));
  body[0] = 0xff;
  body[1] = 0xd8;
  for (let i = 2; i < body.length - 2; i += 1) body[i] = (id * 31 + i) & 0xff;
  body[body.length - 2] = 0xff;
  body[body.length - 1] = 0xd9;
  return body;
}

export function multipartFixture({
  boundary = "ffmpeg",
  frameCount = 8,
  includeContentLength = true,
  closeBoundary = false,
  frameBytes = 32,
} = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  let total = 0;
  const add = (bytes) => {
    chunks.push(bytes);
    total += bytes.byteLength;
  };
  for (let i = 0; i < frameCount; i += 1) {
    const frame = jpegFrame(i, frameBytes + i);
    let headers = "--" + boundary + "\r\nContent-type: image/jpeg\r\n";
    if (includeContentLength) headers += "Content-length: " + frame.byteLength + "\r\n";
    headers += "\r\n";
    add(encoder.encode(headers));
    add(frame);
    add(encoder.encode("\r\n"));
  }
  if (closeBoundary) add(encoder.encode("--" + boundary + "--\r\n"));
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function splitUneven(bytes, sizes = [1, 2, 7, 3, 19, 5, 64, 11]) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[index++ % sizes.length];
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + size)));
    offset += size;
  }
  return chunks;
}
