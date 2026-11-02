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

## Model selector fix and deployment — Nov 2, 2026

User reported on iPhone that tapping the transcription model dropdown did nothing while the TeslaMon badge showed **Mic On**. Root cause: `isSttModelLocked()` disabled the selector whenever hands-free was enabled, including passive wake standby.

Fix:
- Allow selection when the hands-free engine is passively `listening`, but keep the selector locked during startup, recording, transcription, pending commands, and other active work.
- Selecting any model while listening stops the wake detector, releases microphone tracks, and disables automatic re-arming. For Whisper Tiny/Base the selected model persists and the user must tap Mic On to resume.
- Selecting **Moonshine Tiny — Experimental test page** opens the cross-origin-isolated lab page; Moonshine still does not replace production command execution.
- Added a synthetic mobile Chrome regression test for Mic On → Whisper model switch → Mic Off and Mic On → Moonshine lab navigation.

Verification: `node scripts/teslamon-handsfree-browser-check.mjs` passed; 13 related local STT tests passed; syntax checks passed. Mac mini runtime revision `aa3c3db6102e250c5b09f99a6f0ef50f95f09729` deployed and HTTP health + source + lab header checks passed. Runtime backup: `~/.cache/ytstreamer-selector-rollback.8txDtf`. Physical Tesla browser transcription remains a manual test.

## In-page selector implementation — deployed Mac, Nov 2, 2026

User requested Moonshine to behave as a **third model choice** in the normal TeslaMon transcription selector, not redirect to a separate lab.

- Selector option is now `moonshine-tiny-streaming`. Selecting it from Whisper turns Mic Off, saves the choice, and reloads the **same YT Streamer page** with `?tm_stt_mode=moonshine`, preserving other query parameters and the New/Classic UI.
- Server applies `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` **only to the main player HTML** when explicitly in Moonshine mode. Normal Whisper and other routes retain existing headers.
- On the reloaded page the existing TeslaMon `createTeslaMonLocalStt` engine selects Moonshine, using the same PTT, hands-free, Aura and Codex-command transcription pipeline as Whisper.
- Selecting Whisper Tiny or Base from Moonshine mode reloads the same page without isolation, restoring normal media embedding behavior. The separate lab URL remains available for diagnostics but is no longer used by the selector.
- If a browser cannot provide `crossOriginIsolated`, the UI indicates that Moonshine is unavailable and offers the regular Whisper choices.
- Updated `index.html` TeslaMon module cache version so existing browsers fetch the new selector.

**Validation:** Full local Node suite 704/704 passing; synthetic Chrome UI model-switch test passed for Mic On → Moonshine same-page isolation → Whisper no isolation, with the player and voice controls retained. A real WASM integration test within a simulated normal YT Streamer page using a generated local audio fixture recognized **“Play YouTube.”** (cold/model-load/decoding 3874 ms; inference 192 ms), no JavaScript or model network errors in that test. Actual iPhone/Tesla memory stability and third-party video playback under COEP remain unverified.

**Mac deployment:** Runtime revision `cfee853e961bc0ad759c69dc08785d64440c436e`, health and exact HTTP header/source checks passed. Scope: Mac mini only; existing HA/StreamHA deployment was not changed. Runtime rollback: `~/.cache/ytstreamer-inpage-rollback.QtQdWP`. PR #134 remains draft and unmerged. Because other YT Streamer releases may also be in progress, reconcile host revisions and preserve the Moonshine experiment before any later full-app overwrite.
