# TeslaMon live voice: existing PowerALX Life Recorder GPU worker

## Production issue and scope
iPhone Web Speech Recognition could end with no transcript even with microphone permission. Production was using browser-native speech and not sending audio to PowerALX.

This scoped Mac candidate replaces Web Speech with the staged push-to-talk Safari MediaRecorder capture and a signed, bounded, same-origin POST. The Mac performs only validation, duration probing and SSH/SCP transport. It loads no speech or other model, installs no model, and never falls back to Mac ASR. The only transcription engine is the existing PowerALX Life Recorder GPU worker, release phase1-20260912-b, with its existing model/cache/GPU lock and downloads explicitly disabled.

## UI and security
- Pet controls only the tab where it is open. No remote browser picker, other device controls, paid AI, or Codex integration.
- The microphone button says Hold to talk only if authenticated same-origin capabilities report configured PowerALX STT; otherwise voice is disabled while typed commands remain.
- Safari capture fix calls MediaRecorder.stop before stopping microphone tracks; accepts codec-decorated audio/mp4 and delayed final chunk; button blur after release does not cancel finalization. Recording max 20s/5MiB. Empty/invalid audio is rejected.
- /api/teslamon/capabilities and /api/teslamon/transcribe check exact pinned public Origin, same-origin fetch metadata and signed Cloudflare Access JWT, authenticating BEFORE buffering an uploaded recording. The production relay exposes only an identity-checking seam, not additional remote playback actions.
- Transport-only Python helper uses existing Life Recorder SSH/SCP utilities; validates the remote job result UUID and SHA256. It transmits short audio to an isolated PowerALX per-UUID job, returns up to 220 characters for same-tab parser, and never stores transcript in Streamer. Private Mac temporary files are cleaned up. Remote media after uncertain failure may remain isolated rather than deleting a file an active worker may use.
- No separate Cloudflare account or player changes.

## Private Mac configuration, never in Git
TESLAMON_POWERALX_SSH_ALIAS=poweralx
TESLAMON_POWERALX_WORKER_ROOT=C:\Users\Amesh\life-recorder-worker
TESLAMON_POWERALX_WORKER_RELEASE=phase1-20260912-b
TESLAMON_POWERALX_PYTHON=/usr/bin/python3 (optional default)

No models, credentials or API keys are committed. Existing worker and private SSH config remain unchanged.

## Verification
Unit fixtures cover supported MIME, size bounds, no-model fallback, serialization, no live worker invocation, SHA-bound result, Safari late final chunk, event cancellation. CI requires both platforms and signed auth regression checks before Mac-only rollout. No real iPhone audio, PowerALX GPU inference or user session has been accepted yet.
