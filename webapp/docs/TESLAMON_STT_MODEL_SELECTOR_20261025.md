# TeslaMon local transcription model selector — 2026-10-25

The dog panel offers one transcription model at a time, separate from the four
existing wake phrase checkboxes. Wake detection remains official pretrained
openWakeWord Hey Jarvis, Alexa, Hey Mycroft and Hey Rhasspy. This feature does
not add new wake words or change thresholds.

- **Whisper Tiny English — Fast**: original q8 default, about 41 MB of weights.
- **Whisper Base English — Better quality**: q8 option, about 77 MB of weights,
  79,041,253 bytes including tokenizer/configuration. Larger capacity, expected
  slower inference/more working memory; no guarantee of any individual accent
  or command improvement. Both choices are English-only.

OpenAI Whisper is the model family. Browser ONNX conversions are from Xenova,
compatible with the already bundled Transformers.js 3.8.1. Base is pinned to
revision `95bf40a508535962c6483ead40270b2e32267508`. Source URLs, SHA-256 hashes,
byte counts and Apache-2.0 attribution: `public/games/base-model-manifest.json`.
The existing Tiny revision and model URLs remain unchanged.

## Behavior

Selection is remembered per browser under `ytStreamerTeslaMonSttModelV1`.
Missing/invalid values select Tiny. Turn Mic Off and finish active PTT,
transcription or planner/player operations before switching. Changing models
terminates the previous worker before creating the next selected model; it
never leaves both model workers alive. First command lazily fetches only the
selected model from the same origin, reusing saved CacheStorage entries when
available. Existing progress, errors, elapsed transcription time and typed
command fallback remain available. No silent model fallback or server/cloud
transcription is added; recorded audio stays inside the page.

`new VoiceEngine()` and the independently hosted game continue using Tiny by
default. Shared engine/worker support Base without changing game vocabulary
or adding a game model chooser. Keep registry/worker additions when refreshing
the compiled game package from its independent source.

## Verification

In `webapp/`, run normal `npm run check`, `npm test`, mobile-player and panel
layout browser checks. The handsfree browser check additionally exercises
selector locking, persistence and no eager model download. The full local-STT
browser check accepts `TESLAMON_STT_MODEL_ID=whisper-base.en` and a controlled
speech fixture via `TESLAMON_STT_TEST_WAV`.

`teslamon-stt-models-browser-check.mjs` directly runs both actual q8 WASM models
on the same generated speech, twice per model, then switches back to Tiny.
It verifies selected model/cache identity, one active worker maximum, no audio
uploads or external requests, and default Tiny game behavior.

A controlled **3.1676-second** generated clip said “Please play a video about
the fabric of space and time.” Both models transcribed it exactly. Mac Chrome
single-thread WASM warm inference was approximately Tiny **1.5 s** and Base
**3.1 s**. This is a small synthetic local comparison, not Tesla/iPhone speed,
human accent quality, statistical accuracy or network download evidence.

## Release and acceptance boundary

Branch `feat/teslamon-stt-model-selector-20261025`, based on main
`4a73771240c87745f1f8559f73e1d12053422a59`. No live deployment is part of the
implementation lane. Shared release Both platforms passed, reviewed immutable
packaging, idle preflight and scoped rollback backup are required before
promotion. Mac-only existing pilot scope remains; do not install on HA without
its separately authorized rollout.

After an authorized installation, refresh Tesla/iPhone page, open dog and turn
Mic Off. Choose Base, turn Mic On and give the same natural English commands
with the same speaker/noise as Tiny. Compare displayed transcript, missed or
wrong intents, feedback time and observed player outcome. Repeat reload,
Mic Off/hidden-page cleanup, model download failure and return to Tiny.
Chrome emulation does not establish actual iPhone Safari/Tesla acceptance.

## Implemented verification results

- Full local Node suite **637/637**; syntax and whitespace checks pass.
- Direct actual WASM Tiny -> Base -> Tiny: identical controlled transcript,
  selected cache7/7 each time, at most one live worker, no audio/network upload.
- Actual MediaRecorder -> decode -> Base WASM -> authenticated-planner fixture
  -> selected rendered video: two complete commands, one worker/load, two
  inferences, video frames advanced 41 -> 253, all captured tracks stopped.
  This fixture observes rendered playback, not live YouTube or real devices.
- Handsfree UI: four official wake choices unchanged; model choice locked
  while Mic On, restored Base after reload, malformed saved choice -> Tiny,
  no model requests until a transcription, Off ends tracks.
- Panel **14/14** classic/new mobile/tablet/landscape layouts; select target
  >=44px, inside panel, no horizontal overflow. Existing mobile-player **10/10**.
- Independent review found no remaining material issue after fixes for own-key
  validation, disposed import invalidation and stylesheet cache versioning.
- Harness waits for observed playback before beginning the next recording;
  accepted/waiting for frames is not treated as a completed player action.

Screenshots, layout measurements and controlled WASM/player JSON evidence
are committed under `teslamon-stt-selector-evidence-20261025/`. No real
iPhone Safari or Tesla microphone/accent acceptance was performed.
