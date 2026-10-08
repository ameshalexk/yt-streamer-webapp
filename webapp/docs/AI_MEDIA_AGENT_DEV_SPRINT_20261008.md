# AI Media Agent Sprint 1 implementation checkpoint (2026-10-08)

**Branch:** `ai-media-agent-sprint1`. **Scope:** isolated development only. No changes to running production runtime or Cloudflare. Existing UI v3 PR #25 remains separate.

## Implemented
- `scripts/ai-agent-local-relay.mjs`: strict loopback-only WebSocket + HTTP, distinct long-lived in-memory owner and pairing tokens for dev, explicit optional browser Origin, restricted CORS and pairing, per-tab short-lived UUIDs, heartbeat/expiry, command ACK/readback, timeout-uncertain, rate limiting, bounded payloads, no anonymous control.
- `public/ai-media-agent-dev.js`: browser control/pairing panel, gated behind a localhost `?ai_agent_dev=1` opt-in. User enters pairing proof and owner token locally; neither is saved to localStorage or cookies. Reconnect re-pairs and receives a fresh device ID. Controller selects an exact listed tab.
- `public/ai-media-agent-adapter.js`: thin bridge into the **existing** player: `get_player_state`, `search_media`, `play_media`, `pause`, `resume`, `next`, `seek`, `set_volume`, `request_fullscreen`. Search accepts bounded text and returns selectable YouTube IDs. No arbitrary URL or shell command. Commands that start streams/seeks return **accepted**, not a fabricated playback completion. Volume currently reports **unsupported**. Remote fullscreen returns **needs_user_gesture** and shows existing on-screen fullscreen button instead of pretending to have native user activation.
- `scripts/ai-agent-dev-mcp.mjs`: experimental authenticated **local** MCP Streamable HTTP `POST /dev/mcp` using the 2025-11-25 JSON-RPC handshake/tools list/call format. No public routing, production OAuth, Cloudflare Access or approved remote voice client.
- `public/ai-media-agent-webmcp.js`: opt-in, feature-detected same-browser tools behind `document.modelContext.registerTool`. No cross-device transport, no assumed Tesla support, no cross-origin exposure.

## Tests and evidence
- Existing 13 relay/registry tests still passed after integration; real Chrome two-tab test uses **actual current YT Streamer HTML/JS player with isolated mocked backend**, not the production service or actual video stream.
- `test/ai-media-agent-browser.test.mjs`: two actual Chrome pages; pairing, exact target selection, real player-state ACK, search, pause, unsupported volume, invalid auth, wrong target, stale session, automatic re-pair after forcibly disconnected WebSocket, and distinct ID for replacement tab.
- `test/ai-media-agent-mcp.test.mjs`: real Node HTTP JSON-RPC client with initialize, tools/list, tools/call, selected WebSocket player ACK, search-result readback, wrong target, invalid argument, invalid credentials, invalid Origin and protocol-header failure.
- On this test Chrome build, native `document.modelContext` was **not present**. Registered tool contract was tested by injecting a mocked API into actual Chrome; **not** proof that native Chrome or Tesla can invoke WebMCP.
- `npm run check` and the full Node test suite passed. Actual production / parked Tesla / physical iPhone / audio playback remain untested.

## Security and integration gates
1. Dev-only token input is not a production pairing/auth system. Separate #30 must add verified Cloudflare Access/OAuth identity, session-bound browser approval and remote MCP authorization before any public tunnel exposure. Do not just forward this relay.
2. Browser Origin is checked but host is loopback; maintain same restrictions for dev. Never commit tokens or session/media history to this public repository.
3. `accepted` means playback/seek initiated only; not confirmed decoding/audio. Need time-correlated active media state/readiness and two transport modes in #29 regression/acceptance.
4. Background Tesla WebSocket suspension, OAuth, CSRF, Chrome WebMCP flag, iPhone ChatGPT Voice to private custom write tools, browser volume and true native fullscreen have **not been validated**.
5. Physical parked-Tesla acceptance, driving restrictions and release rollback remain #32. No deployment, merge, cloud route changes, production restart or garage-door actuation without explicit user approval.

## Tracking
- Epic #26; dev browser session story #28 has a local two-real-tab proof and live ACK, but cross-device production ingress is not complete.
- #29: app adapter implemented; real stream/playback completion/mode matrix is outstanding.
- #30: dev-only MCP JSON-RPC client test; remote protected gateway and iPhone/Voice test outstanding.
- #31: feature-detected registration and mock Chrome test; native browser support and Tesla test outstanding.
- #32: physical device acceptance and rollback pending.
