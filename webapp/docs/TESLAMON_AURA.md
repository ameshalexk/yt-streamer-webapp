# TeslaMon Aura (feature-flagged voice presentation)

Aura is a cinematic, full-viewport replacement for the voice interaction screen
that appears after TeslaMon accepts a wake phrase. It is a UI layer over the
existing same-tab TeslaMon and Home Assistant light command paths. It does not
replace or add any microphone, speech, Codex, vehicle, or network functionality.

## Behavior

- Aura is enabled by default on a fresh browser profile.
- Open TeslaMon's dog controls to switch **Aura fullscreen experience** on/off.
  The preference is stored per origin under 'ytStreamerTeslaMonAuraEnabledV1'
  ('0' disables it) and syncs to same-origin tabs.
- With Aura on, an accepted wake phrase shows the full-viewport orb and
  progress states: Listening → Transcribing → Understanding → Acting → Done.
  Errors use a distinct state. The spoken command can be displayed as text.
- Tap anywhere on Aura (or click, Escape, Enter, or Space) to exit.
  **Exiting Aura does not disable the microphone, cancel an
  in-flight command, or resume paused playback.**
- The pet controls include **Preview Aura** for filming without speaking a
  wake phrase.
- With Aura off, TeslaMon uses the original pet panel and command entry flow.
- TeslaMon's existing **X** still means full opt-out and immediately stops
  microphone listening. Aura cannot override this opt-out.

The overlay fills the **browser viewport** using CSS and iPhone safe areas.
Automatic native operating-system fullscreen is not requested: browsers require
a direct user gesture for the Fullscreen API, and Safari has restrictions.
Existing player fullscreen remains independent; Aura follows its fullscreen
element when available.

Animations are pure CSS with 'prefers-reduced-motion' support, no external
fonts/images/media assets, and no new network requests.

## Verification

From the webapp directory:

- npm run check
- npm test
- npm run test:teslamon-aura-browser
- node scripts/teslamon-handsfree-browser-check.mjs
- node scripts/teslamon-local-stt-layout-browser-check.mjs
- node scripts/mobile-player-browser-check.mjs

The Aura fixture covers Classic/New UI at 320×568, 390×844, 844×390 and
1280×800. It checks full-viewport geometry, no horizontal overflow, default
flag, persisted opt-out, legacy fallback, preview, touch/Escape dismissal,
mic-on state after dismissal, and one completed synthetic planner dispatch.
The hands-free fixture covers actual same-tab adapter pause ordering before
recording and confirms no implicit playback resume.

## Release requirements

This shared UI affects both the Mac and Home Assistant release artifacts.
Follow AGENTS.md and docs/SHARED_RELEASE.md: PR, **Both platforms passed**
CI (macOS/Linux and native amd64/aarch64 packaging), immutable release from
the same commit, host-specific backups and idle checks, deployment only after
release approval, and physical iPhone/Tesla acceptance. Synthetic Chrome
viewport emulation does not prove Tesla or Safari behavior.
