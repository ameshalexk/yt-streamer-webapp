# TeslaMon Play hands-free local microphone — 2026-10-24

Scope: `https://stream.ameshalex.com/games/` static dog game on the Mac YT Streamer production. The main site's TeslaMon puppy still uses its existing Hey Jarvis Mic On wake detector; its planner, capture, model, playback and authentication wiring are unchanged. No Home Assistant, DNS or Access deployment.

## Change

The game adds an explicit **Hands-free: Off / On** button alongside manual Speak and Stop. It starts Off on every page load and never requests a microphone until the user taps On. On the first tap the existing pinned Whisper Tiny English model is prepared with the microphone **off**; once Voice ready, permission is requested and one audio stream stays alive across multiple commands. AudioWorklet processes 2048-sample frames and voice activity detection batches short utterances with ~210 ms preroll, ~950 ms end silence and 7s max. Whisper performs one inference at a time while subsequent incoming frames are discarded; after each result the same mic re-arms automatically. The four-trick phrase matcher remains confined to this standalone game. No server/cloud STT upload, saved recordings, new worker/model or new model URLs.

Off, Stop, motion mode change, hidden/pagehide, mic disconnection and errors release the stream, close the worklet/context and abort pending inference. Abort epoch guards prevent a late result executing a trick. The manual push-to-talk button is disabled while hands-free owns the mic, and fully works when Off. Touch trick buttons remain available. The **On** indicator is green; **Off** is orange; model preparation is amber and explicitly says mic OFF. The game remains a complete independently self-hostable static package under `webapp/public/games/` with relative URLs, with content hashes for every new asset. One loaded STT worker per page and same-origin downloaded cache are unchanged.

## Development and verification

- Isolated standalone source: `/Users/amesh/Developer/teslamon-play-handsfree-20261024`, branch `feat/game-handsfree-20261024`, based on prior shared local STT game commit `60c87fb`. Local source commit: `142a84cfa06e7297c8101652c74debb07de70faa`.
- Isolated Streamer release branch: `/Users/amesh/Developer/ytstreamer-game-handsfree-20261024`, `feat/game-handsfree-mic-toggle-20261024`, based on deployed main `18949c101f9ad2f2b6b81a807c7efaf3becbf5e1`; PR/release SHA pending.
- Game unit tests: **43/43** pass including persistent mic, silence, re-arm, permission denial, delayed consent, stale transcribe cancellation, model/mic separation, manual PTT regressions, immutable model asset digests.
- Streamer check and tests: **611/611** pass.
- Real Chrome fixture (`teslamon-game-handsfree-browser-check.mjs`): one mic stream, one Whisper worker/load, 6 true WASM inferences, automatic **Jump → Roll → Sit → Spin → Jump**, unknown speech no trick, no audio-upload request, 7 cached model files. Uses generated WAV speech through real AudioWorklet, WASM and animation; not real Tesla or iPhone hardware.
- Existing manual Chrome fixture passed quiet short Jump, repeated Jump, Roll/Sit/Spin, unknown, silence, denied mic, Finish, Stop, stale-result/hidden simulation, model cache reload with no additional model HTTP.
- Game Chrome emulated layout **7/7** viewports 320/375/390/430, iPad portrait/landscape, 844x390; eight controls >=44px and on-screen, no horizontal overflow. Existing main player mobile browser check and pet 14/14 layout pass.
- Independent review: pending. GitHub Both platforms passed: pending. Mac release/deployment/public smoke: pending.

## Release, rollback and blockers

Require merged PR, green cross-platform Shared release gate, immutable macOS bundle, checksum verification, scoped fresh pre-deploy backup, active work preflight, safe Mac-only runtime sync preserving data and audio helper, only `com.ytstreamer.webapp` restart, matching /api/health revision and authenticated public Chrome model/trick checks. Do not deploy to Home Assistant.

Rollback restores only prechange Mac code/dependencies from that scoped backup without touching data, secrets, Cloudflare or native helper identity and restarts only the Streamer LaunchAgent. Record full backup path, release revision, tests and live statuses in Obsidian once installed. Real Tesla/iPhone microphone permissions, browser timing, ambient noise, endurance/power use and foreground/background cleanup require user-device acceptance; Chrome fixtures alone cannot establish them.
