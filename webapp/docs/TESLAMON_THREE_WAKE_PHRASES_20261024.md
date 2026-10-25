# TeslaMon three local wake phrases — 2026-10-24

The dog can listen for any enabled pretrained **Hey Jarvis**, **Hey Luna**, or
**Alexa** phrase. All three are enabled by default; individual choices live in
the dog panel and are remembered in this browser. At least one phrase must
remain selected. Turn Mic Off before changing phrases, then Mic On to apply.
There is one microphone stream and one shared mel/embedding/VAD pipeline;
only the selected small classifier heads are loaded. First detection pauses
the detector, allowing only one command capture even if multiple heads score.

Detection remains browser-local ONNX Runtime Web, single-thread WASM, at the
existing 0.5 threshold. No audio upload, new cloud service, retraining, Whisper
model change, background/locked-screen support, or microphone consent change.
The transcript prefix parser recognizes all three phrases at the beginning
only, preserving names elsewhere in commands. A wake phrase without a command
must not submit a planner request.

## Assets and size

- Existing `hey_jarvis_v0.1.onnx`: 1,271,370 bytes.
- Added upstream `alexa_v0.1.onnx`: 854,246 bytes (openWakeWord v0.5.1).
- Added community `hey_luna.onnx`: 206,975 bytes (fwartner collection, pinned commit).
- Added weight total: **1,061,221 bytes (1.06 MB)**; no duplicate feature/runtime files.
- Exact source URLs, source revision, byte sizes and SHA-256 values:
  `public/teslamon-wake-assets/ADDED_MODELS.json`.
- Licenses/attribution: `public/teslamon-wake-assets/THIRD_PARTY_NOTICES.txt`.

Alexa is the word **Alexa**, not a promise about the phrase "Hey Alexa". Luna's
pretrained target is **Hey Luna**, not bare "Luna". Running three phrases adds
small classifier work and more opportunities for accidental activations; it
is not evidence of improved recognition for any particular accent. Nearby
Echo devices may also react to Alexa.

## Verification and acceptance

Run in `webapp/`:

```
npm run check
npm test
node scripts/teslamon-wake-model-browser-check.mjs
node scripts/teslamon-handsfree-browser-check.mjs
node scripts/teslamon-local-stt-layout-browser-check.mjs
node scripts/mobile-player-browser-check.mjs
```

The model smoke test runs actual bundled ONNX/WASM sessions for all three
heads through the shared feature pipeline and starts/stops a synthetic Chrome
microphone. This proves loading/inference/cleanup, not human phrase accuracy.
Node tests cover per-phrase dispatch, simultaneous-detection suppression,
selected-head filtering, settings validation and pinned model integrity.
Chrome viewport checks cover classic/new 320/375/390/430, iPad and landscape;
they are not physical iPhone Safari or Tesla acceptance.

Physical test after an authorized release: with Mic On, speak each phrase
naturally, pause briefly, then give the same simple command. Try 10 repetitions
per phrase in quiet and with normal cabin/media noise. Count misses, unintended
wakes and time to command readiness. Turn Mic Off to change choices; verify
only enabled phrases activate, choices survive reload, and Off/hidden page
release microphone tracks. Do not infer North Indian accent reliability from
synthetic or neutral-accent examples.

## Release boundary and rollback

Source branch: `feat/teslamon-three-wake-phrases-20261024`, based on consolidated
`origin/main` at `0e00edb455f625cd17f9c02d8df661458f4ec8cf`.
No merge or deployment is part of this implementation. Both-platform CI and
immutable shared packaging are required before promotion. HA installation
requires the separately recorded authorization boundary. To revert development,
revert the feature commit; to revert a future live release, use that release's
scoped backup without modifying runtime data or credentials.

## Local results

- 626/626 Node tests pass; `npm run check` plus explicit changed-module syntax checks pass.
- Real Chrome ONNX load/inference passes for all three heads (each inferred window size 16).
- Browser integration passes Mic On/Off, all-three status, only-Luna selection,
  last-enabled guard, reload persistence, track cleanup, zero ambient uploads
  and zero third-party requests.
- Classic/new panel layout passes 14/14 required viewport scenarios, with 44px
  label touch areas, zero horizontal overflow and contained panel. Screenshots
  and measurements: `teslamon-three-wake-evidence/`.
- Existing mobile-player regression passes 10/10 scenarios.
- Independent read-only review found no material implementation issue.
- These are Mac Chrome automated results. Real Tesla/iPhone and accent
  acceptance remain untested; no production release or installation occurred.
