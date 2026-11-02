# Moonshine Tiny Streaming in TeslaMon

Moonshine is an **experimental, opt-in third transcription model** beside Whisper Tiny and Base in the normal TeslaMon player. Whisper Tiny remains the default. The optional standalone lab remains a diagnostic tool; it is no longer the model selector's destination.

## User behavior

- Select Moonshine from the existing transcription-model picker. The same Classic/New page reloads with `tm_stt_mode=moonshine`, preserving other URL parameters and UI choice.
- Changing models during passive Mic On releases wake-listening microphone tracks and stops automatic re-arming. Active recording/transcription/commands keep the model picker locked. Tap Mic On explicitly to resume after a change.
- Moonshine uses the shared local capture, transcription, Aura, PTT, and command pipeline. Audio remains in the browser; transcript text can reach the existing command planner.
- Switching back to Whisper Tiny/Base reloads the same page without Moonshine mode. Browser Back and stored selection cannot silently activate Moonshine on an ordinary page.
- **Embedded website players are unavailable in Moonshine mode.** The picker explains this, and trying one shows an actionable error before interrupting current playback or assigning the frame URL. Switch to Whisper Tiny/Base, then reopen the external player. Normal streaming/proxy playback remains available; ordinary Whisper pages retain their existing embed behavior.

## Implementation and limits

The pinned `@moonshine-ai/moonshine-wasm@0.1.5` package is loaded from jsDelivr and downloads models from `download.moonshine.ai`. Its threaded WASM requires SharedArrayBuffer. COOP/COEP is therefore applied only to the explicitly selected Moonshine player document and diagnostic lab/worker, never globally to ordinary player pages or assets. This is why embedded websites require returning to Whisper. No cross-origin security policy is weakened to accommodate them.

Clips are limited to 16 seconds of mono16kHz audio. One transcription runs at a time through the local STT controller; cancellation, error, timeout, and page teardown terminate/dispose the worker. Switching model families invalidates the prior engine/module cache.

Engineering verification covers mocked lifecycle/model switching, actual HTTP header gating, early embedded-player rejection without playback mutation, fullscreen, and responsive controls. Earlier generated-speech WASM verification recognized “Play YouTube.” (3874ms cold setup/decode;192ms inference). **Generated speech and Chrome automation do not establish actual iPhone/Tesla accuracy, peak memory, microphone behavior, or crash stability.** Moonshine remains labeled experimental for those device trials.

For device acceptance, test cold/warm load, cancellation, backgrounding, repeated short commands and simultaneous video playback. Return to Whisper if the browser cannot isolate or is unstable. Returning to Whisper restores ordinary player/embed headers. The old lab is available at `/teslamon-moonshine-lab.html` for diagnosis only.

## Integration and release

Moonshine PR134 is integrated with the fullscreen behavior already merged in PR135. The latest user explicitly authorized completion, merge to main, shared deployment and cleanup, superseding the earlier draft/Mac-only hold. The combined source is reviewed and tested before exact-head shared CI; only a passing immutable main release may be installed. Both hosts retain separate data/options and the Mac signed audio helper identity.

Earlier Mac-only development revisions (aa3c3db selector fix, cfee853 in-page integration) and their rollback notes remain historical evidence. They are not the shared release. The canonical Obsidian YT Streamer App note records final merged/published/installed revisions, backup locations and remaining physical-device acceptance.

### Combined-source verification (2026-11-02)

- `npm run check` includes the new Moonshine adapter, worker and lab files. Full local suite: **717/717 passed**, no failures/skips.
- Existing signed-in AMESH Chrome loopback fixture: **14/14** model-switch combinations (Classic/New at320/375/390/430px, iPad768×1024, landscape844×390 and Tesla-sized1280×800). Moonshine retains the normal player and isolates the page; switching to Whisper Base removes isolation and retains UI selection. Model target height44px minimum, no sideways overflow.
- Real WASM through the shared local STT controller transcribed generated16kHz WAV as **“Play YouTube.”**:3402ms total,2244ms inference. No microphone was used. This is functional generated-speech evidence, not accent, real-device, or peak-memory acceptance.
- Actual browser confirmed a same-origin frame lacking isolation is blocked too, so the guard rejects **all iframe website players** in Moonshine mode. Browser/VM checks confirm actionable error, no frame URL assignment and unchanged current player state. Whisper mode remains available for embedded players.
- Independent read-only review found no remaining blocker after that conservative compatibility guard. HTTP tests exercise the real Express routes and verify opt-in headers on root/index/lab/worker, no global isolation, and no ambiguous duplicate-query activation.
- Fixture screenshots/measurements are under `docs/evidence/moonshine-integration-20261102/`. Its microphone/planner controls are deliberately unavailable; no real command or device actuation is tested there. Proxied-video compatibility in opt-in Moonshine mode is a separate deployed acceptance check.
