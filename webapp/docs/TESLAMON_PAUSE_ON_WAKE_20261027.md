# TeslaMon pause on wake — 2026-10-27

Every accepted wake phrase now requests `pause` through the existing same-tab
`YTStreamerMediaAgent` before starting the normal command capture. This replaces
temporary HTML media volume reduction and uses the player pause path for all
supported playback modes. Already-paused playback stays paused. Voice cleanup,
silence, cancellation, and microphone-off do not resume playback; an explicit
play/resume command can still do so. Wake detection and transcription are unchanged.

The wake handler awaits the pause request before starting capture; idle or
unavailable playback does not block the existing microphone flow.

Changed `public/teslamon-pet.js`, `public/teslamon-handsfree.js`, and their cache
versions in the pet import and `public/index.html`.
Based on consolidated main `d1ae37ce889f112dc929f42ecf8dddd22d8612c9`.

The initial implementation skipped tests at the user's request. The subsequent
request authorized full regression testing. Validation now includes:

- `npm run check`, changed-module syntax checks, and 677/677 Node tests.
- Four added hands-free lifecycle regressions: awaiting pause, duplicate/repeated
  wakes, Mic Off during pending pause, and unavailable-player handling.
- 7/7 HA packaging tests and 7/7 release/extractor tests.
- 12/12 mobile-player and 21/21 TeslaMon responsive Chrome scenarios, both UI
  modes, including 320/375/390/430 px, iPad, landscape, 44 px targets and safe areas.
  Screenshots and measurements are in `teslamon-puppy-evidence/`.
- Access sign-in browser checks and the three JXL WASM regression scripts.
- Actual local ONNX/WASM load and inference for all four wake models, plus
  generated speech through Whisper Tiny, Base, then Tiny again with worker cleanup.

The hands-free browser regression now also exercises deterministic accepted wakes
against the actual same-tab player adapter and native video pause/resume path.
It checks pause-before-capture, a second wake after explicit resume, and no
automatic resume during cleanup. The original real wake-model startup coverage
is retained. This script is now part of shared macOS/Linux CI.

The local speech browser fixture was updated to mock contextual candidate
selection. Layout fixtures now return the correct playlist array schema.
These are test-harness repairs; application behavior beyond pause-on-wake is
unchanged. The final shared CI result is tracked in PR #123 and the canonical
Obsidian project note.

No merge or deployment has occurred. Deployment still requires the user's
go-ahead and a passing shared release workflow. All browser checks use isolated
Chrome with local fixtures. Real speech accuracy, authenticated production
planner behavior, physical iPhone Safari and Tesla acceptance remain unverified.

Rollback: revert the pause-on-wake commit and ship through the normal shared
release process, or restore the pre-release host backup after deployment.
