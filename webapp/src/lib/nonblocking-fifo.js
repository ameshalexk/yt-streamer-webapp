import { Readable } from "node:stream";

// The handle must be opened with O_NONBLOCK. A silent FIFO must never occupy a
// libuv filesystem worker indefinitely; destroying the reader cancels polling.
export function fifoReadStream(handle, { chunkSize = 65536, retryMs = 10 } = {}) {
  let pending = false;
  let timer = null;
  let readBuffer = null;
  const stream = new Readable({
    highWaterMark: chunkSize,
    read() { pump(); },
    destroy(error, callback) {
      if (timer) clearTimeout(timer);
      timer = null;
      callback(error);
    },
  });
  function retry() {
    if (stream.destroyed || timer) return;
    timer = setTimeout(() => { timer = null; pump(); }, retryMs);
  }
  function pump() {
    if (stream.destroyed || pending || timer) return;
    pending = true;
    // Retain an empty-read buffer across silent polls; transfer ownership only
    // when data is pushed, so queued chunks are never overwritten.
    const buffer = readBuffer || (readBuffer = Buffer.allocUnsafe(chunkSize));
    handle.read(buffer, 0, buffer.length, null).then(({ bytesRead }) => {
      pending = false;
      if (stream.destroyed) return;
      // No writer/data yet is expected during helper startup and silent audio.
      if (!bytesRead) return retry();
      readBuffer = null;
      if (stream.push(buffer.subarray(0, bytesRead))) pump();
    }).catch((error) => {
      pending = false;
      if (stream.destroyed) return;
      if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") retry();
      else stream.destroy(error);
    });
  }
  return stream;
}
