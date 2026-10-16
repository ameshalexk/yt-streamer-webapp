# APNE Experimental compact episodes — October 16, 2026

Branch: feat/apne-experimental-compact-archive-20261016 from latest fetched origin/main (18eb2bc at start). Copied earlier experimental-only assets rather than merging unrelated legacy server changes.

## User-facing behavior
- 10 episodes per page newest first; Older/Newer buttons top and bottom and horizontal finger swipes.
- Calendar retained but collapsed by default. Choosing a date jumps to the nearest indexed episode's page.
- Eight show choices compactly swipe horizontally on iPhone.
- Removed crowded date chips and sorting widget.
- Larger previews, direct authenticated GET JPEG loader replacing HEAD-to-GET double requests, 202 polling, bounded concurrency and Blob cache.
- Read-only existing progress; stable streaming and downloads unchanged.

## Source limit
The live /api/apne-daily provides 24 Anupamaa episodes, 2026-09-23 through 2026-10-16. Upstream HTML currently exposed 24 episodes and no older-page navigation. The three-month server cap remains. The page can go to the oldest INDEXED episode, not arbitrarily far back. End-of-catalog notice makes this explicit. Future archive discovery is separate.

## Validation
- npm test: 391/391 passing.
- Browser against live catalog with experimental assets mounted only in test browser: real eight shows; 10 rows/page, Older/Newer and left/right swipe, optional calendar, cached JPEG loaded using signed-route simulation, and responsive 320/360/390/430/850 widths; no JS errors or write requests.
- iPhone Cloudflare-authenticated thumbnail GET must still be checked by user. Cached image fixtures do not prove remote authentication end-to-end.
- Production deployment limited to four public/experimental static files after backup, no stable app or backend changes.
