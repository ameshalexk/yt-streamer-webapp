# TeslaMon wake phrases — Mycroft/Rhasspy replacement (2026-10-25)

## Scope and behavior

Mac YT Streamer (stream.ameshalex.com) only. Keep Hey Jarvis and Alexa; remove the Hey Luna model and controls; add official pretrained Hey Mycroft and Hey Rhasspy ONNX heads. All four phrases are selected for a new browser profile. User may choose any nonempty subset while Mic is Off. Exactly one shared mel/embedding/VAD pipeline remains browser-local; only selected heads load. No Home Assistant, PowerALX transcription, cloud login, DNS, microphone consent, video engine or paid service change.

The existing localStorage key `ytStreamerTeslaMonWakePhrasesV1` is preserved. Existing selections containing Hey Luna migrate in place by substituting Hey Mycroft and Hey Rhasspy while keeping other selected phrases. Other saved subsets are preserved. A new profile enables all four.

The transcript command-prefix parser recognizes the four current phrases at the beginning of a command; "Hey Luna" is no longer a wake trigger or recognized prefix. A spoken phrase alone still does not submit a planner request. Original foreground/tab visibility and microphone/browser limitations remain.

## Models and license

Official upstream source: https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1

- `hey_mycroft_v0.1.onnx`: 857,691 bytes, SHA256 `c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18`.
- `hey_rhasspy_v0.1.onnx`: 204,081 bytes, SHA256 `5a9b3ed3be2910e35780e097905aa9f35a9c10038df47914cf2b3ec4d670f6ea`.
- Retired `hey_luna.onnx`: 206,975 bytes removed from the new release.
- `alexa_v0.1.onnx` and existing Hey Jarvis/core models preserved.

Model manifest `public/teslamon-wake-assets/ADDED_MODELS.json` validates pinned bytes and hashes. Third-party notice updated. Upstream pretrained weights use CC BY-NC-SA 4.0 (noncommercial with attribution/share-alike); licensing review remains necessary for any commercial use.

## Verification / deployment gates

Run from `webapp/`:
```
npm ci
npm run check
npm test
node scripts/teslamon-wake-model-browser-check.mjs
node scripts/teslamon-handsfree-browser-check.mjs
node scripts/teslamon-local-stt-layout-browser-check.mjs
node scripts/mobile-player-browser-check.mjs
```
Real Chrome ONNX/WASM smoke validates all four model heads and shared pipeline, but synthetic mic/audio is not proof of spoken recognition or false-positive rate. Follow repository `AGENTS.md` and `docs/SHARED_RELEASE.md`: Mac and Ubuntu regressions, native amd64/aarch64 HA container builds, required Both platforms passed workflow, immutable release tag, scoped backup and Mac runtime health/version verification. Do not install on Home Assistant; this request is Mac-only.

Physical acceptance remains user action: in actual iPhone/Tesla browser, try each of the four phrases 10 times in quiet and with media playing, confirm recognition, accidental wakes and command capture; test saved selections and Mic Off cleanup. Try Hey Luna to confirm it no longer wakes. No background/locked-phone listening promise.

Rollback: retain a copy of the previous Mac runtime code before installation; leave `data` and credentials untouched. Re-deploy prior immutable release and restart only `com.ytstreamer.webapp` if needed.
