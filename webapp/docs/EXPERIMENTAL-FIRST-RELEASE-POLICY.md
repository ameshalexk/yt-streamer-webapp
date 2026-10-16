# Streamer release workflow — Experimental first

User decision, 2026-10-16:
- Maintain the stable Streamer interface at the normal home URL.
- Create a separately accessible Experimental/APNE Stream entry in the hamburger navigation, below the normal APNE entry. The experimental page should be a genuine test of the implemented code, not a marketing mockup.
- Every new UI/feature change must be built and reviewed on the experimental route/branch first.
- Never promote experimental changes to stable production until the user explicitly says "deploy to prod".
- Experimental and production must coexist on the SAME confirmed hostname; do not switch the default home route.
- Keep experimental data/configuration separate when backend state could otherwise mutate stable playback/watch progress.
- Keep production access protection (Cloudflare Access), prevent unauthenticated bypasses, and avoid weakening existing credentials.
- Before public URL configuration: confirm hostname. On 2026-10-16, stream.dimensionless.com returned bare "OK" via unrelated DNS while the known Streamer was at stream.ameshalex.com and guarded by Cloudflare Access. DO NOT alter DNS, Cloudflare, or the stable menu based on the mismatched hostname.

User explicitly requested only the date-first Anupamaa UI in the current feature branch, not new Search, Settings, Shows, My List or History areas. The earlier generated images were concept-only; the actual local UI is tested through the Playwright fixture script.

Current branch: feat/anupamaa-mobile-date-browser-20261016.
Current feature commit at policy entry: d963a10.
Experimental site published on 2026-10-16 at https://stream.ameshalex.com/experimental/ (CONFIRMED hostname).
- Static route: ~/Library/Application Support/YTStreamerWebapp/public/experimental/ served by existing Node server without restart or tunnel change.
- Stable homepage modified only to add a hamburger anchor after APNE Daily and minimal inline styling. Existing production JS, CSS, Node service, and data unchanged.
- Experimental reads GET /api/apne-daily and GET /api/apne/progress only (when Cloudflare Access authorizes). No watch-history writes, playback, or download actions; UI preview only.
- 320/390/850px browser QA and live API smoke passed. Public original and experimental paths remain guarded by Cloudflare Access.
- Stable homepage backup: ~/Documents/YTStreamerRollback/experimental-menu-20261016/index.html.before.
- Future feature builds: experimental first, stable promotion only after the user explicitly says deploy to prod.
