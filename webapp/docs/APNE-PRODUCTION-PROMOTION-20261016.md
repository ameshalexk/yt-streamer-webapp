# APNE Stream production promotion — October 16, 2026

- Default GitHub production branch is main, rather than master.
- Copy confirmed APNE Experimental UI to isolated production route /apne/; preserve /experimental/ as a separate testing surface.
- Existing APNE Daily menu opens /apne/ in the same tab; old /?mode=apne bookmarks and player Return to Shows links redirect to /apne/.
- Every episode thumbnail and the latest hero image link to the existing authenticated /apne/live/watch/:showId/:dateKey player. Numbered episodes preserve their complete unique keys. Playback source selection, download, and watched progress remain in that player.
- Original show management preserved at /?mode=apne&classic=1, linked from production footer. No changes to auth, server routes, video engine, or user data.
- Eight shows, 10/page, calendar exact-date / Show all episodes controls, and phone responsive styling preserved.
- Deployment is static: four new public/apne files and revised public/app.js + public/index.html. Backup and compare current runtime to main before copying. No restart needed.
- Verification: npm check/test plus staging browser script against production read-only catalog and controlled player-route navigation. Protected player response is not bypassed.
