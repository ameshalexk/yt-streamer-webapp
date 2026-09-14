# version 2.0 — V2-02 unified video controls

Implemented locally on September 14, 2026 in `/Users/amesh/Desktop/version 2.0` on branch `version-2.0`.

## What changed

- The video surface now owns one shared overlay for play/pause, sound, fullscreen, VOD seeking and the future V2-03 quality-control location.
- A tap while the controls are hidden reveals them without also toggling pause.
- The overlay auto-hides after about five seconds only while playback is healthy and uninterrupted.
- Interacting with controls or the seek bar, pausing, loading, or showing a playback notice keeps the controls visible.
- Native fullscreen and synthetic fullscreen use the same controls instead of separate fullscreen-only UI.
- Unseekable live playback shows `LIVE — Seeking unavailable`.
- The future quality preset slot is reserved on wider layouts and intentionally hidden on narrow phones until V2-03.
- Narrow-screen rules were updated so the seek surface and status overlays do not conflict with the unified controls.

Browser video transport remains MJPEG with separate audio. No automatic quality switching, V2-03 presets, slowdown repair, or DVR implementation was added.

## Verification

Run from `webapp`:

```sh
npm run check
npm test
```

Result on September 14: syntax checks passed; 40/40 tests passed.

Headless Chrome on the isolated app at `http://127.0.0.1:8100/` verified:

- 52 px play/pause, sound and fullscreen controls, with 48 px seek buttons.
- Five-second idle hiding.
- A hidden-state pointer tap reveals controls without pausing.
- One shared overlay remains inside synthetic fullscreen.
- Native `requestFullscreen()` succeeds and the same overlay remains inside the fullscreen element.
- Unseekable live state renders `LIVE` and `Seeking unavailable`.
- Narrow phone CSS hides only the future quality placeholder while keeping the seek row usable.

The Mac mini currently has no attached display exposed to Screen Capture, so the browser preview used headless Chrome rather than a physical desktop screenshot.

## Remaining device check

Park the Tesla and verify:

1. Start a normal VOD item.
2. Wait for the overlay to hide.
3. Tap once in an empty part of the video. Controls should appear and playback must continue.
4. Pause. Controls should stay visible.
5. Drag the seek bar. Controls should stay visible during the drag.
6. Enter and exit fullscreen and repeat the tap test.
7. Open a live/unseekable source and confirm the player says `LIVE — Seeking unavailable`.

Do not deploy version 2.0 to production until that device check is accepted.
