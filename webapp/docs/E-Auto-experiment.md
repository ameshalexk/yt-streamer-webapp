# E Auto experimental JPEG player

Status: experimental on `experimental/e-auto`. Normal Low, Medium, High, and Auto remain available and keep their existing multipart-MJPEG path. Roll back to tag `pre-e-auto-v2.1-20260915` or commit `0d33e4c`.

## Architecture

Normal Auto asks ffmpeg for multipart MJPEG, parses browser stream chunks with the existing buffered player, decodes JPEGs, and renders to canvas. Its existing quality controller and policies are intentionally unchanged. Audio is a separate request and remains the master clock.

E Auto asks the same server endpoint for `eauto=1`. ffmpeg emits JPEG `image2pipe`; the server splits complete JPEGs and prepends a fixed 48-byte EAJF v1 header. The browser uses `fetch()` and `ReadableStream`, incrementally parses EAJF, bounds the frame queue by time and bytes, decodes with `createImageBitmap()`, and renders to canvas. Every seek/profile restart rotates the numeric session id, aborts the old response, and clears/rejects stale frames.

No HLS, DASH, WebRTC, or inter-frame video codec is used. hls.js inspired the dual-EWMA and cautious upgrade policy only. The implementation is original and does not copy hls.js source; hls.js itself is Apache-2.0 licensed.

## EAJF v1 framing

All integers are unsigned and network-endian. Each record is `[48-byte header][JPEG bytes]`.

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `EAJF` |
| 4 | 1 | version (`1`) |
| 5 | 1 | header length (`48`) |
| 6 | 4 | session id |
| 10 | 4 | frame sequence |
| 14 | 8 | video timestamp, microseconds |
| 22 | 8 | server frame timestamp, milliseconds |
| 30 | 4 | JPEG byte length |
| 34 | 2 | FPS multiplied by 100 |
| 36 | 1 | ffmpeg JPEG `q:v` |
| 37 | 1 | profile id |
| 38 | 2 | width |
| 40 | 2 | height |
| 42 | 6 | reserved |

The parser validates protocol version, lengths, memory ceilings, and JPEG SOI/EOI markers. Malformed input is resynchronized where possible; truncated EOF is an error.

## Adaptation and synchronization

The bandwidth estimate is the lower of fast (3-second half-life) and slow (9-second half-life) EWMAs sampled from HTTP response chunks. Decisions also use buffer trend/health, rebuffer state, frame render ratio, decode pressure, and drop ratio. Estimated bandwidth alone cannot trigger an upgrade.

Profiles, from lowest to highest, are `360p/8/Q18`, `360p/12/Q12`, `480p/15/Q7`, `480p/18/Q5`, and `720p/24/Q4`. Pressure causes one quick downshift after cooldown. An upgrade requires sustained healthy buffer and pipeline headroom for 15 seconds. Buffer targets range from 1.5 to 5.5 seconds and rise after pressure/stalls; they never grow without bound.

At render time, audio is authoritative. Frames older than the allowed sync window are released, not displayed. If several are obsolete, the renderer skips ahead to the newest appropriate frame. `ImageBitmap` and Blob references are explicitly released when frames render, drop, abort, or leave the bounded queue.

## Instrumentation

The diagnostics panel and end-of-session summary track startup, first JPEG/render/audio, buffer average/minimum, stalls and duration, rebuffers, bytes, effective FPS, EWMA bandwidth, selected profile parameters, receive/render/drop/late counts, decode/render time, and absolute A/V drift. The panel prints factual Auto-to-E-Auto deltas without declaring a winner. Debug messages are grouped under `[EAUTO:NET]`, `[EAUTO:ABR]`, `[EAUTO:BUFFER]`, `[EAUTO:FRAME]`, `[EAUTO:DECODE]`, `[EAUTO:SYNC]`, `[EAUTO:DROP]`, and `[EAUTO:PROFILE]`; routine operation avoids per-frame console output.

## Current evidence

- Full automated suite: 113 passing tests. Deterministic ABR simulations cover high headroom, low bandwidth, sudden collapse, sustained recovery, jitter/cooldown, interruption, and bounded adaptive buffering. Regression tests also cover parser allocation ceilings and preserving every framed JPEG through HTTP backpressure.
- Isolated server transport: a 12-second 640x360 fixture produced 144 ordered EAJF frames (sequence 0–143), session 77, 12 FPS, Q7, and 2,133,160 JPEG bytes. The normal endpoint retained its multipart content type and framing.
- Desktop Chromium local control test: first picture/audio playback, pause, resume, and +10-second seek worked. The post-seek stream used a new session and did not show old queued frames. The automated fullscreen behavior tests pass; native fullscreen could not be asserted in the in-app background browser surface.
- One matched 10-second localhost sample measured Auto/E Auto startup at 1.704/1.729 seconds, near-zero-duration buffer transitions at 2/1, video rate at 4.89/3.26 Mbps, absolute A/V drift at 6.15/7.96 ms, and 0% dropped frames for both. In that run E Auto used 33.3% less video bandwidth but started 1.5% slower and had 29.5% more absolute drift. Treat this as a smoke-test sample, not a conclusion: localhost, one synthetic clip, and one run are not enough to choose a mode.

CPU/RAM measurements on iPhone Safari and the production Mac mini have not yet been collected. The initial pre-deploy checkpoint did not change or restart production; on 2026-09-17, the tested `experimental/e-auto` commit `e585d7d` was deployed to the public runtime as an explicitly experimental comparison mode. JPEG remains materially less bandwidth-efficient than an inter-frame codec; this experiment only improves delivery control, adaptation, and synchronization choices.

## Resume checklist

1. Treat the current public E Auto deployment as experimental and keep the rollback tag `pre-e-auto-v2.1-20260915` available before further changes.
2. Run repeated matched Auto/E Auto sessions through actual bandwidth, latency, jitter, collapse, and recovery shaping; export the session summaries.
3. Profile server ffmpeg CPU/RSS and browser CPU/memory on desktop Chromium and iPhone Safari.
4. Verify native fullscreen and long pause/resume/seek on iPhone Safari.
5. Keep or remove components based on measured outcomes. The framing/parser tests, session-id stale-frame guard, bounded queue, audio-clock drop policy, and A/B metrics are independently useful even if E Auto is removed.

## Public deployment checkpoint — 2026-09-17

- `experimental/e-auto` commit `e585d7d` is deployed through `scripts/deploy-runtime.sh` to the Application Support runtime; runtime data remains excluded from synchronization.
- `com.ytstreamer.webapp` was restarted and `/api/health` returned `ok: true` with zero active streams during verification.
- `https://stream.ameshalex.com` exposes separate `Auto` and `E Auto` controls. Normal Auto remains on its existing path; E Auto is selected with `data-stream-profile="e-auto"` and its bundle is present.
- Rollback is `pre-e-auto-v2.1-20260915` / `0d33e4c`. The active `apne-pagination` checkout was not switched or modified.
