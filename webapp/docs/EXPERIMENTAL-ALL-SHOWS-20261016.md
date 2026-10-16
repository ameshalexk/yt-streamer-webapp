# Experimental APNE all-shows update — October 16, 2026

Scope: Experimental only, https://stream.ameshalex.com/experimental/. No promotion of player or UI to stable.

- Browse every configured APNE show using touch-friendly two-column show buttons; retain each show's date, sort and watched filters.
- 54px back button with 31px arrow on iPhone. Larger Refresh, sort, episode details and pagination touch targets.
- Preview stills now use the existing authenticated bounded /apne/thumb/ (saved) and /apne/live-thumb/ (unsaved) services, with the supported /apne/official-thumb/ Anupamaa fallback. Lazy load at most two workers, HEAD poll through HTTP 202 then GET JPEG. Some providers do not expose supported HLS; show Preview unavailable rather than inventing images. Uses existing thumbnail cache only; no full video download or watched-history modifications.
- Multipart episode date suffixes remain browseable by air date; the server may lack an exact YYYY-MM-DD thumbnail key.
- No POST, PATCH or DELETE requests; playback and downloads stay disabled in Experimental.

Tests: npm run check, npm test (325/325 pass), node scripts/experimental-route-check.mjs (all shows, multipart dates, mocked real preview and 202 status polling, 320/390/430/850 responsiveness, no writes). Verify live after publishing.

Rollback: restore only namespaced experimental static files from ~/Documents/YTStreamerRollback/experimental-v1-20261016/. Do not replace stable files. No stable homepage, player, backend or Cloudflare edits for this update.

## Post-publish verification
- Published only namespaced experimental/index.html, app.js and styles.css on the running Mac.
- Stable homepage SHA-256 remained 133a08411d766dc6 before/after. No restart.
- Authenticated existing thumbnail routes stay protected by Cloudflare Access. Local unauthenticated HEAD cannot provide real JPEG; graceful fallback applies. Real JPEG and HTTP 202 retry verified with isolated mocked backend.
- Real APNE GET data: 8 configured shows and 24 Anupamaa episodes at verification. Hospital Uri and Shayad multipart titles present. Responsive at 320/390/430/850px, no write requests.
- Production main code has not been promoted. User review is next.
