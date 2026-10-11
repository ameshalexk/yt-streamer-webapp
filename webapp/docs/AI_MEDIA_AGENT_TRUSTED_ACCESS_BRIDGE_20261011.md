# YT Streamer secure Access browser relay — 2026-10-11

Branch: feat/ai-agent-trusted-access-bridge-20261011, stacked on PR #33 commit d19d410. Development-only. Not imported into the production server.

## Implemented

- Loopback-only scripts/ai-agent-trusted-access-relay.mjs exposes /trusted/player as a WebSocket upgrade path, not an HTTP command API.
- Prior to WS acceptance it calls TrustedBrowserRegistrationFlow.connect(req), verifying issuer-pinned signed Access RS256 JWT, distinct app audience, allowlisted subject and exact browser Origin. Header and cookie mismatch fails closed.
- Server issues and redeems one-use registration; the actual AgentSessionRegistry pairing proof is an opaque server-only object. A browser cannot select its own principal, device ID or connection ID.
- Reuses the existing remote MCP browser-approval flow with scoped actions and ACK readback. On disconnect it revokes browser registration and pending/active consent grants.
- Token expiry is checked on heartbeats and command dispatch; an expired WS closes with status 1008.
- A strictly opt-in localhost-only test browser script, public/ai-media-agent-trusted-dev.js, uses HttpOnly cookies without reading tokens, and dispatches through the existing player adapter. No production HTML import.

## Verification

- Negative tests: forged/wrong-origin/wrong-subject/wrong-audience tokens, mismatched assertion and cookie, anonymous HTTP requests.
- Positive: signed WS -> registered device -> signed MCP request -> explicit approval -> bounded pause/observed state ACK -> revocation after disconnect.
- Real local Chrome with simulated signed HttpOnly cookie connected; JS could not read token. A real Chrome click granted scoped pause and readback; unapproved next was rejected.
- npm run check PASS, npm test 325/325 PASS, independent official MCP SDK probe 1/1 PASS.
- PR #33 previous macOS run failed with 320 pass and 1 Chrome test cancelled after a 45-second timeout. The test had completed assertions in runner logs; this branch raises that test timeout budget to 120 seconds.

## Security and release boundary

This is not production authentication. Tests use synthetic signed keys, not a real Cloudflare Access browser login/app audience or TLS ingress. There is no public route, no Cloudflare/Tunnel/DNS change and no Access application change. A WS approval message cannot itself cryptographically prove a real browser gesture; strict CSP/XSS protection, cookie/origin security review, production ingress authentication, revocation and physical device acceptance are still required.

Preserve production Mac and HAOS streaming services, /money, UI v3 PR #25, MJPEG, WebCodecs, audio, saved files and credentials. No merge, restart, deploy or live Tesla/iPhone tests were performed. Follow shared-platform CI and obtain explicit approval before ingress or deployment.
