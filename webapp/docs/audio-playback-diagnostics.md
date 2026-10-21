# WebCodecs audio diagnostics (2026-10-21)

The embedded WebCodecs player sends read-only diagnostic events to the existing `POST /api/playback-event` endpoint and `data/playback-events.jsonl`.

- `cyberdash_audio_health` is sent at most once every 20 seconds while an active WebCodecs session plays. It records scheduled-audio horizon, audio blocks received/scheduled, late/overlap counts, AudioContext state and video/audio feed end flags.
- `cyberdash_audio_anomaly` is sent when video is advancing with no scheduled audio ahead (or an unexpected AudioContext state) for at least 2.5 seconds. Muted, paused, rebuffering and startup playback are excluded.
- `cyberdash_audio_recovered` reports when the same observation clears.
- `cyberdash_player_summary` retains the final scalar audio measurements.

A schedule-gap event is **not** proof of actual audible silence: it cannot observe iPhone/Tesla speaker volume, audio routing, or the content of decoded samples. Unexpected source silence can occur with a full audio schedule. Correlate the event with quality switch, buffer and session-summary timestamps.

The data contains no raw audio or browser credentials. The normal playback-event rotation remains 5 MiB + one previous segment, so retention is size-limited rather than a fixed number of days. No playback or recovery policy is modified.
