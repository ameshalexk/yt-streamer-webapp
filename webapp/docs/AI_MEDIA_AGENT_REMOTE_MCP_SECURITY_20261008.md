# Secure remote MCP candidate — 2026-10-08

Status: ISOLATED DEVELOPMENT ONLY. NOT deployed or publicly routed. Production 06507e5 preserved.

## Implemented
- scripts/ai-agent-remote-mcp.mjs: an independent 127.0.0.1 HTTP listener (POST /remote/mcp) separate from the development bearer-token relay. No /dev/* forwarding.
- Fail-closed RS256 Access JWT verification on every request: pinned issuer, audience, trusted JWKS HTTPS team domain, signature, timestamps and exact subject allowlist. Strict method, Origin, payload, argument and endpoint checks.
- Identity/device/connection/action-scoped grants after a request has been shown to the exact locally paired browser tab. Local browser shows requested actions and requires an actual trusted click. Claim returns a grant only to the requesting identity; invalid action, identity, wrong device, stale connection and revoked/expired grants are denied.
- 60 requests/min per subject; UUID replay nonce for tools/call; five-minute duplicate request rejection, bounded replay storage. No replay of uncertain mutations.
- Stateless MCP 2025-11-25 initialize/list/call and initialized notification over JSON response. Real headless Chrome consent click and authenticated MCP readback were exercised.

## Verification
- Four gateway integration scenarios cover JWT signatures/issuer/audience/expiry, pinned JWKS/cache/error, origin and allowlists, browser approval, identity scoping, replay, revoke and disconnect.
- Real Chrome in existing browser acceptance test displayed the remote authorization prompt and accepted an actual Playwright click; subsequent MCP get_player_state succeeded.
- npm run check PASS; npm test 310/310 PASS. No live Cloudflare assertions, official third-party SDK, iPhone ChatGPT Voice or Tesla were tested in this work unit.

## Remaining gates / risks
1. Approval-required Cloudflare Access TLS ingress and a real Access JWT/JWKS validation, with ingress only to this separate remote port. Never expose the development relay bearer tokens or its endpoints.
2. Replace existing development pairing proof with a real browser trust and identity flow before production. A trusted DOM click is not a cryptographic proof of a human if the already-paired page is compromised.
3. Verify official independent MCP SDK and 2026-07-28 protocol compatibility; current candidate targets 2025-11-25 only.
4. Verify the caller: Plus iPhone Voice custom write MCP is not established and public full custom-MCP write beta is for Business/Enterprise/Edu. Evaluate the existing OpenClaw/Jarvis front end when appropriate.
5. Test real token rotation, racing approvals, backpressure, browser background and long playback; physical parked Tesla/iPhone/speaker steps remain pending.
6. No production deployment, restart, merge, Cloudflare, live launchd, original dirty checkout or UI #24/PR #25 changes. Preserve the existing media engine and /money.
