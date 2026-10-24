# TeslaMon Play

A standalone static dog-trick game for rear passengers using the Tesla main screen. The touch demo works without a vehicle connection or account.

It includes a large TeslaMon puppy, idle tail wag and blinking, Jump, Roll over, Sit, Spin, Stop, optional tap-to-speak, and opt-in hands-free listening. It does not use vehicle APIs, YT Streamer, Home Assistant, Codex, PowerALX, analytics, or stored recordings.

The game is ready as soon as the page loads. There is no Start button or in-app fullscreen request; the page uses the available browser viewport, and the “Full screen” label is informational.

The Motion control selects Gentle or Playful animation. It initially follows the system's Reduce Motion preference. Gentle keeps visible, short trick movements and disables idle loops; Playful enables the full tricks and tail wag. An explicit choice is saved locally for this game without changing system settings.

## Run and build

Build and preview the portable static site:

    npm ci --ignore-scripts
    npm run prepare:voice
    npm run build
    cd dist
    python3 -m http.server 8080

Open http://localhost:8080. Localhost is commonly treated as a secure context for browser permissions.

The self-hostable site is written to dist/. The build adds content-based version strings to local CSS and JavaScript URLs so browsers load updated files after each build. It can be served from a static HTTPS host or a subdirectory. No runtime packages are required. Run the focused phrase tests with npm test.

## Voice and platform limits

The first manual mic-button tap **prepares voice with the microphone off**. Wait for **Voice ready**, then tap Speak to record. Saved model files are reused; opening/reloading the page still initializes the model in memory. Subsequent recordings on the same page reuse that ready model. Alternatively, tap **Hands-free: Off** once to enable continuous local trick listening; the model is prepared before any microphone is opened. The button stays disabled while preparing/transcribing; during listening, tap **Finish speaking** to submit early. **Stop** cancels.

Tap-to-speak records one bounded utterance (up to 7 seconds, ending after roughly 1 second of silence). Hands-free mode also listens for bounded speech segments, then locally transcribes only each detected segment and automatically re-arms without closing the microphone between tricks. **Quantized Whisper Tiny English runs locally in a dedicated WebAssembly worker**, using Transformers.js 3.8.1 and one CPU thread. No native browser speech service, remote STT, Mac, PowerALX or vehicle API is involved. Audio is processed in memory and discarded; transcripts appear on screen until the next attempt/page reload and are not persisted.

First use downloads about **65 MB** of same-origin code/model assets. Model weights use the browser Cache API when available; the worker stays warm for later taps. A cold download may take time on cellular. Stop cancels capture/inference and ignores stale results; Stop also cancels pending model preparation. Hidden pages stop capture and discard pending actions. Touch buttons remain available while voice prepares. Listening shows a live microphone level; transcription shows elapsed processing time and never claims to be downloading the model. Cache status is checked against the actual model files; if browser storage is unavailable, the game says so. A quiet/silent mic is distinguished from a mic that sends no audio frames.

Say anything containing a supported word/phrase, such as “Liam says please jump for us!” or “Hey doggy, roll over, that is funny.” Matching uses complete words, with the first recognized command in spoken order winning. It accepts Jump (hop/leap), Roll over (roll), Sit (sit down), and Spin (turn around). Unknown speech does nothing. This is simple phrase matching: a negated command such as “do not jump” still contains Jump and triggers it. Whisper Tiny can mishear children/noise; cabin acceptance is required.

Requires HTTPS (or localhost), microphone permission, Web Audio/AudioWorklet, module workers and WebAssembly SIMD. It does not require WebGPU, SharedArrayBuffer or cross-origin isolation. The owner reports microphone support on recent Tesla firmware; recognition speed and reliability in the target Tesla still require device testing. No parked-only condition or vehicle restriction bypass is included.

Assets are self-hosted under `models/` and `vendor/`; runtime model downloads from Hugging Face are disabled. `npm run prepare:voice` fetches the pinned model revision and verifies SHA256s in `assets-manifest.json`; `npm run build` verifies them again. Keep the entire generated `dist/` together. Model/runtime binaries and node_modules are excluded from Git; another host can reproduce them with the commands above. The optional macOS fixture generator is `python3 scripts/make-audio-fixtures.py` (requires ffmpeg); fixture audio is excluded from releases.

## Asset attribution

The inline puppy is adapted from `webapp/public/teslamon-pet.js` at source revision `defce26b68090435eccf783c042cc8543efd467b` in the TeslaMon/YT Streamer codebase. Only the dog artwork and palette were extracted; no YT Streamer modules or runtime are included. Whisper Tiny English ONNX is from Xenova/whisper-tiny.en at revision `79fb389fc764e7c395bd330e9531d9d32ada7049` (Apache-2.0). Transformers.js is Apache-2.0; ONNX Runtime is MIT. License notices and the model card are bundled in the static release.

## Verification limits

Deployed on 2026-10-24 at https://stream.ameshalex.com/games/ using the existing Stream Cloudflare sign-in. The original touch release was source revision `b60d489cedf8e0891a978406a146dd656f864236`; the local WASM voice release and current deployed source are recorded in verification/wasm-voice.md. See [deployment verification and rollback](verification/deployment.md).

Responsive layout and interaction checks in desktop Chrome emulation do not establish real iPhone Safari or Tesla acceptance. Tesla browser rendering, browser-level fullscreen behavior, voice, performance over time, and cabin-noise recognition still require real-device testing. No DNS change, public source-repository publication, or vehicle test has been performed.

## Shared browser-local transcription

The static package also exports `voice-engine.js` (the single-thread Whisper
Tiny English WASM worker client) and `recorded-audio.js` (a local
MediaRecorder Blob-to-16 kHz mono converter). Other pages on the **same origin**
can import those modules from the mounted game directory, e.g.
`/games/voice-engine.js` and `/games/recorded-audio.js`. Both pages then use
the identical `/games/models/` and `/games/vendor/` URLs, allowing the browser's
same-origin CacheStorage files to be reused. There is only one weight copy in
the hosted package. Each full page or tab initializes its own worker in RAM;
recordings on the same page reuse its loaded worker until cancellation or page
cleanup. CacheStorage may be evicted by the browser.

This optional export does **not** depend on YT Streamer or its APIs. The game
remains complete and self-hostable as a static HTTPS directory with relative
asset URLs. Whisper only transcribes manually captured utterances or speech segments after the user explicitly enables hands-free; it is not a wake-word detector. Errors stay local and the game keeps its touch controls.

## Opt-in hands-free mode

**Hands-free: Off** is the default every time the page opens. The toggle requires a real user tap and browser microphone permission. Once enabled, the game first prepares the local Whisper model while the microphone remains **OFF**. It then opens one live microphone stream, monitors audio levels for speech, transcribes a short phrase after speech ends, performs any matching trick, and automatically listens for the next trick. There is no repeated Speak tap, no Hey Jarvis requirement, and no network STT request. A single model/worker is reused for successive phrases.

The toggle turns **green / On** only while the continuous capture is active; **Off** releases microphone tracks and cancels pending work. Stop, changing motion mode, leaving/hiding the page and full navigation also disable continuous capture. Manual tap-to-speak and touch tricks stay available when hands-free is Off; manual Speak is disabled while the continuous mic owns capture. During transcription the microphone stays open, but incoming audio frames are not queued for overlapping inference. Very quiet children, loud background noise, and Tesla browser power/resource limits require physical testing. Continuous listening uses more power than push-to-talk; only enable it when someone is playing.
