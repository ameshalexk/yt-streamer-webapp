# YT Streamer UI v3 — Private Dashboard Modernization

**Status:** Local implementation and browser QA (2026-10-08); production unchanged
**Tracker:** https://github.com/ameshalexk/yt-streamer-webapp/issues/24
**Development branch:** `feature/yt-streamer-ui-modernization`
**Obsidian project:** `Projects/YT Streamer - UI Modernization.md`
**Mac Control session:** `yt-streamer-ui-v3-20261008`

## Purpose

Provide a polished, modern, quick-to-use **private** dashboard for the existing YT Streamer without changing its playback engine or breaking existing usage. The ChatGPT UI mockups from 2026-10-08 are *visual concepts*, not a map of implemented capabilities. Use actual deployed UI and data as source of truth.

**Explicit non-goals:** account management, multi-user support, paid tiers, promotional features, user analytics/marketing research infrastructure, replacing the streamer transport, new media discovery backend, new Home Assistant/Camera AI UI, vehicle safety restriction bypasses.

## Starting point: deployed UI discovery

Inspected `/Users/amesh/Library/Application Support/YTStreamerWebapp/public/index.html` and `package.json` on 2026-10-08. The actual deployed app is 2.1.0 with tabs Home, Browse, Recs, Browser, Library, APNE Daily, Tesla, Money; Saved Channels drawer; stream/player controls. The runtime identifies deployed commit `06507e539becb7ed3f261d3db86f479b34bd9952`.

The older local checkout `/Users/amesh/Desktop/ytstreamerhabkupfin/webapp` has many uncommitted changes and is behind its origin branch. The runtime directory is not a Git checkout. **Before writing code, reconcile a clean current source/worktree against production. Do not overwrite or reset the dirty checkout.** This planning branch is for design documents until reconciliation is done.

## Primary user contexts

1. **Parked Tesla Model Y browser:** seated reach, rapid one-tap actions, minimal text, stable touch after scrolling, quality/recovery control, and easy fullscreen. Driver in US left seat: prioritize lower-left/nearer left edge; offer selectable right-side quick area for passenger or alternate reach. Larger-than-standard buttons.
2. **iPhone Safari/PWA:** thumb-reachable sticky bottom actions, safe-area padding, video-first and legible overlays.
3. **Bravia/TV:** focusable navigation and forgiving touch/remote-style targets.
4. **Desktop:** dense options where useful, keyboard/tab accessibility, larger player.

Only permit video controls in ways consistent with Tesla driving restrictions. Test playback in parked mode.

## Product principles

- The **Classic UI is permanent**, not a temporary migration screen.
- **Classic / New toggle** visible and available in both variants, reachable within one tap. Persist per-browser via safe local preference; default classic until user approval.
- Add an emergency query override `?ui=classic` independent of new-view initialization. If modern view fails, render Classic rather than a blank page.
- Use one shared app/player state. Layout should not create a second stream session or drop audio. Switching should preserve playback, pause, seek position, quality and selected tab when possible; otherwise surface a truthful notice and restore state.
- **Tesla quick dock:** Resume, APNE Daily, Downloads/Library, Search/Browse, Fullscreen, and Quality Auto. Targets >=56 CSS px on Tesla, generous spacing; primary actions near reachable display edge, never cover critical content. Optional orientation-side preference.
- Lightweight HTML/CSS, small motion, gentle transitions (approximately 120–200 ms); respect prefers-reduced-motion, low-memory and low-GPU browser conditions. No mandatory Three.js/WebGL to operate the player.
- Responsive design rather than one mockup scaled down. iPhone/TV/Tesla layouts each have their own constraints.
- Use actual existing API values; do not show invented viewer counts, storage usage, quality, network throughput, recent content, subscription controls or upsells.
- Preserve existing browser, screen and remote controls, playlists, APNE Daily download states, Money/Tesla links, live and VOD, audio/video transport toggle and recovery controls.

## Milestones

### M0 — Reconnaissance (in progress)
- [x] Identify the clean source matching the live runtime and inventory dirty worktrees.
- [x] Map actions/domains/states for all production tabs, including player and status overlay.
- [x] Record Classic screenshots, user journeys and current responsiveness outside the public repository.
- [ ] Capture real parked Tesla browser viewport/reach validation constraints.

### M1 — Visual shell (locally implemented)
- [x] Implement isolated modern layout, separate CSS/component layer, responsive styles.
- [x] Render actual player and existing actions; no new media engine.
- [x] Make existing/private navigation complete (Home, Browse, Recs, Browser, Library, APNE Daily, Tesla, Money).
- [x] Keep settings and stream health contextual, not permanently occupying valuable player space.

### M2 — Dual-UI switch (locally implemented)
- [x] Add persistent two-option Classic / New switch in both variants.
- [x] Default Classic, implement `?ui=classic`, failure-safe fallback.
- [x] Preserve shared player nodes, playback and tab state during UI switch in browser fixtures, including paused and playing cases.
- [x] Add switch preference isolation per browser/device.

### M3 — Tesla reach/quick actions (in progress)
- [x] Touch dock near driver's lower-left reach for US left-seat Model Y, passenger side selectable in simulated Chrome viewport.
- [x] Tesla controls >=56 px in 1280x720 and 1500x850 Chrome simulations.
- [ ] Test after scroll, orientation/view changes, mini-player/fullscreen and keyboard input.
- [ ] Respect parked-only safety behavior.

### M4 — Functional parity (not started)
- [ ] Test playlist/saved channel, searches/URLs, YouTube resolution, APNE list + downloads/iCloud status, downloaded videos, Browse/Browser/Recs.
- [ ] Test pause/resume, seek, source change, audio, quality auto/manual, MJPEG/WebCodecs where already supported, fullscreen, error/rebuffer recovery.
- [ ] Check existing Tesla and Money links, theme mode and overlay behavior.
- [ ] Regression tests ensure New UI cannot interfere with Classic.

### M5 — Device acceptance (not started)
- [ ] Desktop Chrome/Safari, iPhone Safari/PWA, Bravia, parked Model Y.
- [ ] Record actual one-tap success, hit targets, focus usability, no focus trap, no tab/player reset.
- [ ] Compare first-picture latency, frame render/rebuffer, frontend CPU/memory before and after.
- [ ] Verify reduced motion and fallback/rollback.

### M6 — Review/release (not started)
- [ ] Present working side-by-side preview, user approves.
- [ ] Back up deployed UI assets and verify exact source commit.
- [ ] Staged, reversible deployment with Classic default until approval.
- [ ] Production smoke, rollback drill; update GitHub issue + Obsidian.

## Scope control & decision log

- 2026-10-08: Planning issue and docs created; no UI deployment or production service restart.
- 2026-10-08: Preserve Classic permanently and do not make transport changes.
- 2026-10-08: Focus on single-user private experience. Treat broad-market UX heuristics only as optional testing tools, not feature requests.
- 2026-10-08: Reach may vary with seating. Provide placement preference; do not hardcode universally right-side tiles.
- 2026-10-08: Runtime marker and local health report `06507e539becb7ed3f261d3db86f479b34bd9952`; 63 relevant tracked files matched that Git tree byte-for-byte. The clean implementation worktree starts from planning commit `ebdb2087d000bd9e2a84144405ec0c405ebadf66`; the dirty source checkout and production runtime were not edited.
- 2026-10-08: Modern view decorates existing player/navigation DOM and delegates actions to Classic controls. Switching changes only the view; the video/audio elements and source stay in place. Classic remains the default with localStorage preference and `?ui=classic` emergency override.
- 2026-10-08: A private loopback preview uses cloned local app data in ignored `.local-ui-v3/` and an environment allowlist; no live service reload. Start with `npm run preview:ui` from `webapp`, then open `http://127.0.0.1:8113/` in Chrome. Review artifacts remain local and are excluded from Git.
- 2026-10-08: Baseline `npm test` 286/286; implementation `npm test` 291/291, `npm run check`, Chrome fixture browser checks (six groups), release unit tests (2/2), and `git diff --check` passed. Chrome checks cover Classic/New switching, media-node continuity and playback intent with AV fixtures, all navigation, 390x844 iPhone Auto, 1280x720 and 1500x850 Tesla simulations, TV user agent, reduced motion, and failure fallback. Fixture tests do not prove live MJPEG/WebCodecs streaming, real iPhone/Bravia behavior, parked Model Y reach, or 10/30-minute stability.
- 2026-10-08: The written specification was available; the exact October 8 generated mockup image was not recovered. Styling follows its documented direction pending visual comparison if the image is located.

## Progress rules

Check GitHub #24 boxes and update Obsidian when a milestone is genuinely completed; record commit SHA, tests, device tests and pending limitations. Before complex changes, snapshot status and checkpoint the Mac Control session. Never claim physical Tesla acceptance from desktop simulation.
