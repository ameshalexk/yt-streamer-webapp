# YT Streamer AI Agent — Phase 2 Secure MCP Gateway (2026-10-21)

**Parent:** issue #26, security story #30.
**Branch:** `feature/ytstreamer-ai-agent-phase2-auth-20261021` from `integration/ai-media-agent-mvp-20261021` at current Mac deployment `6adcff204b37206d4f897b3f41f612a179d52c1a`.

## Implemented on an isolated development branch

This branch selectively carries forward the tested October 11 secure-MCP backend primitives instead of rebuilding them:
- `src/lib/ai-media-agent-remote-authorization.js`: verifies Cloudflare Access RS256 JWT signature and pinned issuer/audience/subject/expiration; short-lived, exact principal/device/connection/action approval grants, new maximum 128 live grants and pruning.
- `src/lib/ai-media-agent-trusted-browser-flow.js`: verifies Access JWT/header and/or signed HttpOnly browser cookie on exact-origin WebSocket upgrade, server-issued device and connection identities, bound registration scopes. Added **unknown-kid-only** pinned-JWKS refresh once per 30 seconds; malformed/expired/forged signatures cannot force refresh.
- `src/lib/ai-media-agent-browser-registration.js`: one-use browser registration nonce, exact identity/connection/origin/action scope and revoke on disconnect.
- `src/lib/ai-media-agent-session-registry.js`: explicit selected-tab command registry, exact ACK/state readback, timeout uncertainty, replay/connection safety, input bounds and rate limits.
- `scripts/ai-agent-remote-mcp.mjs`: isolated, loopback-only MCP Streamable HTTP JSON listener, pinned JWKS retrieval and JWT verification, schema-checked tools, session IDs or per-call nonce, explicit browser approval/claim/revoke, per-device/action gate. **Not mounted in production.**
- `scripts/ai-agent-trusted-access-relay.mjs`: isolated loopback-only browser WebSocket path with signed Access authentication before upgrade, server-generated identity/registration, bounded connections and revoked grants on disconnect.
- `scripts/ai-agent-dev-mcp.mjs` and `scripts/ai-agent-local-relay.mjs`: historical **loopback test fixtures only**. Do not forward `/dev/*` or use development bearer secrets as public authentication.

## Phase 2 security follow-up — 2026-10-21

- The remote MCP browser approval tool no longer hardcodes the historical nine-action maximum. The allowed action schema is derived from the exact typed command list, including the newly registered `stop` action; a valid full-scope request is accepted while unknown actions still fail validation.
- Tool results with `status: unauthorized/offline/failed/timeout_uncertain/rate_limited/unsupported/needs_user_gesture/not_found` now set the MCP standard `isError: true` while **retaining structured state**, so a model does not misinterpret an unsuccessful action as confirmed playback. `pending_browser_approval` and `accepted` remain distinct non-terminal states; **`accepted` does not mean audible playback**.
- New tests prove a full allowlisted approval request including `stop` is accepted but not automatically granted, unknown scope is rejected, unauthorized action has `isError: true`, and confirmed browser ACK remains `isError: false`.
- CI for base Phase 2 PR #69 commit `9a15d17`: Shared release workflow 39709929932 **SUCCESS**, verified after initial submission. Follow-up commit's CI must be checked independently.


**MVP alignment:** Added `stop` to the shared allowed command name list in the registry, approval scopes, browser registration, MCP tool list and trusted relay. Phase 1 browser agent must implement the matching `stop` adapter; no assumption that playback stops until the browser confirms.

## Boundaries and integration contract

1. **Default posture = OFF.** No import or mount from `webapp/src/server.js`, no Cloudflare DNS/Tunnel/Access changes, no Mac/HA production restart, no secrets in source or test fixtures. Loopback listeners reject any non-`127.0.0.1` binding.
2. **Remote MCP authentication:** Mandatory verified provider-signed Cloudflare Access JWT assertion, pinned configured team domain and audience, exact subject allowlist. Caller may be server-side, not arbitrary browser JavaScript. The TLS/Access perimeter must be independently configured/verified before any ingress exposure.
3. **Browser authentication:** A real signed Access cookie/header, exact allowed Origin, verified WS upgrade, server-generated device/connection identity. Client-supplied IDs/roles are not trusted.
4. **Playback authorization:** `request_browser_approval` -> tab local consent -> `claim_browser_approval` -> permitted command with `approval_id`; command must match the **exact same active** target connection and action scope. Grants expire or revoke on disconnect.
5. **Typed tools:** `list_devices`, `request_browser_approval`, `claim_browser_approval`, `revoke_browser_approval`, `get_player_state`, `search_media`, `play_media`, `pause`, `resume`, `stop`, `next`, `seek`, `set_volume`, `request_fullscreen`. Tools use bounded fields, no arbitrary shell/system/URL calls.
6. **Responses:** `accepted` means dispatched, not playing; only actual tab ACK/state can support success. Offline, expired, unsupported, buffering, needs_user_gesture and timeout_uncertain remain distinct. Tesla must be in Park for physical video testing.
7. **Agent handoff:** Codex Phase 1 may touch browser/UI adapter only. **Do not import** the legacy dev relay into the public-facing player; use this Phase 2 trusted WS message protocol and only after approved authenticated ingress. Reserved integrator-only files: `public/index.html`, `package.json`, `src/server.js`.
8. **Security review still required:** An incoming WS `approve_remote_request` frame is **not cryptographic proof of a human click**; browser UI must verify local trusted user gesture and protect against XSS/CSP bypass before an actual Cloudflare connection is made available. Access JWT cookies and the browser upgrade flow need live TLS integration/issuer-JWKS rotation verification. ChatGPT text write-tool connection and Voice availability are Phase 3 feasibility gates.

## Test expectations

Run from `webapp/` with dependencies installed:
- `npm run check`
- `npm test`
- `node --check scripts/ai-agent-remote-mcp.mjs && node --check scripts/ai-agent-trusted-access-relay.mjs`
- targeted `node --test test/ai-media-agent-*.test.mjs` where shell expansion includes only security tests; run tests on actual target OS, not the car.
- New dedicated `test/ai-media-agent-phase2-hardening.test.mjs` covers pinned JWKS rollover vs signature forgeries, bounded live approvals, stop whitelist and refusal to bind a public listener.

**Phase 2 ready** means isolated MCP security implementation and negative unit/integration tests pass, not that a remote ChatGPT caller can control production yet. That requires Phase 1 UI integration, Phase 3 live client validation and Phase 5 user-approved parked Tesla release.
