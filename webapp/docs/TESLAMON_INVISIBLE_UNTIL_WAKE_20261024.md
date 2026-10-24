# TeslaMon invisible-until-wake behavior — 2026-10-24

## Scope

Main YT Streamer puppy at `https://stream.ameshalex.com/` only. No changes to
TeslaMon Play, wake-word model/ONNX weights, transcription worker, API planner,
Cloudflare Access, Home Assistant, or the player media engine.

## Behavior

- A verified action (`observed` playback/control, or `ha_done`) closes
  the controls and hides the entire puppy, handle, and MIC badge when the
  foreground Hey Jarvis listener is enabled. Search/play remains visible
  while still `accepted`/buffering until live playback confirmation.
- Any native or in-page video fullscreen transition hides the entire pet,
  including when fullscreen was entered from the player rather than the pet.
- During native fullscreen the pet DOM is temporarily placed inside the
  fullscreen screen element, allowing a later wake invocation to display
  the controls without exiting fullscreen. It returns to `body` on exit.
- The same existing openWakeWord detector continues running while TeslaMon
  is hidden. A `recording` event (actual Hey Jarvis recognition) restores
  the pet, opens the controls, and focuses `#tmText`, requesting the
  virtual keyboard where browser rules permit.
- The microphone-off/error fallback remains tappable except while the
  player is fullscreen. Exiting fullscreen restores that fallback.
- Response revision guards prevent a late action from dismissing a newer
  wake session or edited text draft. Unconfirmed commands, errors, and
  interrupted playback do not count as successful completion.
- Explicit input-focus requests cannot override browser/Tesla gesture
  restrictions on showing the virtual keyboard. No permission bypass,
  cloud wake model, or ambient transcript upload is introduced.

## Verification

- `node --test test/teslamon-presence.test.mjs`: confirmed outcomes,
  errors/buffering, newer wake and typed-draft protection.
- `npm test`: **614/614** pass; `npm run check`: pass.
- `node scripts/teslamon-live-browser-check.mjs`: **20/20** controlled Chrome
  layouts/interaction scenarios pass.
- `node scripts/mobile-player-browser-check.mjs`: **10/10** classic/new mobile
  player scenarios pass.
- Browser check includes manual fullscreen hide/exit recovery and a
  synthetic detector callback exercise of hidden → wake → focused input.
  That callback test does **not** certify the pretrained ONNX model's
  recognition accuracy or microphone permission on a Tesla/iPhone.
- Release and live acceptance evidence should be appended after shipping.

## Rollback

Restore only the previous packaged application code and dependencies
from a scoped pre-release backup, leave runtime `data/`, private values,
signed Mac audio helper and LaunchAgent configuration untouched, restart
only `com.ytstreamer.webapp`, and verify the previous health revision.
