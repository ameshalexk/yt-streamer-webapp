# Optional DASH playback mode

Tracked by https://github.com/ameshalexk/yt-streamer-webapp/issues/4.

One small button immediately below the shared player selects MJPEG or DASH. The shared player is reused by the website tabs; no navigation, player controls, or existing quality presets were redesigned. The button follows the existing player visibility/collapse behavior. MJPEG is the default. Selection is saved in `yt-streamer-playback-mode` and synchronized between same-origin browser tabs with the storage event. Storage denial falls back to an in-memory selection and MJPEG on a fresh load.

DASH uses the existing source routes with `transport=dash`, resolves YouTube through the existing resolver/proxy, and transcodes into H.264/AAC fMP4 segments with a DASH manifest. The browser uses the already-vendored MP4Box module, VideoDecoder, Canvas, AudioDecoder, and an AudioContext master clock. VideoToolbox is preferred on macOS; `DASH_VIDEO_ENCODER=libx264` selects the portable encoder. Decoder capability checks prefer hardware and permit software configuration. Runtime decoder errors fall back to MJPEG.

Supported media sources: saved items, direct media/channel URLs, YouTube, prepared videos, and processed library video with its separate audio. Browser/desktop screen capture and embedded pages retain their existing transport. The preference is still shared on those tabs, and a capture fallback uses the MJPEG label. This change does not convert a captured desktop/browser session into a DASH source.

Switching an active media stream retains VOD position, mute, and pause intent. Seeking uses the same replay callbacks. Audio stays inside the DASH player's AudioContext; no duplicate separate audio element plays. A failure cleans up the DASH player and encoder and starts the existing MJPEG implementation at the current absolute VOD position. The saved DASH preference is retained for the next attempt. A stale failed attempt cannot replace a newer selection.

DASH sessions use random IDs, allowlisted media filenames, 20 manifest segments plus five extra files, a ten-second producer lead, pause/resume backpressure, a concurrency limit, a 45-second abandoned-session timeout, and explicit deletion. Client fetches, decoder queues, frames, and scheduled audio are bounded; frames/audio/decoders are closed on cleanup. No VideoDecoder.flush is used in playback, matching the successful Tesla v6 probe. Temporary media lives in a per-process OS temporary directory, separate from existing MJPEG/HLS runtime data.

Validation (2026-09-27, local Chrome / isolated port 18109):

- All 108 Node tests passed, including real FFmpeg MPD/fMP4 generation, encoder pause/resume, startup cancellation, path rejection, session deletion, preference defaults, resource release, and stale-error/position-preserving MJPEG fallback.
- Chrome played an animated 45-second fixture with the new decoder/render path. Pause, resume, mute while paused, seeking, fullscreen, and switching both directions were exercised.
- Switching while paused retained approximately 15 seconds and restored Pause in both transports.
- A second Chrome tab inherited DASH selection and changing it synchronized the first tab.
- Deleting the active local DASH session triggered automatic MJPEG recovery at 38.13 seconds. Muted state was retained; MJPEG rendered the remaining 165 frames to the end.
- The button's small size and placement below the existing player were visually inspected.
- This validates local integration, not a new real-Tesla integrated-player test, subjective audible output, a long-session A/B benchmark, or every upstream provider. The prior Obsidian v6 result validates the probe only.

Deployment: feature branch only; production has not been changed. Validate the integrated player on the real Tesla and representative network sources before production rollout. Keep MJPEG default/fallback.

Reference architecture: [WebCodecs specification](https://www.w3.org/TR/webcodecs/) and [FFmpeg DASH muxer](https://ffmpeg.org/ffmpeg-formats.html#dash-2). Project history is in Obsidian `Projects/YT Streamer - Cyberdash Quality Research.md`.
