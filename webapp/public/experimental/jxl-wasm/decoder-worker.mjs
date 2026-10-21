// Experimental only: never imported by normal playback. Apache-2.0 libjxl WASM.
import decode, { init } from './vendor/decode.js';
let ready;
function ensureReady() {
  if (!ready) ready = (async () => {
    const response = await fetch(new URL('./vendor/codec/dec/jxl_dec.wasm', import.meta.url));
    if (!response.ok) throw new Error('JXL WASM asset unavailable');
    await init(await WebAssembly.compile(await response.arrayBuffer()));
  })();
  return ready;
}
let offscreenCanvas;
let offscreenContext;
self.onmessage = async ({ data }) => {
  if (data?.kind !== 'decode') return;
  const { id, bytes, preferBitmap = true } = data;
  try {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 2 || bytes.byteLength > 4 * 1024 * 1024) {
      throw new Error('Unsupported JXL frame size');
    }
    await ensureReady();
    const started = performance.now();
    const frame = await decode(bytes);
    const { width, height } = frame;
    if (!width || !height || width > 1920 || height > 1080 || frame.data.byteLength !== width * height * 4) {
      throw new Error('Unsupported decoded frame dimensions');
    }
    const decodeMs = Math.round(performance.now() - started);
    const pixels = new Uint8ClampedArray(frame.data);
    // Transfer the drawable image instead of copying a multi-megabyte RGBA
    // buffer onto the UI thread. Preserve an RGBA fallback for older Chromium.
    if (preferBitmap && typeof OffscreenCanvas === 'function' && typeof ImageData === 'function') {
      try {
        if (!offscreenCanvas || offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
          offscreenCanvas = new OffscreenCanvas(width, height);
          offscreenContext = offscreenCanvas.getContext('2d', { alpha: false });
        }
        if (!offscreenContext || !offscreenCanvas.transferToImageBitmap) throw new Error('Worker canvas unavailable');
        offscreenContext.putImageData(new ImageData(pixels, width, height), 0, 0);
        const bitmap = offscreenCanvas.transferToImageBitmap();
        self.postMessage({ kind: 'decoded', id, width, height, bitmap, decodeMs, transport: 'bitmap', totalMs: Math.round(performance.now() - started) }, [bitmap]);
        return;
      } catch {
        // Some embedded browsers expose OffscreenCanvas but cannot transfer
        // bitmaps; fail back to transferable RGBA without affecting decoding.
      }
    }
    self.postMessage({ kind: 'decoded', id, width, height, rgba: pixels.buffer, decodeMs, transport: 'rgba', totalMs: Math.round(performance.now() - started) }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ kind: 'error', id, message: String(error?.message || error) });
  }
};
