// Standalone worker-backed JXL frame decoder, not attached to production playback.
// Future buffered-player wiring MUST require the user's JXL Experimental click.
export function createExperimentalJxlDecoder({ timeoutMs = 5000 } = {}) {
  const worker = new Worker(new URL('./decoder-worker.mjs', import.meta.url), { type: 'module' });
  const requests = new Map();
  let serial = 0;
  let closed = false;
  worker.onmessage = ({ data }) => {
    const pending = requests.get(data?.id);
    if (!pending) return;
    requests.delete(data.id);
    clearTimeout(pending.timer);
    if (data.kind === 'error') { pending.reject(new Error(data.message)); return; }
    if (data.kind !== 'decoded') { pending.reject(new Error('Invalid decoder response')); return; }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.rgba), data.width, data.height), 0, 0);
      pending.resolve({ source: canvas, width: data.width, height: data.height, decodeMs: data.decodeMs, release() { canvas.width = 0; canvas.height = 0; } });
    } catch (error) { pending.reject(error); }
  };
  worker.onerror = () => {
    for (const [id, pending] of requests) {
      clearTimeout(pending.timer); pending.reject(new Error('JXL WASM worker failed')); requests.delete(id);
    }
  };
  return {
    async decode(blob) {
      if (closed) throw new Error('Decoder closed');
      if (requests.size > 0) throw new Error('JXL WASM decoder busy'); // no unbounded memory queue
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Frame exceeds 4 MiB');
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { requests.delete(id); reject(new Error('JXL decode timed out')); }, timeoutMs);
        requests.set(id, { resolve, reject, timer });
        worker.postMessage({ kind: 'decode', id, bytes }, [bytes]);
      });
    },
    close() {
      closed = true;
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Decoder closed')); }
      requests.clear(); worker.terminate();
    },
  };
}
