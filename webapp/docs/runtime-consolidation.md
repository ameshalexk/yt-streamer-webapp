# Runtime consolidation and Chrome acceptance

The repository default branch was verified through GitHub as `main`. Consolidation retains the deployed runtime snapshot (`181fc6c`), Continue Watching (`5e9b598`), and the application history containing PRs #6, #8, and #9. It does not replace the runtime with the older default branch.

## Resolved validation failures

- Audio selector tests now enforce the deployed Core Tap V3 PCM default and single supported browser audio choice. Removed Version 1/2 selectors are obsolete requirements.
- Touch and browser input harnesses now exercise current gesture state and serialized input. Real Chrome uses one pinned target and one desktop click for a completed mouse/touch tap. Failed press/release cleanup has behavioral coverage.
- Mac viewport uses native device scale; only JPEG capture is scaled to logical input coordinates.
- Restored processed DASH cache preparation/start/static routes and immutable segment serving. Linux encoding defaults to libx264; Mac retains its hardware encoder.
- Preserved the experimental EAJF framing protocol and restored its server transport. Production quality choices remain Auto, Low, Medium, and High. Regression coverage verifies actual HTTP/FFmpeg output, seek timestamps, stale sessions, response backpressure, and natural process close.
- Buffered MJPEG/E Auto prefetch cancellation handles rejected reads without unhandled promise rejections.
- yt-dlp stream metadata retains live status, duration, and title so fallback and seek bounds work.

## Chrome verification

Acceptance used Google Chrome in the profile signed in as ameshalex@gmail.com. An isolated server, temporary data, deterministic yt-dlp resolver, and generated video/audio fixture avoided changes to production playlists/history.

Verified MJPEG with separate audio, WebCodecs with internal audio, pause/resume, seek, quality changes, method switching with position/pause/mute preserved, desktop fullscreen fallback, Continue Watching after reload, Start over, natural completion, and server-directed WebCodecs-to-MJPEG fallback. Live inputs remain MJPEG. Streamed Chrome input delivered one trusted click; keyboard input and Restream recovered normally. External YouTube extraction and Tesla-specific browser behavior are separate from deterministic transport acceptance.

Final application suite: 221 tests passed, zero failures/skips; syntax checks and diff whitespace checks passed. Independent review findings about queued-frame EOF and failed mouse release were fixed with regression tests.

## Later Tesla acceptance

- Confirm MJPEG and WebCodecs support, audio synchronization, pause/seek, and quality changes on the vehicle browser.
- Check touch cancellation/pinch/scroll, method fallback, and fullscreen controls.
- Reload and resume Continue Watching; verify Start over and reconnection after a network interruption.

Tesla testing does not block desktop software consolidation or deployment. Deployment commit, rollback path, and HA hosting evidence are recorded in the project notes and GitHub PRs.
