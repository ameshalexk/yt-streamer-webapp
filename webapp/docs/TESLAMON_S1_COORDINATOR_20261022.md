# TeslaMon S1 — isolated private MCP coordinator

Date: 2026-10-22. **Development-only composition, not a production integration or live browser demonstration.**

## Branch and ownership

- Epic: [TeslaMon #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26).
- Branch: `feature/teslamon-s1-coordinator-20261022`, stacked on `feature/teslamon-s1-command-ledger-20261022` / draft PR #83 (which stacks on PR #82 / #81 / #79 / #77).
- Exclusive changes: `src/lib/teslamon-coordinator.js`, `test/teslamon-coordinator.test.mjs`, changes to the existing S1 **feature-only** `teslamon-private-mcp.js`, `teslamon-command-ledger.js` and its tests, and this document.
- No changes to the site's `server.js`, `ai-media-agent-production-relay.js`, browser player, Cloudflare Access, model settings, machine services, production file paths or deployment.
- Parallel unmerged capture PR #78 and alternate candidate-registry branch `feature/teslamon-candidate-registry-20261022` remain independent. No duplicate implementation/cherry-pick.

## Composition

`createTeslaMonPrivateCoordinator({registry,readSelection,readController,readBrowser,ledger,clock,makeId})` reuses existing components in one **private, injected** execution path:

1. `createTeslaMonSelectedRelay` reads three trusted, server-only sources: signed controller identity, explicitly selected YT Streamer tab, and ticket-verified browser registration. The relay queries the existing `AgentSessionRegistry` for the exact connection generation. There is no target selection from a model, no implicit sole-tab fallback and no queued resume.
2. `createTeslaMonCandidateService` handles search and multi-candidate selection. When multiple verified YouTube results exist, private MCP returns only opaque, short-lived candidate tokens and bounded titles/creators; no arbitrary URL or model-owned media ID can play.
3. The `route` function sends `search_media` and `get_player_state` as read operations through the selected relay. It wraps mutations (`play_media`, `pause`, `resume`) with `openTeslaMonCommandLedger.run()` first: durable command ID/fingerprint reservation precedes dispatch. Existing registry `completed` is treated only as an *accepted command*, never as observed playback.
4. `executeIntent` handles six MCP tools; current `request_fullscreen` and `exit_fullscreen` explicitly return `unsupported` because the existing player relay does not have the end-to-end fullscreen actions.
5. `pause`/`resume` require another exact-target state read before reporting the corresponding observed playback phase; `search_and_play` requires selected candidate and matching media readback; `get_playback_state` returns a bounded state snapshot. **This is reported browser/registry state, not verified speaker output.**
6. Private MCP `createTeslaMonMcpHandler({executeIntent})` has a trusted internal extension for the coordinator. It validates the model-facing tool request and server-only binding before execution. It sanitizes outgoing status, phase, fullscreen mode and multi-candidate choices. Invalid result shapes and unexpected dispatch errors are treated as **uncertain**, never as verified success or definite no-op; raw private exception text is not returned. This does **not** add any new externally advertised tools or network endpoints; a model cannot invoke shell, filesystem, Mac Control, Home Assistant or Tesla Fleet through these six MCP tools.

## Cross-layer journal hardening

The prior ledger could return `uncertain` after timeout yet permit a **different command ID** on the same selected tab, even if the original browser action was still executing. That was unsafe.

Now any uncertain/disputed journal operation quarantines further new mutations until an operator reconciles the player state. This quarantine also survives journal reopen: a durable unfinished start or final uncertain result blocks new mutations. Repeats of the same UUID remain `duplicate_suppressed`; a same UUID with a changed fingerprint remains denied. Do **not** delete the active journal or stale lock automatically. No automatic unquarantine/recovery procedure is supplied by this prototype, and no host-level proof of exactly-once execution on power failure is claimed.

## Tests and current limits

Run from `webapp/`:

`node --test test/teslamon-contract.test.mjs test/teslamon-private-mcp.test.mjs test/teslamon-candidates.test.mjs test/teslamon-selected-relay.test.mjs test/teslamon-command-ledger.test.mjs test/teslamon-coordinator.test.mjs`

- **76/76 tests passed**: 63 previous fixture tests, 9 new combined coordinator tests, 2 new journal quarantine/restart tests and 2 new MCP output/error validation tests.
- `npm run check` passed; `git diff --check` passed.
- Coordinator tests use *actual existing* `AgentSessionRegistry`, two synthetic connected tabs with send/ACK, private on-disk disposable temp journal, and an initialized in-process MCP handler. Existing separate fixture tests cover actual child-process stdio transport. **No actual signed website session, network WebSocket browser, audio/video stream, Mac/HA deployment, Codex model, iPhone or parked Tesla was exercised.**
- Full application regression suite and both-platform CI are not verified in this clean worktree (`node_modules` absent).

## Integration and release blockers

- The actual production relay does not yet expose independent trusted `readController`, `readSelection`, `readBrowser` callbacks. The integration owner must create those inside the existing Access-verified HTTP and ticket-authenticated WebSocket layers, prove one Cloudflare login and exact-tab selection, and preserve legacy player behavior.
- The private MCP handler and coordinator remain unmounted: no persistent Codex session or user-facing pet can call them. Model runtime tool confinement to just the six TeslaMon tools (TM-003) has **not** been demonstrated; do not run a model against a shell-capable host and call it confined.
- STT/browser microphone and Mac-to-HA secure topology (TM-002), production replay recovery, candidate-store reconciliation with the parallel branch, explicit fullscreen, responsive pet UI, and physical owner device acceptance remain pending.
- S0 and S1 feature-file units are implemented; real user-site acceptance and production deployment are **not** complete. Do not count additional fully accepted backlog stories solely for this integration fixture.
- Rollback is reverting/dropping this isolated feature branch. No production service or user data changed.
