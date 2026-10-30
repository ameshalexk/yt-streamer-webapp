# TeslaMon Aura startup behavior — 2026-10-30

On each fresh document load, the pet module prepares one Aura entry after its UI and fullscreen monitoring are initialized. If the document is already visible it enters immediately; if the browser initializes it in the background, entry waits until its first foreground transition. The saved Aura preference defaults to On. When it is On and TeslaMon is not master-disabled, the entry starts in a truthful preparing/standby state; presentation entry adds no microphone request, recording, or playback action.

The ordinary entry guards still apply. Aura is not opened while the document is hidden or while video is already playing. The first foreground transition consumes the entry even if playback prevents it, so pausing a video later does not queue another takeover. Disabling Aura/TeslaMon or page teardown cancels any pending entry. An active startup presentation can show later capability or voice-bootstrap status, including Mic Off or voice unavailable, without being reopened after dismissal. Closing it, hiding it after it has opened, Preview Aura, or a wake-owned entry clears startup ownership. Existing wake-triggered microphone behavior is unchanged.

The first-visible regression was reproduced against the previous release: starting hidden and then dispatching the first visible transition left Aura hidden. The browser harness now covers that transition, preference suppression, an already-playing player, and dismissal followed by visibility changes and delayed capabilities. Chrome's deterministic visibility fixture is separate from physical iPhone/Tesla acceptance.

Cache marker: `teslamon-pet.js?v=20261030-aura-first-visible1`.
