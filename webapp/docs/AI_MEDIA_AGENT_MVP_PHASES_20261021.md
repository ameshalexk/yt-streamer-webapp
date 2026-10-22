# YT Streamer AI Remote Playback — Six-Phase MVP Handoff

**Created:** 2026-10-21  
**Parent:** [GitHub epic #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26)  
**Obsidian:** `Projects/YT Streamer - AI Media Agent and WebMCP.md`  
**Status:** Phase 0 baseline/contract accepted; **1/6 phase exit gates accepted**. Experimental player/MCP code remains unintegrated; ChatGPT-to-Tesla is **not live**.

## MVP boundary

From a **ChatGPT text conversation** or other supported MCP client, "play <specific video> on <named, currently open YT Streamer device>" must search using the existing YouTube API, choose the correct result or request disambiguation, deliver a command to that exact registered browser, and **read back** real state (playing/paused/buffering/failed or user gesture required). Also pause, resume, stop and get state. Never claim playback from an accepted-but-unverified command. Real iPhone Voice tooling is an extra feasibility test; **not a prerequisite** to ship text-controlled MVP. In-page WebMCP is post-MVP (#31); do not confuse it with remote MCP or assume Tesla support.

### Existing work to reconcile — **do not recreate**

- [#27](https://github.com/ameshalexk/yt-streamer-webapp/issues/27) — live player and tool feasibility audit (partially complete).
- [#28](https://github.com/ameshalexk/yt-streamer-webapp/issues/28) — browser session relay, reconnect and target ACK in dev.
- [#29](https://github.com/ameshalexk/yt-streamer-webapp/issues/29) — existing-player search/play/seek adapter in dev.
- [#30](https://github.com/ameshalexk/yt-streamer-webapp/issues/30) — authenticated remote MCP prototype; only isolated synthetic Access JWT/real Chrome tests.
- [#31](https://github.com/ameshalexk/yt-streamer-webapp/issues/31) — experimental in-browser WebMCP; defer to post-MVP.
- [#32](https://github.com/ameshalexk/yt-streamer-webapp/issues/32) — iPhone/parked Tesla QA and release.
- Draft [PR #33](https://github.com/ameshalexk/yt-streamer-webapp/pull/33) (expired sessions and pairing recovery) stacked beneath draft [PR #34](https://github.com/ameshalexk/yt-streamer-webapp/pull/34) (signed Access WebSocket and scoped MCP). Neither merged or deployed.
- PR #34 historical shared release Actions [run 38153602298](https://github.com/ameshalexk/yt-streamer-webapp/actions/runs/38153602298) succeeded on commit `524ebff`; this **does not** establish production security, ChatGPT tool connection, or parked-Tesla acceptance.
- On Oct 21 the running Mac app on `127.0.0.1:8099` reported revision `6adcff204b37206d4f897b3f41f612a179d52c1a`; newer player/JXL/fullscreen updates must not be regressed. Historical dev checkpoint `06507e5` is not the current live version.

## Phases, dependency, owner proposal and exit gates

| Phase | Proposed owner | Linked issues | Exit gate |
|---|---|---|---|
| **0 — Reconcile and freeze integration contract** | ChatGPT | #26, #27 | Inventory current main/runtime, dev branches, stale worktree paths and changed files. Establish exact baseline SHA, safe isolated worktrees, compatibility diff and typed command/state schema. No production edits. |
| **1 — Browser player + target relay** | **Codex A** | #28, #29 | A test controller can select **one** paired test tab, search/play/pause/resume/stop and receive actual ACK/state; wrong/offline tab and duplicate command rejected. Existing player/codec unchanged. |
| **2 — Secure MCP gateway** | **ChatGPT** | #30 | Local MCP client can authenticate, list allowed devices, send bounded commands to approved target and read state; denial tests for forged/expired/wrong-audience JWT, wrong Origin, unapproved action, stale device. Do not expose public ingress before security approval. |
| **3 — ChatGPT tool connection + desktop end-to-end** | **ChatGPT** | #27, #30 | In this account, **prove** text-chat custom/connected MCP availability, or document limitation and prove a compatible agent fallback. Actual desktop two-tab search/play and state readback, no phantom success. Voice only separately when available. |
| **4 — Reliability and cross-platform regression** | **Codex B** (after phase 1 & 2) | #28, #29, #32 | Automate reconnect/expiry/idempotency, multiple clients, playback/autoplay denial, search disambiguation and baseline MJPEG/WebCodecs/JXL, Classic/New and fullscreen regression; both supported platforms CI pass. No performance assertion without measurement. |
| **5 — Parked Tesla acceptance + gated release** | ChatGPT + owner | #32 | User-approved auth/Cloudflare deployment plan; actual parked-Tesla search→play with audio/readback and 1-tap gesture fallback; rollback demonstration, health checks, owner **explicitly approves** each live merge/deploy. Never bypass in-motion restrictions. |

**MVP passes only when Phase 0–5 exit criteria pass.** No invented percentages. Record measured progress and remaining blockers against each gate in epic #26 and Obsidian.

## Parallel execution and file ownership

**First finish Phase 0.** After its interface contract is frozen, allow only **two** coding lanes at once:

- **Codex A / Phase 1** owns the browser playback adapter and related front-end tests (e.g. `webapp/public/ai-media-agent-adapter.js`, device-facing UI hook, browser tests). **Does not edit** security gateway, Cloudflare routing, source `src/server.js` or deploy files. Propose integration hooks in a separate documented contract if needed.
- **ChatGPT / Phase 2** owns server-side authentication/MCP and server-only security tests (e.g. `webapp/src/lib/ai-media-agent-trusted-browser-flow.js`, `webapp/scripts/ai-agent-dev-mcp.mjs`, auth tests). **Does not edit** browser adapter or player `public/app.js` while Codex A owns it.
- **Codex B / Phase 4** is **not started until** both Phase 1 and Phase 2 contracts have integration snapshots. Own test-only files and defects isolated in separate PRs; do not rewrite the implementations without reassignment.
- **ChatGPT / Phase 3 and 5** handles cross-branch integration, the real ChatGPT capability experiment, approval gates, system validation and user handoff; user can reassign these lanes later.

### Change control

1. Each agent: inspect latest epic and this file first; identify exact base SHA. Work in a fresh **isolated worktree/feature branch**. No shared checkout; no resets or overwrite of production/runtime or another agent's changes.
2. One scoped change per branch and draft PR. **Push before review.** Reference the epic and relevant existing issue, include explicit change/test/rollback summaries.
3. Publish proposed interface first: `list_devices`, `search_media`, `play_media`, `pause`, `resume`, `stop`, `get_player_state` (optional `seek`, `next`). Requests include exact target ID and command/idempotency ID; results distinguish `accepted`, `playing`, `paused`, `buffering`, `failed`, `offline`, `needs_user_gesture`.
4. Reconcile PR #33 → #34 against **current** source deliberately, not wholesale cherry-picks over Oct 21 changes. Integration maintainer resolves conflicts, tests and reviews; never let separate agents merge directly to main.
5. Security: no anonymous remote playback, arbitrary scripts/URLs/OS actions, shared dev bearer tokens on public ingress, untrusted search result acting as tool instruction or secrets/private media history in **public** GitHub.
6. Preserve stream transports, Cloudflare Access gates, production Mac+HA services, Tesla parking restrictions and existing UI, audio and experimental JXL paths.
7. Before release: complete both-platform CI, real desktop and parked Tesla acceptance, explicit user approval, rollback plan and verified deployed revision. No auto-merge or auto-deploy.

## Copyable agent assignments

### Codex A — Phase 1
> Work only on YT Streamer AI Media Agent Phase 1 (GitHub epic #26, issues #28/#29; phase plan at webapp/docs/AI_MEDIA_AGENT_MVP_PHASES_20261021.md). After Phase 0 contract/baseline is published, inspect existing ai-media-agent-sprint1, draft PRs #33/#34 and the newest player; do not start from scratch. Create your own clean worktree/branch. Implement the browser-side selected-device search/play/pause/resume/stop/state adapter and real ACKs only. Don't edit gateway/auth, Cloudflare, src/server.js or prod. Add targeted real Chrome tests for exact device, offline/stale target and autoplay permission. Push a draft PR, report tests and stop; do not merge or deploy.

### Codex B — Phase 4
> Work only on YT Streamer AI Media Agent Phase 4 (GitHub epic #26, issues #28/#29/#32 and phase plan). Wait for Phase 1 and 2 integration commit references, inspect current tests and avoid overlapping file ownership. Build negative/reconnection/idempotency and player regression coverage for current MJPEG/WebCodecs/JXL and Classic/New UI. Use isolated fixture data and real browser tests; verify both-platform CI and report measurable results. Work on a separate branch/draft PR, do not merge or deploy.

## Phase 0 verified exit — 2026-10-21

- **Accepted baseline:** New isolated clean clone at `~/Developer/ytstreamer-ai-agent-baseline-20261021`; `main` is `a34ac3afb015691d73a416aa53abe2db9ea2611d`. Live Mac `/api/health` reports `6adcff204b37206d4f897b3f41f612a179d52c1a` (tip of `fix/jxl-wasm-seek-fps-probe-20261021`), a descendant of main.
- **New integration branch:** [`integration/ai-media-agent-mvp-20261021`](https://github.com/ameshalexk/yt-streamer-webapp/tree/integration/ai-media-agent-mvp-20261021) pinned directly to **live-source revision `6adcff2`**, no application code changes. Agents should create new feature branches from **this integration ref**, not from old October 8 branches or the outdated main tip.
- **Existing agent stacked source:** PR #34 `524ebff` based on PR #33 `d19d410`, forked from common ancestor `06507e5`; current production has 117 changed files while the development agent branch has 37 changed files. **Only two files were changed on both sides:** `webapp/package.json` and `webapp/public/index.html`. These are reserved for integrator-only reconciliation after independent Phase 1 and Phase 2 work; do not blindly copy entire old files.
- **Old worktree issue confirmed:** older `~/Developer/yt-streamer-ai-media-agent*` `.git` files reference deleted `/Users/amesh/Desktop/ytstreamerhabkupfin/.git/worktrees/...`; those files/worktrees were not modified or removed.
- **Command interface frozen for parallel development:** typed commands and exact device/command IDs with truthful ACK states are specified above; browser files and server security files are distinct ownership lanes. No auto deployment/merge. Phase 0 completed by read-only audit, clone, isolated Git branch and documentation only; source implementation still needs Phase 1 onward.
- **Tracking:** [draft docs PR #68](https://github.com/ameshalexk/yt-streamer-webapp/pull/68), epic #26, Obsidian canonical note, durable Mac Control project checkpoint.

**Do not promote experimental WebMCP #31 into the MVP critical path.**
