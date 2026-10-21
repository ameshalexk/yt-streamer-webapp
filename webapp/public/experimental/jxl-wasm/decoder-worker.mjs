// Isolated experiment: only loaded by an explicit JXL decode request.
// Uses Apache-2.0 @jsquash/jxl 1.3.0; no service worker and no site-wide intercepts.
import decode, { init } from './vendor/decode.js';
let ready;
function ensureReady() {
  if (!ready) ready = (async () => {
    const response = await fetch(new URL('./vendor/codec/dec/jxl_dec.wasm', import.meta.url));
    if (!response.ok) throw new Error('JXL WASM asset unavailable');
    const module = await WebAssembly.compile(await response.arrayBuffer());
    await init(module);
  })();
  return ready;
}
self.onmessage = async ({ data }) => {
  if (data?.kind !== 'decode') return;
  const { id, bytes } = data;
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
    const rgba = new Uint8ClampedArray(frame.data);
    self.postMessage({ kind: 'decoded', id, width, height, rgba: rgba.buffer, decodeMs: Math.round(performance.now() - started) }, [rgba.buffer]);
  } catch (error) {
    self.postMessage({ kind: 'error', id, message: String(error?.message || error) });
  }
};
