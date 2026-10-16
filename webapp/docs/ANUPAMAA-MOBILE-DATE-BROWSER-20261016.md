# Anupamaa mobile episode browser — held for review (2026-10-16)

Status: Implemented and tested locally. NOT deployed. No live runtime files or LaunchAgents were modified.

## User experience
For widths up to 640px, Anupamaa opens as a compact episode browser:
- Horizontal chips for actual available episode dates and native date picker.
- Newest/oldest sorting, hide explicitly completed episodes, jump to latest/all dates.
- Compact episode rows retaining Stream, Download, Resume, progress and Mark Watched.
- Clear empty-state when no episodes match a selected date or filter.

Other shows and desktop >= 641px retain their previous interface. The existing APNE Daily and APNE watch-progress APIs are reused. No backend endpoint or playback method was added.

## Changed feature files
- public/apne-mobile-browser.js: pure episode/date helpers.
- public/apne-mobile.css: mobile-specific layout.
- public/app.js, public/index.html: existing UI integration.
- test/apne-mobile-browser.test.mjs: five unit checks.
- scripts/apne-mobile-preview-check.mjs: offline fixture-based browser smoke.
- test/apne-daily.test.mjs: refresh outdated static assertions.

The branch has a separate initial commit importing source code only from the currently running runtime, since GitHub main has older APNE logic than production. Do not deploy or wholesale merge this branch without reviewing concurrent YT Streamer changes.

## Verification
- npm run check: PASS.
- npm test: 322/322 PASS.
- node scripts/apne-mobile-preview-check.mjs: PASS (320px and 390px phone, 850px desktop; date jump, sorting, watched filter and reset).
- git diff --check: PASS.

## Release hold
1. Reconcile with concurrent changes in YT Streamer (especially APNE playback and resume).
2. Review physical iPhone experience and real APNE listings in staging.
3. Verify playback/progress/return link in staging.
4. Obtain explicit approval before any live deployment.

Worktree: /Users/amesh/Developer/yt-anupamaa-mobile-20261016
Branch: feat/anupamaa-mobile-date-browser-20261016
Repository: ameshalexk/yt-streamer-webapp
Branch remains local, not pushed automatically.
Obsidian connector is read-only; this document and the Mac Control project-session checkpoint preserve the handoff.
