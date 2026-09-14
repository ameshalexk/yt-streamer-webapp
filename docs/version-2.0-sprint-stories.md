# YT Streamer — version 2.0 sprint stories

Prepared September 14, 2026. Updated: V2-01 through V2-03 implemented locally; V2-04 and V2-05 remain pending.

The app is primarily a Tesla-browser video player. Browser video must remain MJPEG, including when JPEG frames are buffered and drawn to canvas. Keep the existing separate audio path. Lower quality and FPS must reduce playback demand while preserving normal media speed.

The initial investigation created only this plan. The subsequently authorized V2-01 implementation is recorded below; the original investigation findings are retained as a dated baseline.

## V2-01 completion — September 14, 2026

- [x] Version 1 preserved on main at b03ab16; GitHub main matched when checked.
- [x] Local annotated v1.0.0 source snapshot tag created.
- [x] Separate worktree `/Users/amesh/Desktop/version 2.0`, branch `version-2.0`, created from the version 1 baseline.
- [x] Page title, header and PWA name are exactly **version 2.0**.
- [x] Loopback development launcher defaults to port 8100, isolates data/library/logs/cache/config/state/browser profile, rejects production port 8099 and ignores inherited application credentials.
- [x] Node dependencies and pinned yt-dlp environment installed independently.
- [x] Startup and rollback guide saved in `docs/V2-01-development.md` in the version 2.0 worktree.
- [x] Syntax checks, six isolation/PWA tests, launchd template validation and local HTTP smoke passed.
- [x] Production instance, configuration and store remained unchanged during verification; development smoke process stopped.

No remote push, production deployment, service installation, media playback test or Tesla validation was performed. Development starts with an empty local library and no copied production OAuth state. The optional Graphify refresh was attempted but unavailable because its Python module is not installed. The Obsidian tracker holds the implementation commit and current completion status.

## V2-02 completion — September 14, 2026

- [x] Moved play/pause, sound, fullscreen and VOD seek into one overlay inside the video surface.
- [x] One tap from the hidden state reveals the overlay without also pausing playback.
- [x] The same overlay remains inside normal, native fullscreen and synthetic fullscreen modes.
- [x] Main controls use 48–52 CSS pixel touch targets; seek dragging and other control interaction hold the overlay open.
- [x] Overlay auto-hides after five seconds only during uninterrupted playback; it stays visible while paused, loading, interacting or showing an error/recovery notice.
- [x] Live/unseekable sources show an explicit `LIVE — Seeking unavailable` state instead of a misleading seek bar.
- [x] Reserved a desktop/Tesla overlay slot for the V2-03 Low/Medium/High controls without exposing inactive buttons; the placeholder collapses on narrow phone layouts.
- [x] Updated narrow-screen layout so the seek row, badge and recovery notice do not collide with the new overlay.
- [x] Syntax checks and all 40 automated tests pass. Headless Chrome verified the overlay, target sizing, hidden→reveal behavior, native fullscreen containment, synthetic fullscreen containment, and live-status text.

Production remained on version 1 at port 8099 while the isolated version 2.0 process stayed on loopback port 8100. No remote push or production deployment was performed. Parked-Tesla touch/visibility behavior remains the final device-specific verification for this story.

## V2-03 completion — September 14, 2026

- [x] Added Low / Medium / High directly to the shared V2-02 video overlay in normal and fullscreen layouts.
- [x] Profiles now define all three stream settings together: Low = 360p/12 FPS/Q12, Medium = 480p/15 FPS/Q7, High = 480p/24 FPS/Q4.
- [x] Overlay labels show friendly resolution/FPS details only; raw JPEG qscale remains in Advanced Stream settings.
- [x] Selected state requires resolution, FPS and JPEG quality to all match. Any other combination is shown as **Custom** with no false preset highlight.
- [x] The chosen profile is stored in browser local storage and restored on reload.
- [x] VOD quality changes preserve the current position. A paused VOD restarts at the same position and automatically returns to paused state after the new stream becomes playable.
- [x] Sound state is preserved because the existing global sound setting is reused by the restarted stream. Native and synthetic fullscreen remain on the same player element across the restart.
- [x] Rapid Low/Medium/High taps are coalesced behind a short generation-guarded delay; only the final pending selection restarts. If a later switch starts after an earlier one, the normal stream cleanup destroys the replaced session.
- [x] Downloaded-library videos use an explicit supported resolution fallback when the requested profile resolution was not downloaded; the UI then shows **Custom** because the resulting triple no longer exactly matches the requested preset.
- [x] Live/unseekable quality changes explicitly report **returning to live**.
- [x] Narrow-screen controls now wrap the three quality buttons into their own row instead of hiding them.
- [x] Cache keys for the V2 development CSS/app script were advanced so the new controls load cleanly during device testing.
- [x] Syntax checks, `git diff --check`, and all **46/46** automated tests passed at initial V2-03 completion.
- [x] Follow-up pause/resume buffering regression fixed: buffered pause preserves the original timeline base, exposes retained queue depth while paused, and no longer treats Resume as a slow-network suggestion trigger. Updated suite: **49/49** passing.

Headless Chrome runtime checks on the isolated port 8100 also verified: one replay for rapid Low→High→Medium taps, stored-profile reload, honest Custom state, paused restart at the same timestamp with pause restored, native fullscreen retained through a simulated restart, live-return messaging, explicit legacy-resolution fallback, and no page errors. Layout checks at 390px portrait, 844px landscape and 1280px Tesla-like widths showed no quality-control overflow.

No production deployment, public URL change, or GitHub push was performed. Real parked-Tesla playback is still required before version 2.0 is considered device-validated.

## Current baseline and findings

The running service points to `/Users/amesh/Desktop/ytstreamerhabkupfin/webapp`. Its locally served `app.js` matches the inspected file. The repository is clean on `main` at `b03ab16e62bf42ba7c2f67e441d06b277fabdf17`; package version is `1.0.0`. Local `origin/main` points to that same commit; GitHub was not fetched or independently checked. No local tags were listed.

1. **The quick quality buttons exist, but disappear in fullscreen.** Low/Med/High sit outside the screen in Stream settings. Fullscreen CSS hides that entire section and the normal toolbar. The screen contains a fullscreen button and a separate seek overlay, but lacks the unified controls you described. Evidence: [index.html:210](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/index.html:210), [index.html:275](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/index.html:275), [styles.css:252](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/styles.css:252).

2. **The existing suggestion can miss perceived slowdown.** It waits 20 seconds during startup, 12 seconds during a rebuffer, or 6 seconds after repeated rebuffers. It must still be in the buffered player's `buffering` state. Audio-only buffering is excluded; entering `syncing` or `playing` cancels the timer. The popup lasts 10 seconds, is limited to once per attempt and three times per video, and can be stopped. Short repeated stalls or slow rendering may therefore produce no prompt. This is a code finding, not a reconstruction of your Tesla session. Evidence: [app.js:636](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:636), [app.js:804](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:804), [app.js:2054](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:2054).

3. **Presets need consistent meaning.** Existing quick buttons change JPEG quality and FPS but leave resolution unchanged. Their selected appearance checks only JPEG quality, so “Med” can appear selected while FPS differs from the Medium preset. The frontend starts at 480p/24 FPS/Q7. The fallback is 360p/15 FPS/Q5; this reduces dimensions and FPS, but Q5 is a sharper JPEG setting than Q7, so it does not lower every bandwidth-related setting. Evidence: [app.js:101](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:101), [app.js:673](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:673), [app.js:6333](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:6333), [index.html:315](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/index.html:315).

4. **There is a plausible slowdown mechanism to measure.** The buffered renderer draws queued frames sequentially and pauses audio when the next frame falls over 250 ms behind it, resuming near 40 ms. Repeated recovery could feel like slowed playback. Server output also pauses under HTTP backpressure; buffered YouTube output already avoids realtime input pacing. Neither mechanism establishes the cause of your experience without measurement. Evidence: [buffered-mjpeg.js:731](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/buffered-mjpeg.js:731), [stream.js:65](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/src/lib/stream.js:65), [stream.js:204](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/src/lib/stream.js:204).

5. **Live seeking is deliberately disabled today.** Live YouTube paths set `seekable: false` and bypass the buffered VOD player. The seek UI also requires a positive fixed duration. YouTube supports rewind when the broadcaster enables DVR, but that does not prove this app's resolved source exposes a usable rewind window. A timestamp input alone does not implement live DVR. Evidence: [app.js:1141](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:1141), [app.js:3619](/Users/amesh/Desktop/ytstreamerhabkupfin/webapp/public/app.js:3619), [YouTube DVR documentation](https://support.google.com/youtube/answer/9296823?hl=en).

No Tesla browser was inspected and no new video session was started. Device performance, browser cache state, and actual live-source rewind remain unverified.

## One-week scope

These are rough engineering estimates, not Codex quota estimates. Pick one story per session; they can be spread across several weeks.

| Story | Deliverable | Estimate | Depends on |
| --- | --- | --- | --- |
| V2-01 | Preserve version 1; prepare the version 2.0 working copy | 0.5 day | — |
| V2-02 | Unified controls shown by tapping the video | 1 day | V2-01 |
| V2-03 | Reliable Low/Medium/High profiles | 1 day | V2-02 |
| V2-04 | Useful slowdown feedback and focused recovery repair | 1.5 days | V2-03 |
| V2-05 | Live rewind feasibility and a bounded follow-up decision | 0.5 day | V2-01 |
| Validation | Combined playback and parked-Tesla acceptance | 0.5 day | Implemented stories |

The week targets the main playback experience. Full live DVR is conditional follow-up work, not a promised half-day implementation.

## V2-01 — Preserve version 1 and prepare version 2.0

**User story:** As the owner, I want a recoverable version 1 and a separate development copy so I can improve the app without disturbing the current player.

**Acceptance:**

- Recheck the deployed tree and GitHub state before choosing the baseline; preserve any new uncommitted work.
- Keep the approved version 1 baseline on `main`. Propose a `v1.0.0` snapshot tag if appropriate and unused.
- Name the new directory and visible application label exactly **version 2.0**. Use `version-2.0` for the Git branch because branch names cannot contain spaces.
- Create the development worktree from the approved current baseline, not an arbitrary older dev branch.
- Isolate its writable data, logs, port and any service identity. Do not share writable production state. Leave the current deployment pointing at version 1.
- Document local startup and rollback. Remote publication and production switching remain separate actions.

**Prompt to use later:**

> Read this sprint document and implement only V2-01. Inspect the current YT Streamer deployment and Git state, preserve the approved version 1 baseline on main, and prepare a separate worktree whose directory is literally “version 2.0” with branch “version-2.0”. Keep production running from its existing location. Isolate development data and configuration; verify a separate port before using it. Add the visible version 2.0 label only in the copy. Prepare the version 1 snapshot and document rollback. Do not push, publish, or switch the running service. Report the exact baseline and paths, then stop.

## V2-02 — One tap reveals the controls

**User story:** As a viewer, I want all essential controls on the video so I can operate the player without leaving fullscreen.

**Acceptance:**

- One tap on hidden controls reveals play/pause, sound toggle, fullscreen enter/exit, and the seek bar where supported. Add the quality-control location for V2-03.
- Revealing controls does not also pause playback. Button taps and seeking do not trigger background gestures.
- Use the same controls in normal, native fullscreen and existing synthetic fullscreen modes.
- Use comfortably sized touch targets, approximately 48 CSS pixels. Keep controls visible while dragging, interacting, paused or recovering from an error.
- Auto-hide after about five seconds of inactivity during playback. Keep the video unobstructed when hidden.
- Preserve VOD seeking; display truthful live status when seeking is unavailable.

**Prompt to use later:**

> Implement only V2-02 in the existing version 2.0 copy. Build a unified tap-to-show overlay with play/pause, sound, fullscreen and supported seeking. Reuse existing playback functions and reserve room for Low/Medium/High. Make reveal-only taps, slider dragging and control auto-hide work correctly in normal and both fullscreen modes. Keep MJPEG and separate audio. Verify touch interactions with focused behavioral checks and a browser preview. Report remaining Tesla-only verification. Do not alter or deploy version 1.

## V2-03 — Three useful quality profiles

**User story:** As a viewer on a slow connection, I want an immediately accessible way to reduce frame rate and picture demand.

Initial proposed profiles, to validate on the Tesla:

| Button | Resolution | FPS | Internal JPEG qscale |
| --- | --- | --- | --- |
| Low | 360p | 12 | 12 |
| Medium | 480p | 15 | 7 |
| High | 480p | 24 | 4 |

These are proposals. Show friendly resolution/FPS details; keep raw JPEG numbers in advanced settings. Lower FPS means less motion detail, not slower media time.

**Acceptance:**

- Buttons appear in the V2-02 overlay in fullscreen and normal playback; no popup is required to reach them.
- Every preset defines all three settings. Selected state matches the complete preset; custom combinations are shown honestly.
- Switching preserves VOD position, pause state, sound setting and fullscreen, with clear “Changing quality…” feedback.
- Handle unavailable downloaded resolutions using an explicit supported fallback.
- Remember the chosen profile in this browser. Rapid taps cancel stale attempts and settle on the last selection without accumulating streams.
- Live-only restarts clearly indicate returning to live when no rewind window is supported.

**Prompt to use later:**

> Implement only V2-03 in version 2.0, using this document's proposed profiles as starting values. Put Low/Medium/High in the video overlay and make them change resolution, FPS and JPEG compression together. Preserve position, pause, sound and fullscreen; remember the choice locally. Handle unavailable resolutions and repeated taps. Keep normal playback speed and MJPEG-only browser video. Test one mid-video profile change, a paused change and rapid changes, including session cleanup. Do not deploy.

## V2-04 — Detect the problem the viewer actually feels

**User story:** As a viewer, I want clear recovery choices when playback stalls or falls behind, even if the player does not enter a long buffering state.

**Acceptance:**

- Begin with a bounded reproduction: compare media time with wall time, actual rendered FPS, queue duration, decode time, A/V drift and HTTP backpressure.
- Distinguish slow video delivery, rendering backlog and audio-only trouble. Reuse existing stats and logs before adding instrumentation.
- Keep “Try Low” accessible through the overlay. Use a restrained notice for repeated stalls or sustained sync recovery, with dismissal respected.
- Do not automatically reduce quality unless the user chooses a future Auto mode.
- If rendering backlog is proven, evaluate dropping obsolete video frames against the audio clock while retaining normal playback speed and bounded queues. Do not remove pacing globally or increase buffers blindly.
- Test actual state transitions and timing; existing slow-prompt tests mainly check source text and cannot establish runtime behavior.
- Timebox to the estimate. If a deeper renderer redesign is needed, deliver the evidence and a follow-up story rather than expanding the sprint.

**Prompt to use later:**

> Implement only V2-04 in version 2.0. First reproduce and distinguish network starvation, decode backlog and repeated A/V sync pauses using existing metrics and controlled fixtures. Fix only the demonstrated cause within this story's scope. Add restrained slowdown feedback that also covers repeated stalls or sustained syncing, with an immediate Try Low action and respected dismissal. Keep playback at normal media speed, preserve MJPEG and audio sync, and bound queues and retries. Verify slow-network and slow-decoder cases separately. If the repair requires a larger redesign, document that finding and stop at the timebox. Do not deploy.

## V2-05 — Can this live source actually rewind?

**User story:** As a live viewer, I want seeking when the source provides a usable rewind window and an honest explanation otherwise.

**Acceptance for this research story:**

- Inspect one representative DVR-enabled YouTube live source and one source without rewind support.
- Establish whether the resolved upstream media exposes an accessible time window and whether both audio and MJPEG can restart at a requested point.
- Specify moving window start/end, current position, expiry behavior and a “Go Live” action for a future implementation.
- When rewind is unavailable, propose “Live — rewind unavailable” instead of a misleading seek bar.
- Keep source access on the server and MJPEG in the Tesla browser. If local recording/storage is required, estimate that separately.
- Produce a go/no-go decision and one implementation story. Do not build an unbounded recording feature during this spike.

**Prompt to use later:**

> Investigate only V2-05 using version 2.0. Check whether representative live sources expose usable DVR windows through this app's resolver. Verify source availability and synchronized audio/video seek feasibility; do not infer support merely because YouTube's own player rewinds. Return a concise go/no-go, evidence, and one bounded implementation story covering the sliding seek range, expired positions, Go Live and no-DVR fallback. Keep MJPEG browser video. Do not add recording, change production or implement DVR yet.

## Session rules for all later prompts

Use this document with the selected story prompt. Refresh only the relevant current files and Git state. Stay within the selected story, keep reports brief, and avoid repeated broad scans or unnecessary agent fan-out to conserve Plus usage. Do not install paid services or change browser video transport. Run the minimum meaningful checks; claim Tesla behavior only after actual parked-Tesla verification. Keep app edits in the version 2.0 copy and leave production deployment for an explicitly selected later action.

Defer a general redesign, accounts, social features, new recommendation systems and automatic quality switching. The highest-value sequence is V2-01 → V2-02 → V2-03 → V2-04; do V2-05 when live rewind becomes the priority.
