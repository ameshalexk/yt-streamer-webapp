# TeslaMon shared browser-local STT — Mac-only release (2026-10-24)

## Scope and design

TeslaMon Play is the canonical static source of the quantized Xenova/whisper-tiny.en
browser-local STT implementation. Its pinned Transformers.js 3.8.1, single-thread
WASM and model assets remain under the relative `/games/` package. The main
Streamer's `teslamon-local-stt.js` lazily imports `/games/voice-engine.js` and
`/games/recorded-audio.js`; PTT and Hey Jarvis command recordings use the same
in-memory VoiceEngine instance per document.

Whisper transcribes **only completed command clips**. `teslamon-handsfree.js`
continues to own the separate openWakeWord/ONNX Hey Jarvis detection, foreground
activation and mic policy. The two WASM runtimes use isolated workers and
versioned, separate asset directories. No ambient audio is passed to Whisper.
There is no server/cloud/STT fallback. The client sends **text only** to its
existing signed `/api/teslamon/plan` endpoint and keeps the same candidate,
same-tab selection, authorization and observed playback logic. Typing and quick
controls remain available on local decode/model/microphone failures.

Model CacheStorage entries use the unchanged `/games/models/whisper-tiny-en-79fb389`
URLs so saved files are reusable from Streamer root and game on the same origin.
Only the same page can reuse a worker in RAM. A separate tab or full navigation
needs a new worker/inference initialization; browser storage may evict weights.
The UI distinguishes saved-file reads, fetching, initialization and transcription.

The game remains a complete independent static HTTPS package. It gains an
optional Blob-to-PCM adapter; it requires no YT Streamer API or runtime. The
Streamer repository tracks the built game assets (including one set of ~65.5 MB
WASM/model files) in `webapp/public/games/`. The existing
`scripts/package-release.py` archives tracked `webapp/` files into an immutable
bundle, and `webapp/scripts/deploy-runtime.sh` rsyncs without deleting runtime
data or pruning existing files. Later Streamer releases therefore include the
game, shared modules and model weights as part of their reviewed source SHA.
Do not replace this folder with an older, incomplete game release.

## Verification performed in isolated source worktrees

- Game `npm test`: 34/34; build validates exact pinned model/runtime SHA-256.
- Streamer full `npm test`: see final release receipt for count; `npm run check` passed.
- Chrome synthetic mic fixture (unmocked transcription): real MediaRecorder ->
  browser AudioContext decode -> 16 kHz PCM -> single Whisper WASM worker ->
  full natural-language transcript -> existing planner -> same-tab video frame
  progress. Two recordings used one worker/load, two inferences, model cache 7/7,
  no `/api/teslamon/transcribe` requests. Planner received the full phrase
  "Please play a video about the fabric of space and time."
- Chrome game controlled AudioWorklet/WASM: quiet and repeated Jump, Roll, Sit,
  Spin each visibly animated; unknown/silence/denied mic never executed a
  trick. Finish worked; Stop and simulated hidden page released tracks and
  blocked stale actions. Reload reused 7/7 saved model files with no new model
  HTTP requests, but correctly started a new per-page worker.
- Existing Chrome auto-wake Mic On/Off check passed without ambient upload.
- TeslaMon panel: classic/new UI at 320,375,390,430, iPad portrait/landscape
  and 844x390 landscape; all 14 Chrome-emulated layouts fit safe areas with
  44px+ controls and no horizontal overflow. Existing player mobile test
  passed 10/10 standard cases. Extending *its recommendation auto-scroll
  assertion* to 1024x768 revealed an offscreen player behavior not modified
  by this STT task; do not treat that extra assertion as passing.
- Review: separate read-only code reviewer identified import versioning and
  in-flight cancellation gaps; both were corrected with versioned imports
  and new cancellation/dispose tests, then reviewer reported no blocker.
- Controlled speech and Chrome emulation are **not** authenticated owner-profile,
  actual Tesla, or real iPhone Safari microphone acceptance.

## Release and rollback

Source game worktree: `/Users/amesh/Developer/teslamon-play-shared-stt-20261024`.
Source Streamer worktree: `/Users/amesh/Developer/ytstreamer-shared-local-stt-20261024`.
Mac production only. Home Assistant, DNS/Cloudflare Access, paid STT, Tesla Fleet
and unrelated services must not be deployed or changed.

Release gate: both-platform shared GitHub CI from exact immutable SHA, independent
review, scoped backup, zero active sessions/jobs, then staged extracted Mac bundle
installed with `webapp/scripts/deploy-runtime.sh`, restarting only
`com.ytstreamer.webapp`. Preserve `data`, signed native audio tap, auth and
system integrations. Verify live `/api/health` SHA, authenticated HTTPS
`/` and `/games/`, all hashed worker/model assets, content types/cache headers,
selected-tab playback (actual frames, not command acceptance) and both voice
controls. Back up production code and the prior `public/games` package; rollback
restores those precise code assets with the old release revision, then restarts
only the Mac LaunchAgent, leaving runtime data untouched.

The exact Git/source release SHA, staged bundle, CI run, backup receipt,
deployment time, production smoke and remaining real-device checks will be
added at release handoff. Do not claim deployment solely from this file.
