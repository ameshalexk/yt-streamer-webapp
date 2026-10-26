# AI account controls auto-hide

The fixed Disable AI / Sign out & sign in box collapses after five seconds
without interaction. A 44 px AI button reopens it. Pointer, keyboard and focus
activity restart the timer; collapsing restores focus to the launcher when
necessary. Hiding changes visibility only: consent, session, socket, playback
and background status handling are preserved. Auth retries cannot reopen it.
Safe-area offsets and 44 px action targets apply to the panel and launcher.
The production script URL is cache-busted. The existing Mac-hostname gate is
unchanged; both packages contain the shared change but HA does not gain new
AI account functionality.

Validation on macOS with isolated Google Chrome fixtures:

- npm run check: passed.
- npm test: 641/641 passed.
- node scripts/ai-controls-autohide-browser-check.mjs: 14/14 passed. Classic
  and New UI at 320, 375, 390, 430, 768 px, 844x390 landscape and 1440x900.
  Virtual-clock checks cover the 4999/5000 ms boundary, reopening, interaction
  resets, unchanged consent, and late auth retries. Layout measurements cover
  viewport containment, no horizontal scrolling, and >=44 px targets.
- node scripts/mobile-player-browser-check.mjs: 10/10 passed.
- node scripts/ai-agent-access-reauth-browser-check.mjs: 4/4 passed.

Results and representative 390 px expanded/collapsed screenshots are adjacent.
These are Chrome emulation and fixture tests, not physical iPhone Safari or
Tesla acceptance. No deployment, live sign-out, AI disable or media command.
