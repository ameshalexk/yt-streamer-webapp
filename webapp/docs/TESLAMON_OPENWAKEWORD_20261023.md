# TeslaMon hands-free “Hey Jarvis” — implementation and review (2026-10-23)

Status: isolated review branch only. **Not deployed**. This feature must not be merged without CI, device acceptance, and license review.

## Architecture

The new **Mic Off / Mic On** button in TeslaMon's controls defaults Off on every page load. A direct tap on On requests browser microphone permission and, if supported, loads an Apache/MIT-code-derived openWakeWord-compatible browser detector with the existing pretrained **hey_jarvis_v0.1.onnx** weights. ONNX Runtime Web uses a single-threaded WebAssembly backend, not WebGPU. The browser runs mel/embedding/VAD/wake inference locally. While merely listening for the wake phrase, no audio is uploaded to PowerALX or Codex.

On detection the engine pauses, the browser clones the consented stream and starts a **single** MediaRecorder command clip (maximum 12 seconds); local WebAudio energy/quiet monitoring may stop earlier after speech or cancel empty/no-speech captures. Only that completed command clip is POSTed to the *existing authenticated* `/api/teslamon/transcribe` endpoint; transcription remains on the PowerALX LifeRecorder GPU worker. The text then follows the existing Codex planner `/api/teslamon/plan` and bounded local dispatch, subject to existing authentication and tool allowances. A cooldown returns the model to wake listening. There is no Mac speech model or continuously streamed ambient audio.

Mic Off, page hide, navigation, microphone-track disconnect, and permission failure close or release microphone resources and abort pending voice requests. Off is not just a cosmetic state: microphone tracks stop, model/worklet stops, pending capture cancels, and any in-flight plan/transcription fetch is aborted; stale responses are guarded against initiating a later dispatch. Hold-to-talk remains available and temporarily suspends wake detection to avoid concurrent recording. Puppy vector appearance, draggable placement and keyboard drag support remain.

The page requests `echoCancellation`, `noiseSuppression` and `autoGainControl`, and reduces the volume of locally owned playing media during command capture where the browser permits volume changes. The model pauses while commands run and uses a cooldown. **These controls do not guarantee that video dialogue or the assistant's own audio cannot false-trigger a wake word.** They cannot necessarily control other tabs, OS-level sound, external players, or Tesla/iOS audio routing.

## Model and library provenance / license

- Wake processing adapted (not copied from the AGPL-3.0 Voice Satellite implementation) from `dnavarrom/openwakeword_wasm` / npm `openwakeword-wasm-browser@0.1.1`, MIT licensed. Source: https://github.com/dnavarrom/openwakeword_wasm . Attribution retained in `teslamon-wake-engine.js`.
- Pretrained `hey_jarvis_v0.1.onnx` and required melspectrogram, embedding, Silero VAD weights were taken from `openwakeword-wasm-browser@0.1.1`, pinned to that release and *not retrained*. Upstream openWakeWord source Apache-2.0; its released pretrained wake models are **CC BY-NC-SA 4.0**; verify applicability to bundled feature/VAD weights, and retain notices/source attribution. Upstream: https://github.com/dscripka/openWakeWord . License: https://creativecommons.org/licenses/by-nc-sa/4.0/ .
- ONNX Runtime Web `onnxruntime-web@1.23.2` MIT, browser WASM artifacts bundled under `public/teslamon-wake-assets/ort/`; source: https://github.com/microsoft/onnxruntime .
- The wake library is a relatively small third-party implementation (not a widely maintained official upstream browser SDK). Its inference compatibility, false-activation rate, and model licensing need explicit reviewer and actual-device validation before production. The upstream weights' NonCommercial restrictions may make commercial use impermissible without a separate license. Do not deploy into a commercial offering without legal clearance.

## Browser and resource boundaries

- Foreground, visible, secure HTTPS page only; no iPhone background, locked-screen, or Tesla locked/background guarantee. In fact visibility loss turns the microphone Off and requires another user gesture to enable it.
- Actual iPhone Safari and Tesla browser must be tested for microphone exposure, permission behavior, AudioWorklet, WebAssembly SIMD, performance, track cloning, and audio output/echo policies. Headless Google Chrome responsive-mode tests are *emulation*, not physical-device acceptance.
- Static model and WASM downloads happen only after Mic On. Initial transfer and inference may consume multiple megabytes and CPU/RAM on the *client device*, including Tesla. The Mac mini only serves static assets and existing code and hosts **no new speech transcription or wake inference process**.
- The Mac browser's signed-in `ameshalex@gmail.com` Google Chrome profile was unavailable for automated inspection from this remote session. Tests can be run with a separate headless Google Chrome instance, clearly labeled synthetic. Manually check signed-in profile and actual iPhone/Tesla before shipping.

## Completed checks in isolated checkout (2026-10-23)

- `npm test`: **579 tests passed**, including 7 new hands-free lifecycle cases and 3 silence/end-of-speech cases (Chrome-specific checks are additional).
- `npm run check` and `git diff --check`: passed.
- `node scripts/teslamon-live-browser-check.mjs`: **18/18** Chrome responsive cases (320, 375, 390, 430 CSS px, iPad, landscape, reduced-motion and synthetic safe areas), including >=44px wake toggle.
- `node scripts/mobile-player-browser-check.mjs`: **10/10** Chrome mobile UI scenarios.
- `node scripts/teslamon-wake-model-browser-check.mjs`: Chrome loaded all four real pretrained ONNX assets, executed silent-frame inference, started the real AudioWorklet with Chrome's synthetic microphone and stopped all tracks.
- `node scripts/teslamon-handsfree-browser-check.mjs`: browser UI Off -> On -> listening -> Off passed with real model and Chrome synthetic microphone. No command upload/plan requests occurred while wake-listening.
- No genuine spoken “Hey Jarvis” sample or actual iPhone/Tesla acceptance was performed. The signed-in `ameshalex@gmail.com` Chrome user profile remains unverified; separate headless Chrome was used for deterministic synthetic tests.

## Review/test checklist

- [ ] Default Off, no getUserMedia until gesture; Mic On requests permission; Off stops tracks and model
- [ ] Hey Jarvis activates one recording, speech-end/no-speech/12s timeout; one authenticated transcription/plan; cooldown
- [ ] Off during permission prompt, wake processing, recording and transcription; no stale upload/dispatch
- [ ] Multiple rapid wakes, PTT overlap, disconnection, permission denial, pagehide/hidden page, navigation
- [ ] Live model loads using local browser ONNX/WASM and detects a genuine prerecorded “Hey Jarvis” test sample (no synthetic acceptance substituted)
- [ ] Play video and assistant audio; inspect echoes/false triggers, safe playback duck/restoration
- [ ] 320, 375, 390, 430 CSS px, iPad, mobile landscape; 44px targets, keyboard/screen-reader state and safe areas
- [ ] Signed-in Chrome `ameshalex@gmail.com` profile and real iPhone/Tesla physical browsers
- [ ] GitHub CI for Mac and Home Assistant, license audit and security review
- [ ] Deploy only upon explicit user request: merge reviewed PR, check both-platform CI, deploy Mac webapp + HA assets as applicable, verify `/api/health` revision and logged-in browser, keep backup/rollback path. Do not change production in this branch.
