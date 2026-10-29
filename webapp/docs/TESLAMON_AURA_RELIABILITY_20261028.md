# TeslaMon Aura — reliability change review (AURA-F01–F08)

Development-only implementation. **Not merged, released, installed, restarted, or exercised on production microphone/media/HA.**

## Source/ownership reconciliation — 2026-10-28

- Repository: `ameshalexk/yt-streamer-webapp`; isolated worktree `/Users/amesh/Developer/ytstreamer-aura-reliability-20261028`.
- Branch: `fix/teslamon-aura-reliability-20261028`, based on consolidated `origin/main` at `b666abf23f9b3864dbfc834360adba1a2da85ba0` (merged Aura PR #124).
- Original `ytstreamer-teslamon-aura-20261027` worktree and all six existing dirty puppy/STT evidence files left untouched.
- Installed Mac runtime and release snapshot not edited. The existing `release.json` versus `DEPLOYED_COMMIT` mismatch remains a separate release-provenance check before any future installation.
- One writer owns the pet integration; independent review is read-only.

## Changes and behavior

| Story | Implementation |
|---|---|
| F01 | `teslamon-handsfree.js` emits `preparing`, waits for priority same-tab pause before creating recorder, and only emits `recording` after `capture.start()` succeeds. Pause has a 2,500 ms deadline; rejection/expiry fences late callbacks and returns to wake standby without auto-resume. `ai-media-agent-adapter.js` executes `pause_for_voice` outside the serialized control queue, invalidates stale queued controls, and reasserts pause after an earlier pending play/resume settles. |
| F02 | Pet owns a separate, cancellable two-second voice transcript grace through planner completion, so 1.5-second rearm cannot erase the request. Typed/native-dictation auto-send retains its own guard; panel and visual transitions do not cancel staged voice work. |
| F03 | Local Aura Off→On enters immediately; Mic Off shows honest inactive status without activating permission. Presentation and stored preference are independent; tap/Escape only close the visual. Non-video completion/error/silence do not auto-dismiss. Cross-tab storage On does not open the local overlay or mic. |
| F04 | Current same-tab observed `playback_phase:playing` closes Aura and leaves wake enabled. A new accepted wake reopens and pauses playback. An in-flight wake ignores stale earlier playing status until pause ownership is confirmed. The player mode remains unmodified. |
| F05 | Separate standby, preparing, actual recording, transcribing, planning, action, cooldown, no speech/error, and Mic Off semantic feedback. Raw verbose `status()` strings are no longer mirrored into Aura. The visual has the fixed two requested main lines plus one lower status. |
| F06 | Mic Off invalidates voice epoch, staged timer, active local-STT and pending voice planner/dispatch. Already-dispatched effects cannot be rolled back. Manual typed drafts/timers are not indiscriminately cancelled. |
| F07 | Stable wake invocation IDs, presenter entry tokens, model-generation and issue-generation fences stop late A events updating or closing presentation B. Manual dismissal does not abort valid outstanding work. |
| F08 | Durable Node/Chrome regressions, both UI modes and requested viewports, anonymous synthetic screenshots and dimensions, independent review, and shared-platform release checklist. |

## Automated evidence

Commands run in the isolated worktree's `webapp/` (all without network media jobs or production device actions):

- `npm ci --ignore-scripts`: dependency installation passed; lockfile unchanged. npm reported 3 pre-existing dependency advisories (1 moderate, 1 high, 1 critical); no unrelated dependency upgrade attempted.
- `npm run check`: passed.
- `npm test`: **682/682** passed after the three added adapter-queue tests; final immutable-head CI remains separate.
- `node --test test/teslamon-handsfree.test.mjs test/teslamon-adapter-fullscreen.test.mjs`: **26/26** passed, including hung pause timeout, late completion, Mic Off and queued play/resume interruption.
- `node scripts/teslamon-handsfree-browser-check.mjs`: passed, two synthetic native-video pause-before-capture cycles, explicit-only resume, Chrome fake-device mic lifecycle, zero ambient upstream uploads.
- `node scripts/mobile-player-browser-check.mjs`: **12/12** passed, Classic and New 320/375/390/430/iPad/landscape, player and Quality available, no overflow.
- `TESLAMON_AURA_SCREENSHOTS=1 node scripts/teslamon-aura-browser-check.mjs`: **16/16** passed for Classic/New 320×568, 375×667, 390×844, 430×932, 768×1024, 844×390, 1280×800, and 1920×1080. Synthetic fixtures validate local toggle, Mic independence, persistent Aura, tap/Escape, storage event, playback exit, next wake, no click-through, no horizontal overflow, touch targets ≥44px, reduced motion, one dispatch after dismiss, transcript through rearm boundary, fresh B presentation ignoring A's delayed completion, pause-failure video-exit recovery, and Mic Off cancelling the next staged transcript.
- `git diff --check`: passed on the implementation diff.

Synthetic screenshots (not production user content) and final 16-case `layout.json` measurements live in `docs/teslamon-aura-reliability-evidence-20261028/`, with one `classic-*` and `new-*` screenshot per tested viewport.

## Remaining gates and risks

- CI macOS/Linux shared regressions and native ARM64/AMD64 HA packaging must pass at the final branch commit before promotion; `Both platforms passed` is a required future release gate.
- No authenticated production Chrome UI was opened; the current site may request microphone on load. The user restricted live microphones/media/device actions, so signed-in UI and real iPhone Safari/Tesla spoken wake/noise/accent acceptance remain separately authorized.
- The synthetic frame progress checks exercise native video and existing player readback. Real MJPEG, buffered MJPEG, WebCodecs and gesture-blocked media paths still require physical/authorized application acceptance; server health or Chrome emulation cannot close these gaps.
- Existing browser microphone restrictions apply in background/locked screens. The visual toggle never authorizes background recording or continuous free speech.
- Current Mac/HA installed revisions and runtime data were not rechecked by this development-only change. Before a future merge/release/deploy: review exact source/CI, verify active jobs, back up scoped runtime, preserve private data and signed Audio Tap helper, package both targets from one immutable commit, compare installed revisions/flows and retain rollback.
- Aura preference Off is a presentation fallback, not a code rollback. If needed, revert this change commit via the reviewed release pipeline; do not restore older runtime files over newer data.
