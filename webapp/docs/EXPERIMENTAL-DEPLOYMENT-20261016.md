# Experimental APNE preview — deployment record (2026-10-16)

URL: https://stream.ameshalex.com/experimental/

## Scope
- New additive static assets: public/experimental/index.html, app.js, styles.css, apne-mobile-browser.js
- Stable homepage only gained one Experimental menu link below APNE Daily with inline CSS
- No production player, backend, tunnel, service process, or data changes; no restart
- Existing Cloudflare Access protection applies to the experimental route and assets

## Data and safe testing
- Uses real Anupamaa episode dates and statuses via GET /api/apne-daily.
- Existing viewed progress uses GET /api/apne/progress when authenticated.
- No POST, PATCH, DELETE or streaming; playback and download are intentionally disabled.
- The standalone preview imports the same date-selection helper from the feature branch, but does not replace production UI.

## Verification
- node scripts/experimental-route-check.mjs: PASS (offline Chrome fixture, 320/390/850 widths, navigation, paging, progress filter, zero writes)
- node scripts/experimental-local-live-check.mjs: PASS (24 real episodes on test date)
- node scripts/experimental-menu-live-check.mjs: PASS (live hamburger menu to experimental path)
- CF Access 302 on /, /experimental/ and /experimental/app.js when unauthenticated
- Local static assets HTTP 200, stable release revision unchanged (d9ba1ee)

## Rollback
The homepage backup is at:
~/Documents/YTStreamerRollback/experimental-menu-20261016/index.html.before

To undo, remove only the new menu link and corresponding inline CSS after checking the current live homepage for concurrent edits. Avoid overwriting later work with the old backup.
Experimental assets reside at:
~/Library/Application Support/YTStreamerWebapp/public/experimental/

To update the experimental version, publish only these namespaced assets from a clean feature branch. Never overwrite the stable public/app.js, public/styles.css or public/index.html with wholesale branch versions without explicit deploy-to-prod approval.
