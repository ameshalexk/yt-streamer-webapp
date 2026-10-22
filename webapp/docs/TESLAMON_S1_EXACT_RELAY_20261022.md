# TeslaMon S1 — exact-selected-tab relay integration seam

Date: 2026-10-22. **Isolated feature implementation, not connected to production or live browsers.**

## Context

- Epic [TeslaMon #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26).
- Base: `feature/teslamon-s1-candidates-20261022` at `b0263be`; that branch stacks on S1 MCP draft PR #79 and S0 PR #77. Independently authored capture PR #78 and candidate-registry branch `feature/teslamon-candidate-registry-20261022` were discovered and left untouched.
- New worktree: `~/Developer/ytstreamer-teslamon-s1-exact-relay-20261022`, branch `feature/teslamon-s1-exact-relay-20261022`.
- Exclusive new files: `webapp/src/lib/teslamon-selected-relay.js`, `webapp/test/teslamon-selected-relay.test.mjs`, and this document.
- No modifications to the existing `ai-media-agent-production-relay.js`, `ai-media-agent-session-registry.js`, browser adapters, Cloudflare Access configuration, YT Streamer service or media transports.

## Implemented and verified in isolated fixtures

`createTeslaMonSelectedRelay({registry,readSelection,readController,readBrowser,now,principal:'owner'})` provides a private two-method adapter:
- `getAuthority()` produces a bounded **server-derived** owner/controller/tab binding (Mac origin, signed subject, controller ID, tab key, connection ID, site auth expiry) or `null`.
- `dispatch(command,{signal})` sends a validated player action **only to the explicitly selected, live registry device** and returns the actual registry ACK, bounded player state or a safe failure/uncertain outcome.

Three separate injected trustworthy sources must agree:
1. `readController()`: verified Cloudflare Access HTTP controller identity. Must not accept model-supplied headers/subjects as trusted without signature verification.
2. `readBrowser(deviceId)`: the already-ticket-verified WebSocket client record, with exact subject, browser key, generation and consent.
3. `readSelection()`: explicit owner/device selection record. Never infer a target from the only online browser.

The existing `AgentSessionRegistry.connectionFor('owner',deviceId)` must match the same connection generation. The legacy direct-controls path uses `chosen()` and can select a sole eligible browser or queue a disconnected `resume` for 120 seconds. **TeslaMon never calls `chosen()`, `directControls`, or the reconnect resume queue.** It uses registry dispatch with the exact known device ID, checked command ID and generation. No public route or listener has been added.

Allowed underlying player actions in this layer: `search_media`, `play_media`, `pause`, `resume`, `get_player_state`. `request_fullscreen` and `exit_fullscreen` remain explicitly unsupported until TM-401 updates each relay/player layer. All other actions, arbitrary media URLs, or unknown/extra arguments are rejected.

Every dispatch checks identity before sending and again after response; a selection change, Access expiry, reconnect or cancellation after sending returns **uncertain**, not a fabricated rollback. Registry duplicate/timeout responses remain uncertain, without blind replay. The raw registry state excludes original browser `observed_at`, so the adapter stamps *registry ACK receipt time* on a returned state; this is an ACK-based snapshot, not proof of actual speaker output or first-rendered frame.

Source readers that throw, disappear or disagree fail closed; a registry dispatch error is uncertain, not a definitive “did not play”. The adapter is deliberately injected rather than exposed on a public endpoint.

## Tests

From `webapp/`:
- `node --test test/teslamon-contract.test.mjs test/teslamon-private-mcp.test.mjs test/teslamon-candidates.test.mjs test/teslamon-selected-relay.test.mjs`: **48/48 passed** (14 new exact-relay tests, 34 prior).
- `npm run check`: passed (syntax checks).
- `git diff --check`: passed.
- New tests instantiate the **actual existing `AgentSessionRegistry` module**, register two in-memory browser sessions, verify exact selected destination A/B, no sole-tab fallback, signed-controller and browser identity mismatch rejection, candidate invalidation after reconnect, stale selection after dispatch, no background resume queue, duplicate command IDs, player ACK receipt, timeout uncertainty, and failing external readers.
- Test peers are synthetic in-memory send/ACK functions, **not authenticated live WebSocket clients**. No full application regression tests, actual browser, physical iPhone, parked Tesla, real voice/STT, real Codex model/tool confinement, or both-platform CI are claimed.

## Remaining before TM-101 real-site completion

The existing production relay internally has `clients` (verified WebSocket connections), `selected` (explicit key/subject), and `registry`, but **does not currently expose the three above trustworthy callback providers** as a stable service boundary. An integrator must implement that internal seam in one exclusive shared-file lane, preserving legacy controls and pairing flow, with formal source review and tests against the signed Access route. It must not add a second Cloudflare login or expose anonymous playback.

A current signed controller identity does not prove that the paired browser is the intended tab by itself; use all three sources and guard against tab/generation changes between lookup and dispatch. The model must never choose target or owner. Any failed freshness check blocks new dispatch, and post-send uncertainty must not replay.

Then: attach `createTeslaMonCandidateService` to the private MCP command router, implement cross-layer idempotency/cancellation (TM-104), test real browser+decoy, close TM-003 Codex confinement and TM-002 chosen mic/STT topology, integrate separate PR #78 capture only after ownership review, add fullscreen and mobile controls, require shared macOS/Linux amd64/arm64 packaging CI, and get actual owner-assisted iPhone/Tesla acceptance.

This commit is safe to roll back by removing/reverting this isolated branch; no runtime state or deployed service changed. Do **not** mark production integration or deployment complete.
