# Sprint 2 #30 — independent MCP SDK, Cloudflare Access, browser pairing, voice fallback
Date: 2026-10-08. **Development research/test artifact only. No deployment or routing change.**

## Reference state
- Repository: ameshalexk/yt-streamer-webapp; branch: ai-media-agent-sprint1.
- Starting checkpoint #5 commit: c82a45cdae3ead0566fa88d259b077927623faef.
- Documented live production revision: 06507e5; this run cannot independently verify Mac production because Mac Control tunnel did not poll.
- Current candidate: scripts/ai-agent-remote-mcp.mjs on 127.0.0.1 only, requiring verified Access-style JWT, subject allowlist, browser short grant, nonce, replay/rate limits and exact device identity.
- Original dirty checkout, UI #24/PR #25, production launchd, Cloudflare DNS/Tunnel/Access configuration: OUT OF SCOPE.

## Official MCP SDK compatibility
- Official TypeScript SDK v2 uses package @modelcontextprotocol/client. Legacy (2025-11-25) handshake is initialize; modern (2026-07-28) uses server/discover and request _meta. Default v2 Client still supports legacy; mode:auto probes modern, then falls back; modern-only pinned clients MUST fail against the current gateway.
- Test added: scripts/ai-agent-official-sdk-probe.test.mjs (not in normal npm test glob). Uses official SDK v2 over its StreamableHTTPClientTransport, with synthetic RS256 Access JWT and a local WebSocket paired browser. Checks auto legacy fallback, listTools, list_devices, browser approval/claim, get_player_state readback, wrong identity rejection, and modern-only pin rejection.
- The candidate requires a unique X-AI-Request-Id UUID header on each tools/call. The test deliberately adds this through the SDK transport's custom fetch. **Generic MCP clients without a request-header adapter may fail**. Resolve with an interoperable per-tool-request idempotency design before release. Never remove replay defenses merely to achieve compatibility.
- Test infrastructure: .github/workflows/ai-media-agent-sdk-probe.yml runs npm ci, transient SDK v2 install without lockfile change, npm run check, full npm test, then the independent SDK test on ephemeral loopback only.
- During the first CI attempt, npm run check passed but 6/310 Node tests were cancelled due to unreferenced pending-command timeout; the development session registry timeout now stays referenced until it resolves. Subsequent CI verification must be recorded from the actual Actions run, not assumed here.

SDK references:
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
- https://ts.sdk.modelcontextprotocol.io/v2/clients/connect
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2

## Cloudflare Access: research, not a live authentication proof
1. Recommended for an *externally connected interactive user agent*: dedicated Cloudflare Access MCP server application + Managed OAuth (client must support OAuth resource indicator / RFC 8707) with strict owner access policy. Clients receive an opaque OAuth token; Cloudflare forwards a signed Cf-Access-Jwt-Assertion to the origin. Origin must validate signature, iss, aud, exp/nbf and identity allowlist for every MCP request. Do not trust a cookie/header without JWT signature verification.
2. Keep the MCP listener bound to loopback and independent of /dev/mcp or /dev/player; TLS termination, app routing and Access enforcement require explicit approval and a limited ingress review. Never open the development bearer relay to Cloudflare.
3. JWKS: fetch https://TEAM.cloudflareaccess.com/cdn-cgi/access/certs, select keys by kid, refresh on new kid/rotation, fail closed and test multi-key overlap/outage/rotation. Cloudflare rotates signing keys and retains a previous key for overlap. Do not embed a static public cert.
4. Cloudflare service-token JWTs can have an empty sub. The current exact-subject allowlist is designed for identity logins and is not a drop-in service-token authentication path. If machine auth is required, design a *separate* explicit allowlist based on verified service-token claims and restricted capabilities; do not interpret an empty sub as an owner login.
5. Managed OAuth and Access are **not configured or queried live here**. Real CF authorization redirects, 401 discovery, JWT/JWKS rotation and edge-to-origin header provenance remain untested. Do not claim Cloudflare remote access works.
6. Browser client should not store raw OAuth/Access tokens in localStorage or JS. Preserve existing production browser origin protections and verify Access policy, websocket upgrade, cookies and parked Tesla behavior in a dedicated approved staging environment.

Cloudflare sources:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

## Production-safe browser pairing design (not implemented/deployed)
- Authenticate Tesla browser against the approved player origin/Access policy. Server verifies its principal; do not reuse an entered development pairing token or trust a claimed label/device ID.
- Establish a nonce-based, short-lived, one-time registration request tied to a real browser connection and owner identity. Separate browser-session identity from AI client identity; require both identities match policy.
- Show a clearly identified action/scope/expiry to the parked Tesla's browser; require a user gesture. Treat event.isTrusted as UI friction only, **not** cryptographic personhood or XSS defense.
- Authorize single device and exact tool names, 2-minute max grant, expire/revoke on WS disconnect or new browser connection, verify on every action and report actual browser ACK/readback. Keep command audit redacted and bounded.
- Mitigate XSS (CSP, allowlisted scripts, textContent), CSRF/Origin/Host checks, token/session fixation, tab swapping, stale-device ACK, background suspension/reconnect, concurrent approvals, rate limit abuse, and uncertain write retries. Keep test preview entirely separate from live route.

## OpenClaw/Jarvis voice front end assessment
- OpenClaw now documents native MCP client support (mcp.servers; HTTP/SSE/stdio), iOS/macOS Talk voice, and audio transcription for incoming voice messages.
- Preferred **near-term exploration**: iPhone Telegram voice note -> existing Jarvis/OpenClaw -> allowlisted MCP tools -> authorized chosen Tesla browser, with explicit playback readback. On the same Mac, a loopback MCP client avoids adding any new publicly exposed tool route; access/ownership and browser pairing still require production engineering and approval.
- Second exploration: OpenClaw native iOS Talk for lower-latency voice if the existing installation supports it. The actual Jarvis/OpenClaw process, model, MCP registry, Telegram channel, authentication and tool-policy configuration **have not been inspected** because Mac Control is unavailable. Do not infer that MCP tools or voice calls are already working.
- ChatGPT iPhone Voice connected custom write-tool availability must be proven in the actual account/device surface. Do not equate plain ChatGPT text tooling with a connected Voice session.
- Resources: https://docs.openclaw.ai/tools/mcp ; https://docs.openclaw.ai/nodes/talk ; https://docs.openclaw.ai/nodes/audio

## Next security/acceptance gates
- Get authoritative CI result for npm run check, complete 310-case regression suite and independent SDK v2 test; fix failure and rerun.
- Inspect live Mac read-only when Mac Control tunnel reconnects: production revision/service status, actual OpenClaw/Jarvis version/MCP registry, current Cloudflare Access app config **without reading secrets into issue notes**, and exact canonical Obsidian note.
- Prove real Access auth/expired tokens/rotation and browser identity-bound pairing in an approved isolated stage; negative tests first.
- Compare OpenClaw Telegram audio vs Talk, error reporting, approval UX, latency and selected browser targeting.
- Carry out parked Tesla/iPhone physical validation in Park; user approval mandatory before staging exposure, merge, production, launchd or Cloudflare changes.

## Tracking caveat
GitHub serves as the accessible durable checkpoint while Mac Control tunnel is disconnected. The canonical Obsidian note and Mac Control project_session checkpoint are **pending**; do not mark them updated until the Mac endpoint confirms a write.
