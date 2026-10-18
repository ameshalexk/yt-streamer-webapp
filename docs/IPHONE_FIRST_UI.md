# iPhone-first and responsive UI acceptance rules

Every user-facing UI change must work on a real phone-sized viewport **before** it is considered complete. Treat this as a project-level requirement across all website/dashboard tasks, not a late CSS cleanup.

## Required checks

- Design for narrow screens first: at least **320, 375, 390, 430 px**, plus a tablet-size width and both landscape/portrait.
- Prefer a single column on phones, no viewport-wide tables, overlapping controls, illegible icons, forced sideways scrolling or hidden essential buttons.
- All interactive controls should have readable accessible names and **at least 44×44 CSS px** usable touch area. Respect iOS safe-area insets and the address bar's dynamic viewport.
- If an item starts playing media from any screen or list, **reveal the active player automatically**. Never force a user to go Home or hunt for a player off-screen. Do not steal scroll position during background retries, automatic quality switches, or seeking.
- Put playback quality controls **with the player**, visibly and consistently in every applicable player; don't hide it just because a codec or external source cannot be controlled. For external players explain `Quality · Source` or actual decoded resolution rather than offering fake quality settings.
- Essential playback controls must stay visible or be discoverable with one tap; don't let large rows of controls obscure most of the video on a phone.
- Preserve app state, accessibility, fullscreen, external provider security, authentication and legacy browser / Tesla fallback behaviors.
- Test Classic **and** New UI if the project supports both; test all major entry points (Browse, Recommendations, Library, APNE, deep links).
- Use real or headless browser dimensions and interactions; green Node tests alone are not sufficient to claim phone usability. Record whether physical iPhone Safari was tested or only Chrome viewport emulation.

## YT Streamer local verification

Run inside `webapp`:

```sh
npm run check
npm test
node scripts/mobile-player-browser-check.mjs
```

The browser test runs **only an isolated loopback server** and emulates iPhone screen sizes with local Chrome; it does not sign in, launch video jobs or deploy. Still verify native iPhone Safari and authenticated playback after deployment.

## Release boundary

Keep each fix on a fresh branch, verify shared CI and packaging for both Mac/HA, push and maintain the exact commit in Obsidian. Do not touch the separate `YT-JXL-EXP` draft PRs when making ordinary phone UI fixes.