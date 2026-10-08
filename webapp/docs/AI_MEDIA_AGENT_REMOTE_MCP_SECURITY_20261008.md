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

## Checkpoint #8 update — interoperable sessions and isolated registration
**Status:** TESTED ONLY ON THE ISOLATED LOOPBACK DEVELOPMENT GATEWAY; NO live Access/JWT, browser auth integration, Cloudflare routing or production changes.

- Remote `initialize` now returns a cryptographically random `Mcp-Session-Id` header, bounded to the verified Access JWT issuer+subject and a 15-minute maximum lifetime, 128 concurrent sessions. Standard MCP Streamable HTTP clients echo that header and need **no custom fetch/nonce adapter**. Each `tools/call` JSON-RPC request ID is recorded before dispatch (max 2,048/session); duplicated IDs get HTTP 409. A missing/invalid session is denied. Legacy stateless callers retain the existing X-AI-Request-Id UUID replay protection.
- JWT/JWKS verifier now refreshes a pinned, trusted JWKS only on previously unseen key IDs with a 30-second throttle; verified issuer/audience/signature/subject/expiry remain mandatory. Invalid tokens, unknown keys, expired/wrong-audience JWTs and refresh flooding fail closed. Only **synthetic** key rotation was tested. Actual public Cloudflare team JWKS anonymously served two RSA keys; no real MCP Access app or JWT was used.
- New `AuthenticatedBrowserRegistrationRegistry` is an internal-only server-side primitive, **not wired to production or exposed as an endpoint**. It requires a previously verified browser identity, server-generated device+connection IDs and exact allowlisted origin; grants single-use 60-second registration nonces and action-scoped 10-minute registrations. It rejects wrong identity/device/connection/origin, replay, stale registration, and invalid tools; supports revocation and reconnect invalidation. It **cannot** replace genuine Access-session verification, XSS defenses, real TLS ingress or a user gesture.
- Official MCP SDK TypeScript v2 auto->legacy handshake, tool approval and readback now work with its normal StreamableHTTPClientTransport, **without** any nonce-injecting custom fetch. Modern-only 2026-07-28 remains unsupported.
- Tests on local worktree: `npm run check` PASS; `npm test` **315/315 PASS**; independent `node --test scripts/ai-agent-official-sdk-probe.test.mjs` **1/1 PASS**. This is local Mac proof; fresh GitHub CI result is pending push.
- Existing OpenClaw 2026.9.8 Telegram currently reports running/connected and no error after earlier failure, without configuration changes. `openclaw mcp list --json` remains `{}`, no YT Streamer voice path tested. No ChatGPT Voice tool invocation or parked Tesla acceptance tested.
- Release blockers: authenticate browser session at trusted ingress, enforce connection-scoped registration in real WebSocket handler (never trust browser-provided principal), verify signed live Cloudflare Access token with dedicated OAuth app and audience, validate CSP/XSS/CSRF and end-to-end device approval, register restricted tool with OpenClaw in a separate permitted staging configuration, then physical iPhone/Tesla test in Park. No changes to production `06507e5`, live launchd, DNS, /money, routes or UI PR #25.
