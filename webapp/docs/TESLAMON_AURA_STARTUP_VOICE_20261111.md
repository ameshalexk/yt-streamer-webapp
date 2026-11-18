# TeslaMon Aura — first-page voice capture (2026-11-11)

## Requested behavior

A normal fresh page load already opens the full-screen Aura. Instead of waiting for
“Hey Jarvis” (or another selected wake phrase), that **first Aura entry** should
automatically start one command recording, as though a wake phrase were accepted.

The resulting recording uses the existing local speech transcription, 2-second
editable grace period, signed Codex planner, same-tab player controls and the same
Home Assistant permissions/approval boundaries as an ordinary wake-triggered command.

## Scope and safety

- Open Aura visually as before. Wait for the existing same-tab player, signed
  capabilities, and ordinary browser microphone permission to be ready.
- Start **one** wake-equivalent bounded recording per fresh document, not one on
  each visibility change or each asynchronous refresh.
- Do not start it for a disabled TeslaMon, disabled Aura, a dismissed startup
  overlay, an initial page with active playback, or a URL-routed video/device
  command (which already has its own one-shot dispatch).
- A background-loaded page defers the first startup Aura and recording until
  it is actually foregrounded.
- Reuse the existing pause-before-capture, silence end, cancellation, ownership,
  transcript deduplication and recovery paths. After the first command, resume
  ordinary selected wake-phrase listening; do **not** create a permanently open mic.
- No speculative Codex request is sent merely from entering Aura. Only an actual
  spoken transcript can reach the planner.
- Mic Off, pagehide, permission rejection, interruption and user disable still
  stop or prevent capture. No browser microphone permission bypass is attempted.
- Manual Preview Aura remains visual only.

## Implementation

- `public/teslamon-handsfree.js`: `startCommand()` invokes the existing
  wake-equivalent lifecycle only when enabled and listening; it rejects duplicate
  starts and remains ineligible after Mic Off.
- `public/teslamon-pet.js`: trigger startup capture once when startup Aura remains
  active and all microphone/player preconditions have resolved.
- `public/index.html`: cache-bust the TeslaMon entry point.
- Tests: `test/teslamon-handsfree.test.mjs` and
  `scripts/teslamon-aura-browser-check.mjs`.

## Verification

- `npm run check`: passed on a separate scratch checkout.
- `npm test`: 821/821 passed on a separate scratch checkout.
- `node --test test/teslamon-handsfree.test.mjs`: 17/17 passed.
- `TESLAMON_AURA_FAST=1 node scripts/teslamon-aura-browser-check.mjs`:
  passed; includes first-page synthetic voice -> planner exactly once without
  a wake word, with zero speculative planner requests.
- Real Tesla microphone permission, speech, local STT and network command
  response remain to be verified on physical hardware before production rollout.

## Release boundary

Development branch / draft PR only. No main merge, service restart, Cloudflare
change, StreamHA update or production deployment authorized as part of this work.
Revert the PR or disable the feature before publishing if hardware acceptance fails.
