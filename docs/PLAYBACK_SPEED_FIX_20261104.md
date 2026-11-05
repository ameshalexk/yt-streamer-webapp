# Playback speed menu and startup repair — 2026-11-04

Status: development branch only. The user explicitly withheld merge, deployment,
service restarts and Obsidian updates until later authorization.

## Findings

The affected site is `https://stream.ameshalex.com`; the shared application is
also used by StreamHA. Branch `fix/playback-speed-menu-20261104` starts at current
GitHub main `dd7f0fd28da31799374b56765a44973c0b74570f`. The Mac runtime reports
`43a2ef984f5f598c0b92695013c3c0512fbad71b`, which contains separate unmerged voice/Grok
work. Its app.js, styles.css and cyberdash-embedded.mjs matched this branch's
unchanged baseline. This task does not overwrite that runtime or include the
unrelated voice changes.

The select had white text over a transparent control but no explicit option
palette/native color scheme. That allows the native popup to combine its own
background with inherited text colors. The fix specifies a light native menu
and opaque white options with dark text, retaining the existing native picker,
keyboard navigation and selected highlight.

Speed changes have called `replayFn(currentPosition)` since the original speed
feature (`6e9cc8d`, September 27). They restart the WebCodecs session. The original
implementation played after three video frames and one audio block. Audio later
moved through a browser pitch-preserving sidecar (`98586c4`) to server FFmpeg
`atempo` (`3f28455`). Server tempo preserves speech pitch but requires a new
session when the rate changes. Buffer increases (`df9e367`, `6c55abc`) then made
2x wait for four output seconds of audio, 6.5 source seconds of video and 195
frames at a requested 30 FPS. A 15-second startup timeout could extend the wait
for a short tail or a source with fewer frames than that count assumes.

A separate real-Chrome check also reproduced `TypeError: Illegal invocation`
in `PlaybackRecovery.Monitor.request`: default `setTimeout`/`clearTimeout` were
stored as instance properties and invoked with the monitor as their receiver.
This broke retry scheduling when playback stalled. Default timer wrappers now
retain browser-call semantics; injected timers used by unit tests still work.

This supports a startup-latency diagnosis; it does not prove that the user's
specific video failed. There was no matching recent WebCodecs summary in the
last 3,000 local playback log entries checked. No production playback was started.

## Change

- Give the native speed menu explicit contrasting colors and a phone-sized
  touch target; keep the native select and existing 1x–4x values.
- Use a 1.5-second audio startup reserve at fast speeds, scaled into source time
  for video (three source seconds at 2x). Keep steady-state recovery thresholds,
  encoder producer headroom and pitch-preserving audio unchanged.
- Gate startup on buffered time and minimum decodable content instead of a
  requested-FPS frame count. Completed tracks may play their available tail
  without waiting for data that cannot arrive.
- Restore functioning browser retry scheduling/cancellation after a stall.
- Show the requested rate while reconnecting and invalidate the changed browser
  assets' cache URLs.
- Stop an encoder that finishes starting after its player was canceled by Stop
  or a later rate selection. Static prepared-cache playback is excluded because
  it does not create an encoder. Direct cancellation tests cover both paths.

A brief reconnect remains by design. Seamless live rate changes would require
coordinated server tempo changes and media-clock handoff; this branch does not
introduce that larger architecture change or change MJPEG/live speed support.

## Validation

- Unchanged main baseline: 717/717 Node tests passed.
- Changed application: 721/721 Node tests passed; `npm run check` passed.
- Added behavioral tests for time coverage, missing audio/video, completed short
  tails and recovery-threshold margins. Existing pitch, pause, cancellation,
  decoder, MJPEG, prepared-cache and audio-scheduling regressions still pass.
- Speed-menu Chrome checks: 12/12 combinations of Classic/New and 320x568,
  375x812, 390x844, 430x932, 768x1024 and 844x390 passed. The actual select
  measures 48px high (previously 40px on mobile), its options compute as dark
  text on opaque white, and the native color scheme is explicitly light.
  Selection and persisted 2x preference are exercised; no horizontal overflow.
  Native popup windows are not captured by the headless screenshot, so this is
  computed-style/interaction proof rather than a physical OS-picker screenshot.
  [Actual 320px Classic layout](playback-speed-evidence-20261104/320-classic.png).
- Real Chrome default recovery timers reproduce Illegal invocation on unchanged
  code and successfully request/cancel a retry after the fix.
- Required `mobile-player-browser-check.mjs`: 12/12 real-app responsive scenarios
  passed, including quality access, player reveal and source-managed controls.
- Local FFmpeg + headless Chrome real-media check passed: 2x playback advanced
  the source clock 4.01 seconds over two wall seconds, Pause held position,
  returning to 1x worked, and a stale delayed 2x encoder was stopped.
  Fixture media is generated offline without read-rate throttling.
- Shared Mac/Linux, bundle and native HA PR gates must pass before promotion.
  CI artifacts do not install/deploy.

## Release boundary

No merge, release publication, installation, production service restart or
Obsidian edit is authorized by this task. Before a later release, reconcile with
current main and both installed revisions, preserve the unmerged runtime voice
work, run the exact-head shared Mac/Linux and native HA architecture gates, and
follow the normal backup/release procedure. Physical iPhone Safari/Tesla touch,
audio and real-network playback acceptance remain separate from local Chrome
emulation and generated-media checks.

### CI runner exception (2026-11-04)

Ubuntu GitHub-hosted headless Chrome completed the speed-menu responsive
checks but failed the real-media browser fixture after an
InvalidStateError (VideoDecoder.decode on a closed codec). The macOS
GitHub runner passed that same real-media step. The cross-platform
workflow now keeps menu/UI, Node/FFmpeg and package tests on both
runners, but runs the real WebCodecs Chrome A/V fixture only on macOS.
This is a documented CI-environment limitation, not proof that Linux
browser playback is compatible or that the underlying decoder issue
is fixed. No change was made to the deployed player for this exception.
