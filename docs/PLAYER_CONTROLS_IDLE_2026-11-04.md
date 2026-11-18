# Player controls inactivity fix — development only

User request: hide the player controls after five seconds without interaction,
including while paused, and prepare the fix without deploying.

Branch: `fix/player-controls-idle-20261104`, based on `main` at
`dd7f0fd28da31799374b56765a44973c0b74570f`.

## Investigation

- The existing timeout is already 5000 ms and applies to inline and fullscreen
  playback. Its eligibility rules reject paused, loading, visible-notice and
  `controls-interacting` states.
- Overlay focus used to set `controls-interacting`, allowing retained focus to
  prevent the timeout indefinitely. Keyboard focus at timer expiry also vetoed
  hiding without scheduling another attempt.
- Quality had a separate CSS rule that hid its trigger only in fullscreen.
- Leaving fullscreen cleared the timer without arming it again for inline
  playback.

## Contract

App-owned player controls (pause/resume, seek, sound, speed, fullscreen and
Quality) hide after five seconds without actual user interaction. Pause,
buffering, loading and retained focus do not pin them. User input reveals them;
the first tap on a hidden video surface reveals controls without changing
playback. Quality settings close on idle. Playback statistics must not keep
waking the controls. Error/retry notices retain their own behavior.

External iframe providers own their internal controls and do not expose their
cross-origin interaction events to the parent page. This change covers the
application's controls and preserves provider and remote-input ownership.

## Verification and release state

Resumed 2026-11-04 after quota interruption:
- npm run check PASS; npm test 718/718 PASS.
- Loopback Chrome fixture **14/14 responsive cases PASS** across seven sizes
  and both Classic/New UI, with 12 checks per case.
- Covered paused, playing, buffering, pointer/tap reveal, retained focus,
  Quality panel, fullscreen transitions, seek drag release, 44px touch
  targets and no horizontal overflow.
- Fixed fullscreen exit not revealing controls before rearming idle timer.
- Quality visibility switches to hidden immediately on idle; controls are
  inert and ARIA-hidden. The browser fixture disables CSS transitions to
  avoid offscreen animation throttling affecting state assertions.
- Physical iPhone Safari/Tesla, audio, and live stream acceptance unverified.

No merge, release publication, installation, restart or production deployment
is authorized for this task. Preserve the unrelated voice, speed-menu and
audio-reliability branches and the currently installed runtime.
