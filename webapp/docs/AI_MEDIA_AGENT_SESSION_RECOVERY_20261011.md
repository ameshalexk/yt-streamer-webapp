# AI Media Agent: stale session and pairing recovery (2026-10-11)

Development-only reliability patch for issues #28 and #30, derived from
`ai-media-agent-sprint1` at `31e40dd`. No production or media transport changes.

## Behavior
- Opening a WebSocket is not a successful pairing; retry backoff resets only after a server `registered` response.
- A WebSocket policy/auth close (1008) is terminal. The UI stops automatic attempts and requires the user to enter a valid pairing proof again.
- A tab that resumes after the server registry TTL expires receives a 1012 `session_expired` close on its next heartbeat. It automatically reconnects using its still-in-memory development pairing proof and receives a new device identity.
- On `visibilitychange` back to visible, the tab sends an immediate heartbeat to detect lost background state rather than waiting for throttled timers.
- `pagehide` explicitly disconnects and clears the pairing proof; if the document is restored, the user must pair again. Late close events cannot overwrite this UI state.

## Local verification
- `node --test test/ai-media-agent-relay.test.mjs test/ai-media-agent-browser.test.mjs`: focused real WS and Chrome cases, including invalid proof (one connection only), manual recovery, stale registry heartbeat, and existing selected-tab reconnect path.
- `npm run check && npm test`: PASS, 321/321 Node tests including real local Chrome integration.
- These tests simulate a background tab and validate local sockets only. They do not establish actual iPhone, Tesla firmware, real Access login, public TLS ingress, or voice-client compatibility.

## Release boundary
- Keep this branch isolated; it is neither merged nor deployed.
- Cloudflare, HAOS/Mac production services, UI v3 PR #25, MJPEG and WebCodecs unaffected.
- Before deployment: parent AI media-agent branch integration review, both-platform CI, real authenticated session and parked Tesla/iPhone acceptance, explicit owner approval and rollback.
