# TeslaMon voice: Safari WebM duration compatibility (2026-10-22)

## Failure and evidence
On a real iPhone the TeslaMon pet displayed **PowerALX transcription is unavailable. Use typed commands.** The Mac YT Streamer server and SSH connection to PowerALX were healthy. Two failed microphone jobs were left on PowerALX: 3.2-second and 3.8-second WebM audio files and their metadata, but no result.json. On Mac, FFprobe's packet timing resolves both durations; on PowerALX, the worker's Windows FFprobe `format.duration` returns `N/A`. The worker's existing `worker/pipeline.py` probes only format duration and fails before speech recognition. Existing normal Life Recorder and PowerALX GPU workers remain unchanged.

## Fix
In `teslamon-poweralx-bridge.py`, **before generating the signed SHA-bound metadata or uploading**:
- Preserve the existing 20-second / 5-MiB input validation and packet-duration probe.
- Normalize WebM/OGG recordings with existing FFmpeg to a seekable mono 16 kHz AAC M4A using one CPU thread and an 18-second conversion deadline. This is audio conversion, not transcription; no model or downloads on Mac, no other ASR service.
- Verify normalized file size, normal FFprobe duration and duration difference (<=0.35s), then recompute SHA-256 over precisely the normalized uploaded bytes and set the worker metadata accordingly. Windows now gets M4A with readable format duration.
- MP4 and WAV pass through unchanged. On a completed, cryptographically verified silent/no-speech result, clean up the remote temporary folder, too; don't remove uncertain/inflight jobs.
- Show distinct bounded errors if normalization fails, without leaking audio or transcript.

## Verified
- Tested a **previously failed real iPhone WebM recording** on PowerALX with FFmpeg normalization only (did not transcribe it). Windows FFprobe then reported 3.201 seconds.
- End-to-end Mac bridge synthetic tone -> convert WebM -> SSH/SCP -> existing PowerALX GPU worker -> downloaded validated response completed and returned `no_speech_detected`, which is the expected outcome for tone-only audio.
- `npm --prefix webapp test` passed 562 tests and `npm --prefix webapp run check` passed. Python fixture covers seekable M4A output and duration checks. Full real user speech -> recognized transcript -> Codex -> current-tab playback still needs iPhone acceptance.

## Scope
Mac `stream.ameshalex.com` only; no HA deployment or app-server changes, Mac resource-light codec conversion only. Preserve Codex CLI integration from release b49e531 and Cloudflare single login. Document PR, release and rollback after final promotion.
