# YT-JXL-EXP: Tesla Chromium WebAssembly decoder (isolated branch)

**Status:** Draft PR #58 only; WebAssembly implementation wired behind explicit JXL Experimental button **on the unmerged branch**. NOT deployed or merged into production.

## Motivation

Tesla Chromium currently cannot decode JXL through the app's native Blob/ImageBitmap/Image path. The app already has independently encoded JPEG XL frames with the original JXL Experimental button. This branch adds a single-threaded WASM decoder in a Web Worker to avoid a browser update requirement. It does not add a service worker, alter normal MJPEG/WebCodecs, or change any browser default.

## Current baseline

- Decoder: `@jsquash/jxl@1.3.0` (`libjxl` WebAssembly, Apache-2.0); 849,240-byte decoder WASM binary, assets bundled only for this opt-in prototype.
- On Mac mini M1, decoded a real 64x64 JXL fixture in ~23 ms (one initial measured frame).
- On Mac mini M1, a synthetic 1280x720 JXL frame (55 KiB) decoded in ~91 ms steady-state; approximately 11 FPS, below a 12 FPS target **before canvas, audio, network, or Tesla overhead**. This is not evidence of viable Tesla 720p.
- Single-thread worker intentionally avoids COOP/COEP cross-origin isolation headers that may disrupt Cloudflare Access, other shared UI, or browser functionality.

## Implemented

- A dedicated worker with lazy WASM load, strict input/pixel caps, bounded single-flight decoding, timeout, teardown, and errors.
- Separate decoder client with a bounded serialized queue, worker timeout/termination, and ImageBitmap output where supported (RGBA/canvas fallback), with explicit frame release.
- On this **draft branch only**, `app.js` dynamically imports the WebAssembly decoder **only when the JXL Experimental button is pressed and native JXL is unavailable**. The frame-stream player accepts an injected decoder; normal MJPEG and WebCodecs still use their original native paths. WebAssembly JXL frames are capped to 480p at 12 FPS. Failure falls back to MJPEG. A new visit always defaults to MJPEG/WebCodecs, never restores JXL. No production deployment.

## Next acceptance gates

1. **Completed browser smoke:** Chrome worker decoded 64x64, rejected invalid data, and decoded 360p/480p/720p samples. Unused page loaded no WASM. ImageBitmap path and RGBA fallback passed; two queued frames decoded; closing worker cancelled pending work.
2. **Completed local 480p video-only buffered stream smoke:** Chrome rendered 16/16 multipart JXL 480p frames with zero drops; malformed 4th frame produced a controlled decode error. Actual app mode test proved only JXL click starts worker; switching mode terminates worker, reload forgets JXL, unsupported encoder denies switch, and corrupt JXL stream switches to MJPEG. **Still required:** parked Tesla 480p FPS/thermal/memory, actual video audio synchronization and seeking.
3. **Implemented only in draft PR #58:** native-JXL-first then lazy WebAssembly fallback behind explicit JXL Experimental click, capped 480p/12 FPS, automatic MJPEG return on corrupted JXL, and no decoder instantiation in normal MJPEG/WebCodecs. These remain isolated until approval and rollout.
4. If sustained 720p decoding cannot meet playback pace on Tesla, do not deploy the WASM player; prefer the native MJPEG/WebCodecs pathways or a more efficient codec.

**Rollback:** delete/revert this branch; it has no launchd, Mac FFmpeg, runtime, or public site effects. When future integration is approved, use a separate production PR, release bundle, live canary and rollback archive.

## Reproduce the browser smoke

From `webapp`, run `npm ci`, `npm test`, and `npm run test:jxl-wasm`. Three synthetic 360p/480p/720p JXL fixtures are committed with this draft branch; the tests launch an isolated temporary HTTP server and Chrome. No public site or running service is changed.

## October 21 continued work — measured integration checks

- Source branch: `experiment/jxl-wasm-tesla-20261021`; draft [PR #58](https://github.com/ameshalexk/yt-streamer-webapp/pull/58), **do not merge/deploy**.
- Synthetic M1 Chrome steady-state worker decode: 360p ~24–30 ms, 480p ~41–47 ms, 720p ~90–99 ms. The first frame includes startup overhead and can be slower. The 720p CPU decode path does not meet 12 FPS.
- New worker uses OffscreenCanvas/ImageBitmap transfer where available, RGBA fallback otherwise, limits in-flight queue, cancels on close, terminates hung workers, and reports per-worker decode times.
- Native simulated multipart 480p test: 16/16 decoded/drawn, zero drops; corrupt JXL produced a decoder error. Mode-click browser test: one worker launched only after JXL press, worker terminated on MJPEG selection, JXL localStorage reset on reload, encoder-unavailable path rejected and terminated worker, corrupt stream invoked MJPEG fallback.
- Local `npm run check`, `npm test`, and `npm run test:jxl-wasm` pass. Synthetic fixture samples are committed under `webapp/test/fixtures/jxl-wasm`; CI on both macOS and Ubuntu now runs the browser smoke command. CI result remains **unverified until new PR checks complete**.
- 480p is a **test candidate**, not guaranteed Tesla performance. No vehicle/browser firmware changes, no user video playback tested, no Mac/HA runtime updated.
