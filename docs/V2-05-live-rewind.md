# V2-05 — YouTube live rewind feasibility

Research completed September 14, 2026. This story is a feasibility decision, not a DVR implementation.

## Decision

**NO-GO for generic live rewind in the current v2 resolver.**

Do not expose a live seek bar yet. Keep the current truthful live/unseekable behavior until the server can explicitly detect and respect the broadcaster's DVR setting and expose a bounded synchronized window.

## Evidence

YouTube officially allows broadcasters to enable or disable DVR. When DVR is disabled, viewers cannot seek backward while the stream is live. YouTube also documents that rewind can be limited or unavailable on very long streams, including streams longer than 12 hours.

Current source checks on September 14, 2026:

### DVR disabled example

Current NASA ISS live stream:
- video ID observed: `M3HKLzjvKPc`
- yt-dlp reports `is_live=true`, `live_status=is_live`, duration unknown
- current YouTube page data reported `isLiveDvrEnabled=false`
- normal yt-dlp resolution exposed only current-edge HLS (`m3u8_native`)
- surprisingly, yt-dlp `--live-from-start` still produced generated DASH fragment formats marked `is_from_start=true`

This is an important safety/correctness finding: **yt-dlp's ability to enumerate old fragments is not sufficient proof that the broadcaster enabled viewer DVR.** We must not use that as permission to expose rewind.

### DVR enabled example

Current LiveNOW FOX live stream:
- video ID observed: `C96oohpWBGw`
- YouTube page data reported `isLiveDvrEnabled=true`
- yt-dlp `--live-from-start --simulate` exposed video/audio formats marked `is_from_start=true`

Other current 24/7 news streams tested also exposed from-start fragment generation, so the transport is technically possible for at least some live sources.

## Why the current app cannot implement it safely

The existing YT Streamer live path:
- resolves the current live edge only
- does not request `--live-from-start`
- does not expose a moving window start/end
- does not expose fragment sequence/timestamp boundaries
- marks live playback unseekable in the browser
- has no contract for restarting MJPEG video and separate audio at the same historical live point

Adding a timestamp field alone would therefore be misleading.

yt-dlp also labels `--live-from-start` experimental, and current 2026 yt-dlp issue reports show ongoing YouTube live-from-start failures/interruptions. It is not stable enough to silently build production DVR behavior around without an explicit bounded adapter and fallback.

## Bounded follow-up story

**V2-DVR-01 — Respectful bounded live DVR adapter**

Acceptance:
1. Server probes the YouTube live page/source for an explicit DVR-enabled signal. Missing/ambiguous signal defaults to **no rewind**.
2. Never expose rewind when the broadcaster reports DVR disabled.
3. For a verified DVR-enabled source, derive a bounded moving window and return:
   - `windowStart`
   - `windowEnd`
   - `liveEdge`
   - `supportsDvr`
4. Cap the app's supported rewind window independently (for example 1–2 hours initially) even if YouTube retains more.
5. A seek must restart both server-side video and audio from the same timestamp/fragment boundary.
6. Browser video remains MJPEG and audio remains separate.
7. Add **Go Live** and handle positions that expired from the moving window.
8. If source window derivation fails at any point, fall back to **Live — rewind unavailable**.
9. Validate one DVR-enabled source and one DVR-disabled source on a parked Tesla.
10. Do not add an unbounded local recorder.

If direct fragment-window access proves too fragile, a separate optional rolling local ring-buffer design should be estimated rather than hidden inside this story.

## Current user-facing behavior

Keep live streams explicitly unseekable. The existing live status is truthful; a future DVR story may change the wording to **Live — rewind unavailable** when the probe says DVR is off.


## Final source recheck

Rechecked on September 14, 2026 at about 20:52 CDT with the isolated v2 yt-dlp environment:

- NASA `M3HKLzjvKPc`: live, duration unknown, normal resolver exposed current-edge `m3u8_native`; `--live-from-start` exposed generated from-start DASH formats. The live YouTube page reported `isLiveDvrEnabled=false`.
- LiveNOW FOX `C96oohpWBGw`: live, duration unknown, normal resolver exposed current-edge `m3u8_native`; `--live-from-start` exposed generated from-start DASH formats. The live YouTube page reported `isLiveDvrEnabled=true`.

Because both streams expose from-start formats even though one explicitly disables DVR, transport capability alone cannot be used as the permission/UX signal. The generic v2 live path therefore remains unseekable.
