# version 2.0 — V2-03 quality profiles

Implemented locally on September 14, 2026 in `/Users/amesh/Desktop/version 2.0` on branch `version-2.0`.

## Profiles

| Profile | Resolution | FPS | Internal JPEG qscale |
| --- | ---: | ---: | ---: |
| Low | 360p | 12 | 12 |
| Medium | 480p | 15 | 7 |
| High | 480p | 24 | 4 |

The player overlay shows only the friendly name plus resolution/FPS. Raw JPEG qscale remains in Advanced Stream settings.

## Behavior

- Low / Medium / High are available directly inside the shared V2-02 video overlay.
- A preset is highlighted only when resolution, FPS and JPEG qscale all match.
- Any manual or fallback combination that does not exactly match a profile is shown as `Custom`.
- The selected profile is stored in `localStorage` under `ytStreamerQualityProfileV2` and restored after reload.
- VOD quality changes restart at the current playback timestamp.
- If playback was paused, the new stream starts at the same timestamp and is paused again as soon as it becomes playable.
- Existing sound state is reused by the restarted stream.
- Fullscreen stays on the same `#screen` element, so native and synthetic fullscreen survive quality restarts.
- Rapid profile taps are coalesced for 140 ms and generation-guarded so only the final pending selection restarts.
- Downloaded-library videos choose the highest available resolution at or below the requested profile height; if none exists, the lowest available resolution is used. The fallback is stated explicitly.
- Live/unseekable streams clearly say the quality restart is returning to live.
- Browser video transport remains MJPEG with separate audio.

## Verification

From `webapp`:

```sh
npm run check
npm test
git diff --check
```

Result: **46/46 tests passing**.

Headless Chrome runtime verification on `http://127.0.0.1:8100/` confirmed:

- stored Medium reloads as 480p / 15 FPS / Q7;
- a 480p / 24 FPS / Q7 manual combination displays Custom;
- Low → High → Medium rapid taps issue one replay and settle on Medium;
- VOD restart preserves the requested timestamp;
- paused VOD restart restores paused state after the replacement stream becomes playable;
- native fullscreen remains active through a simulated quality restart;
- live restart reports `Returning to live`;
- a downloaded item with only 240p/360p available explicitly falls back from High's requested 480p to 360p and displays Custom;
- overlay buttons fit without overflow at 390px portrait, 844px landscape and 1280px Tesla-like widths;
- no page errors were observed in these checks.

## Remaining device check

Before deploying version 2.0, verify in the parked Tesla:

1. Start a normal YouTube VOD.
2. Switch High → Medium → Low while playing and confirm normal media speed.
3. Confirm each change resumes near the same timestamp.
4. Pause, change profile, and confirm it returns paused at the same point.
5. Repeat in fullscreen.
6. Tap Low / High / Medium quickly and confirm only the final profile wins without extra lingering streams.
7. Test a live source and confirm the app clearly says it is returning to live.
8. If available, test one downloaded item missing 480p and confirm the fallback message.

Do not deploy version 2.0 to production until the parked-Tesla acceptance is complete.


## Pause / resume buffering follow-up — September 14, 2026

A real pause/resume test exposed a timeline bug inherited from version 1: pausing buffered MJPEG reassigned `streamSeek.startAt` to the absolute paused timestamp even though the existing buffered player kept its original timeline base. After Resume, `getStreamCurrentTime()` added that paused timestamp a second time. This could make later seek/replay operations jump ahead and made post-pause buffer behavior appear incorrect.

Fix:
- Buffered pause now keeps the original `streamSeek.startAt`.
- Only restart-based legacy MJPEG pause rebases the stream start.
- Paused buffered playback now displays the retained buffer, for example `Ⅱ PAUSED · 8.0s buf`.
- Resume buffering no longer triggers the slow-network quality suggestion because a deliberate user pause is not a network failure.

Real local YouTube regression check at Medium quality:
- before pause: ~0.745 s playback, **8.0 s** buffered, 0 rebuffers;
- after 3 s paused: ~0.747 s playback, **8.0 s** buffered, 0 rebuffers;
- 3 s after Resume: ~3.749 s playback, **8.0 s** buffered, 0 rebuffers;
- 6 s after Resume: ~6.756 s playback, **8.0 s** buffered, 0 rebuffers;
- timeline base stayed at 0 throughout and no page errors occurred.

Automated suite after the fix: **49/49 passing**.
