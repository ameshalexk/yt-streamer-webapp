# TeslaMon — selected-target search and candidate service (S1)

Date: 2026-10-22. Status: **isolated, mock-only candidate/search vertical slice. Not installed or deployed.**

## Identity, base and ownership

- Project: TeslaMon, the movable YT Streamer playback assistant, not Tesla Fleet/vehicle control.
- [Epic #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26).
- New branch: `feature/teslamon-s1-candidates-20261022` from `feature/teslamon-s1-private-mcp-20261022`, commit `a769017`, which itself stacks on S0 draft PR #77. No changes to `main`.
- Exclusive files: `webapp/src/lib/teslamon-candidates.js`, `webapp/test/teslamon-candidates.test.mjs`, and this document. No edits to `server.js`, existing relay/player/auth/Cloudflare, other agent-owned capture lane or production.
- Existing separate [capture PR #78](https://github.com/ameshalexk/yt-streamer-webapp/pull/78) is not merged or integrated into this branch. Do not double-count its isolated code as live voice functionality.

## What this code does

`createTeslaMonCandidateService({getAuthority,dispatch,clock,makeToken,makeId})` is an unmounted **pure orchestration boundary** against a synthetic adapter today. It requires independently obtained authenticated/selected-tab authority; no model/prompt input can select a device, owner or connection. The actual app integration must read `getAuthority` exclusively from the verified site session and selected-tab registry, and must implement `dispatch` so it routes **only** to the matching connection generation. Never use the old production relay's sole-online-tab fallback or reconnect resume queue for TeslaMon.

1. `searchAndPlay({tool:'search_and_play',args:{query}})` accepts a bounded query. On new search it invalidates all earlier candidates, even if search later fails.
2. Calls only the existing relay action `search_media` (limit <=10). Search results are filtered to existing 11-character YouTube media IDs, bounded display metadata, deduplicated IDs, and never accept arbitrary media URLs as play targets.
3. One valid result can proceed to play. Multiple candidates return `needs_selection` with opaque cryptographically random, 45-second tokens; never blindly auto-play an ambiguous first result. Token generation must succeed atomically.
4. `searchAndPlay({tool:'search_and_play',args:{candidate_token}})` consumes the token exactly once, bound to owner, controller, device key, *specific connection generation*, existing opt-in, Mac origin and unexpired auth. A new search, invalidate, expired token, wrong target, owner or reconnect blocks it.
5. Before every dispatch and after every acknowledgement, re-fetches server-side authority. Each request carries a UUID command ID, authority snapshot and deadline. This boundary rejects changed target after dispatch as uncertain rather than assuming success.
6. After `play_media` ACK, calls `get_player_state` for the exact selected target. Only a recent, matching media ID with `playing` reports `observed`. `buffering`, `paused` and `needs_user_gesture` report accepted/not observed. Stale/wrong media/connection/command IDs remain uncertain. **No actual speaker-output proof is claimed.**
7. One coordinator call at a time; other calls return `target_busy`. This does not yet constitute a cross-process or cross-restart dedup ledger.

## Tests and evidence

From `webapp/`:
- `node --test test/teslamon-contract.test.mjs test/teslamon-private-mcp.test.mjs test/teslamon-candidates.test.mjs` — **34/34 passed**, including **17 candidate tests**.
- `npm run check` — **passed**.
- Tests cover unique/ambiguous selection, one-time tokens, TTL/revoke, attempted reuse after failed search, tab/owner/controller/generation switches, same-target ACK ID verification, stale media/time readback, partial failure, lack of implicit tab fallback, token generator collision, malicious tool args, overlong query, and busy mutations.
- **All candidate and playback tests use synthetic private relay replies.** Prior MCP suite includes an actual local child-process stdio exchange against a synthetic player. **No authenticated browser or live YouTube/video/audio player was contacted in this branch.**

## Integration blockers: do not mark live TM-103 complete

- Existing browser adapter stores search results per-tab and currently has no dedicated TeslaMon namespace. Other in-tab searches can invalidate its map; a play error must not be retried against a different result or guessed URL.
- A production adapter must translate actual registry snake_case ACKs into this candidate interface, strictly verify command ID/target/connection and signed identity, and attach a trusted player state. Existing relay does not yet expose the necessary privileged TeslaMon-only direct route.
- Server candidate tokens are in-memory and ephemeral. No persisted result history and no background retry. Real user ambiguity clarification will be handled by the later Codex/UI coordinator.
- Timeout after dispatch and cancellation require a cross-layer bounded ledger/abort/expiry (TM-104). Do not replay a request on reconnect or let a timeout race start another mutation.
- The S1 private MCP method currently accepts an injected `dispatch`; **this candidate service is not yet wired into that method or a real Codex agent**, and cannot be used on production.
- Mic/STT choice, Codex tool confinement, Cloudflare authentication/HA routing, fullscreen, mobile real-device and both-platform CI all remain separate gates.
- No merge, deployment or runtime change. Rollback: drop this isolated feature branch or revert its commit; existing app remains untouched.

## Story accounting

- TM-001 baseline, TM-004 contract and TM-102 isolated stdio MCP fixture: prior accepted groundwork.
- **TM-103 isolated candidate/search/readback fixture completed**, **but full browser/relay end-to-end acceptance remains pending**. This is additional source/test progress, not a functioning MVP.
- TM-101 actual existing relay integration, TM-104 robust cancellation/dedup, TM-002 mic/STT and TM-003 runtime confinement still pending.
