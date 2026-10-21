# YT-JXL-EXP: Tesla Chromium WebAssembly decoder (isolated branch)

**Status:** Experimental spike only; NOT merged, deployed, or activated in the normal player.

## Motivation

Tesla Chromium currently cannot decode JXL through the app's native Blob/ImageBitmap/Image path. The app already has independently encoded JPEG XL frames with the original JXL Experimental button. This branch adds a single-threaded WASM decoder in a Web Worker to avoid a browser update requirement. It does not add a service worker, alter normal MJPEG/WebCodecs, or change any browser default.

## Current baseline

- Decoder: `@jsquash/jxl@1.3.0` (`libjxl` WebAssembly, Apache-2.0); 849,240-byte decoder WASM binary, assets bundled only for this opt-in prototype.
- On Mac mini M1, decoded a real 64x64 JXL fixture in ~23 ms (one initial measured frame).
- On Mac mini M1, a synthetic 1280x720 JXL frame (55 KiB) decoded in ~91 ms steady-state; approximately 11 FPS, below a 12 FPS target **before canvas, audio, network, or Tesla overhead**. This is not evidence of viable Tesla 720p.
- Single-thread worker intentionally avoids COOP/COEP cross-origin isolation headers that may disrupt Cloudflare Access, other shared UI, or browser functionality.

## Implemented

- A dedicated worker with lazy WASM load, strict input/pixel caps, bounded single-flight decoding, timeout, teardown, and errors.
- A separate frame decoder client returning a drawable canvas and release method.
- Bundled decoder sources/assets. They are not imported by `app.js` or `buffered-mjpeg.js`; regular playback remains unchanged.

## Next acceptance gates

1. **Completed local browser smoke:** Chrome worker decoded 64x64, rejected invalid data, and decoded 1280x720 frames in 109 / 93 / 94 ms. WASM fetched only after decoder use (1 request); idle page fetched none. No normal player integration.
2. Benchmark 480p/720p and memory/copy overhead in Tesla's *parked* browser. Test audio synchronization, seeking and errors with synthetic content first.
3. Gate wiring behind the JXL Experimental button with native-first then WASM fallback, never automatic on initial load or page reload. Retain MJPEG fallback and prevent decoder creation for ordinary MJPEG/WebCodecs.
4. If sustained 720p decoding cannot meet playback pace on Tesla, do not deploy the WASM player; prefer the native MJPEG/WebCodecs pathways or a more efficient codec.

**Rollback:** delete/revert this branch; it has no launchd, Mac FFmpeg, runtime, or public site effects. When future integration is approved, use a separate production PR, release bundle, live canary and rollback archive.

## Reproduce the browser smoke

From `webapp`, run `npm ci` then `node scripts/jxl-wasm-browser-smoke.mjs`. Synthetic 720p source is generated separately with the isolated JXL-enabled FFmpeg; the sample is not committed. No public website or running server changes are required.
