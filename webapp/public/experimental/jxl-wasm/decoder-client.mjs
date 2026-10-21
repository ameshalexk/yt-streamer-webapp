// Opt-in Web Worker JXL decoder. Isolated: not imported by the live player.
export function createExperimentalJxlDecoder({ timeoutMs = 5000, maxPending = 2, preferBitmap = true } = {}) {
  const worker = new Worker(new URL('./decoder-worker.mjs', import.meta.url), { type: 'module' });
  const waiting = [];
  let active = null;
  let serial = 0;
  let closed = false;

  const disposePayload = (data) => { try { data?.bitmap?.close?.(); } catch {} };
  const finishWithError = (error) => {
    if (closed) return;
    closed = true;
    worker.terminate();
    if (active) { clearTimeout(active.timer); active.reject(error); active = null; }
    for (const request of waiting.splice(0)) request.reject(error);
  };
  const pump = () => {
    if (closed || active || !waiting.length) return;
    active = waiting.shift();
    active.timer = setTimeout(() => {
      // WASM cannot be interrupted mid-decode. Terminate the worker on timeout
      // rather than allowing stale compute, memory, and late answers to persist.
      finishWithError(new Error('JXL decode timed out; worker terminated'));
    }, timeoutMs);
    try {
      worker.postMessage({ kind: 'decode', id: active.id, bytes: active.bytes, preferBitmap }, [active.bytes]);
    } catch (error) { finishWithError(error); }
  };
  worker.onmessage = ({ data }) => {
    if (!active || data?.id !== active.id || closed) { disposePayload(data); return; }
    const request = active;
    active = null;
    clearTimeout(request.timer);
    if (data.kind === 'error') { request.reject(new Error(data.message)); pump(); return; }
    if (data.kind !== 'decoded') { disposePayload(data); request.reject(new Error('Invalid decoder response')); pump(); return; }
    try {
      let source;
      let release;
      if (data.bitmap) {
        source = data.bitmap;
        release = () => { try { source.close(); } catch {} };
      } else if (data.rgba) {
        const canvas = document.createElement('canvas');
        canvas.width = data.width;
        canvas.height = data.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2D canvas unavailable');
        context.putImageData(new ImageData(new Uint8ClampedArray(data.rgba), data.width, data.height), 0, 0);
        source = canvas;
        release = () => { canvas.width = 0; canvas.height = 0; };
      } else throw new Error('Missing decoded frame pixels');
      request.resolve({ source, width: data.width, height: data.height, decodeMs: data.decodeMs, totalMs: data.totalMs, transport: data.transport, release });
    } catch (error) { disposePayload(data); request.reject(error); }
    pump();
  };
  worker.onerror = () => finishWithError(new Error('JXL WASM worker failed'));
  worker.onmessageerror = () => finishWithError(new Error('JXL worker message failed'));
  return {
    async decode(blob) {
      if (closed) throw new Error('Decoder closed');
      // Permit the renderer's two-frame predecode, but bound pending data.
      if (waiting.length + (active ? 1 : 0) >= maxPending) throw new Error('JXL decoder queue full');
      if (!blob || blob.size < 2 || blob.size > 4 * 1024 * 1024) throw new Error('Frame exceeds JXL size limit');
      const bytes = await blob.arrayBuffer();
      if (closed) throw new Error('Decoder closed');
      if (waiting.length + (active ? 1 : 0) >= maxPending) throw new Error('JXL decoder queue full');
      return new Promise((resolve, reject) => {
        waiting.push({ id: ++serial, bytes, resolve, reject, timer: null });
        pump();
      });
    },
    // A seek destroys the old buffered player but an in-flight WASM decode
    // cannot be cancelled inside the worker. Replace that worker so stale
    // frames don't monopolize the new seek's first seconds.
    recreate() {
      finishWithError(new Error('Decoder replaced for seek'));
      return createExperimentalJxlDecoder({ timeoutMs, maxPending, preferBitmap });
    },
    close() { finishWithError(new Error('Decoder closed')); },
  };
}
