# YT Streamer: active codec and audio-clock recovery

## User-facing change

The Video mode buttons indicate the selected preference. The status beneath them now names the **actual playing renderer**: MJPEG (JPEG frames), JPEG XL (JXL), or WebCodecs (H.264), plus audio health. Audio may report connecting, synchronized, reconnecting (1/3), muted, or unavailable with silent video-clock fallback. The Retry audio button appears if all automatic retries fail.

## What the video clock means

When audio plays, its elapsed media time is the master clock used to synchronize video frames. When the separate audio source fails, the buffered player uses a monotonic performance-based timer to keep video moving. That fallback is resilient but is **silent** and should not be presented as a complete playback success.

## Root cause and fixes

The old audio FFmpeg server sent HTTP 200 before any MP3 bytes existed and listened to the inbound request close event. For streaming GETs, the request can close as soon as request reading finishes while the response is still streaming, prematurely terminating the FFmpeg audio encoder. The new handler waits until first actual MP3 bytes before sending 200, uses the response close event for cancellation, returns 502 on no playable audio, and handles client backpressure and stream limits. Signed audio URLs may also expire; transient upstream 403 refreshes were seen but are not definitively tied to the user's exact playback failure.

When an audio element reports failure, buffered MJPEG/JXL playback saves the current video-clock position, automatically retries up to three times using a fresh audio URL and current playback timestamp, and returns to audio-master synchronization if the audio element plays. Repeated errors produce a visible Audio unavailable video clock silent message and manual Retry audio button. A missing track is reported as an error, not empty successful MP3.

## Verification

From webapp run `npm run check`, `npm test`, `npm run test:audio-stream`, `npm run test:audio-recovery-browser`, `node scripts/mobile-player-browser-check.mjs`.

The audio-stream test uses disposable FFmpeg-generated audio and a video without audio to assert HTTP 200 with real MP3 bytes versus HTTP 502 without bytes. The browser test simulates an initial HTTP 502, confirms the audio element's currentTime advances after automatic recovery, then four failures and a working manual retry. Loopback only; real YouTube/iPhone playback still needs device validation.

## Isolation and rollback

Fresh branch from main following JXL opt-in PR #54. Preserve the JXL LaunchAgent environment, both installed FFmpeg versions, runtime data, Home Assistant, and all unrelated feature branches. Before deployment, save current Mac release code and wait for idle streams; verify the exact GitHub release SHA. Revert by redeploying the prior verified Mac release while preserving runtime data.