# APNE reliability and discovery — 2026-10-16

Scope: shared APNE catalog/browser, thumbnail validation, playback controls; no provider credential changes, downloaded-video deletion, or auto-switch to lower-quality streams.

- Numbered episode keys (`YYYY-MM-DD-eN`) are valid for saved and on-demand HLS preview routes while retaining strict genuine-date and safe-show-ID validation.
- Client episode sorting compares broadcast dates then numeric episode numbers rather than text suffixes, so Episode 10 follows Episode 9 in chronological order.
- Browser-private 30-minute thumbnail caching reuses the server's existing bounded disk cache. Previews are queued ahead of scrolling and up to three HTTP requests may be pending; the single ffmpeg worker and upstream byte limits stay unchanged. A source that cannot be decoded can still display "Preview unavailable".
- Episode detail status is labeled availability, not source. Watch filters distinguish not started, in progress, watched, and not finished; native playback history is shared across devices signed into the same account.
- Bounded APNE catalog history expands from three to twelve months, up to 500 detected entries per show, *only where the third-party catalog exposes them*. No bypass of unavailable/removed episodes.
- Native video reports decoded pixel dimensions and whether it is at least 720p, without promising provider quality or probing a third-party iframe. Manual provider controls remain unchanged.
- Read-only search across existing configured shows/episodes plus previous/next navigation on live and saved native players. "Next episode" is an explicit link after playback ends; never automatic playback.

Verification: `npm run check`, `npm test`, and shared release's macOS/Linux/amd64/aarch64 checks. Rollout requires the shared two-host release process in `docs/SHARED_RELEASE.md`, backup and host-specific smoke tests. Existing saved video, history data and upstream streaming credentials must remain untouched.
