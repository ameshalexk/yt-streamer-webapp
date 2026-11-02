# TeslaMon Moonshine Tiny Streaming (WASM) — experimental branch

**Status:** prepared for controlled Tesla browser testing only. Not deployed, merged, or enabled as the production engine.

## Why this is separate

- Whisper Base previously crashed the Tesla browser; a smaller downloaded model does not establish low peak RAM.
- Moonshine's published WASM 0.1.5 uses pthreads / SharedArrayBuffer and therefore needs COOP + COEP headers on the *top-level document*. Adding them to all YT Streamer pages could block third-party media.
- Only `/teslamon-moonshine-lab.html` has cross-origin-isolation headers. Main YT Streamer routes, player, Aura, wake-word handling and Whisper Tiny default remain unchanged.
- This branch adds `moonshine-tiny-streaming` to the shared local STT adapter but **does not add it to the production model selector**. The laboratory page alone opts into it.
- Moonshine is fetched from the pinned package `@moonshine-ai/moonshine-wasm@0.1.5` via jsDelivr; model weights download via `download.moonshine.ai`. Microphone audio is not uploaded. Future production use should self-host, pin and audit all assets.
- The existing 16-second decoded audio limit is enforced and one transcription runs at a time. Cancel/error/timeout terminates the experiment worker to reclaim memory.
- Recording is not fed into a second microphone; the lab uses the same TeslaMon `createTeslaMonCapture` and `decodeRecordedAudio` pipeline and passes mono 16 kHz PCM to a Moonshine WASM worker.

## Manual release gate

1. Serve this branch in a *test environment only*, not the live Cloudflare tunnel. Confirm the lab is cross-origin isolated and that the CDN scripts/model files load under COEP.
2. Try cold-load, warm-load, cancellation and 10–20 short voice commands on the actual Tesla browser; confirm no page reload/crash.
3. Measure model transfer bytes, peak browser memory (where available), latency and command accuracy; keep the existing Whisper Tiny baseline for comparison.
4. Test microphone stop/release, multiple consecutive commands, rapid cancel/restart, background tab, wake-word coexistence, and concurrent 720p playback separately before enabling it in Aura.
5. Only after successful testing, decide how to provide cross-origin isolation (or a verified single-thread build) without breaking IPTV, MJPEG, video streams or embeds. Do not change global response headers speculatively.
6. Create a reviewed production PR and an explicit deployment approval. Rollback = switch to Whisper Tiny and remove the experiment flag.

## References

- https://github.com/moonshine-ai/moonshine/blob/main/docs/quickstart.md
- https://www.npmjs.com/package/@moonshine-ai/moonshine-wasm

This document doubles as the project decision log. Obsidian vault is read-only from the currently connected Obsidian integration.
