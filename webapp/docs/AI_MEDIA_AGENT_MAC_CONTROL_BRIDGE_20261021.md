# YT Streamer AI Media Agent — Mac Control MCP Bridge

**Development checkpoint:** 2026-10-21. Integrated into draft Phase 3 PR #71 only. **Not deployed or connected to the physical Tesla.**

## Why this bridge exists

The existing, already connected Mac Control MCP offers permissioned `terminal_run` and `file_write` on the user's Mac mini. A custom third-party YT Streamer MCP write integration may not be available on the user's ChatGPT Plus workspace. The local bridge is an alternative **transport**, not a way to bypass remote browser permission:

`ChatGPT → connected Mac Control MCP → node scripts/ai-agent-mac-control-cli.mjs → private Unix socket → Mac bridge → authenticated browser relay → explicitly approved browser tab → actual YT Streamer player`.

The Mac Control tool runs the local CLI with typed action and JSON arguments. **No second ChatGPT plugin install is needed for this local tool path**, although operating the browser still requires an independently authenticated signed browser connection. All operations are reported from actual browser ACK or state readback, never invented.

## Files

- `src/lib/ai-media-agent-mac-control-bridge.js` — dependency-injected local-only Unix-socket server that requires a **pre-created, owner-only directory (0700)**, creates a **0600 socket**, never opens TCP, and runs in the **same process** as an already authenticated trusted browser relay. It uses the existing `BrowserApprovalRegistry` and selected browser's exact `connectionId` to request/claim/revoke short-lived scopes and dispatch commands.
- `scripts/ai-agent-mac-control-cli.mjs` — small subprocess client for Mac Control. It requires explicit `--socket`, `--action` and `--args`; validates socket type, owner and mode; emits machine-readable JSON; exits nonzero on failed/offline/unauthorized/uncertain commands. No shell execution, arbitrary URL access, bearer token injection or JWT parsing.
- `test/ai-media-agent-mac-control-bridge.test.mjs` — rejected public/shared directories, rejected socket reuse, typed argument enforcement, unapproved action denial, duplicate-request defense, exact selected-device scope, browser approval, claim, search with ACK, revoke, disconnect.
- `scripts/ai-agent-mac-control-real-player-check.mjs` — actual **Chrome** with ephemeral signed Access **test key**, temporary local YT Streamer server, private socket bridge and independent **Node CLI subprocess** calls. Uses local JPEG and MP3 fixtures to test real player state and rendered frames. No Cloudflare/Tesla production changes.

## Verified Mac Control call format

This is an example of a command the existing Mac Control MCP `terminal_run` can execute **only while a properly authorized local bridge process is running**. The socket path must be supplied by the locally running bridge; this example path is not an installed service:

```sh
node scripts/ai-agent-mac-control-cli.mjs \
  --socket "/path/to/private-owner-only/bridge.sock" \
  --action list_devices \
  --args '{}'
```

The actual workflow is: `list_devices` → select the **exact device ID** → `request_browser_approval` with the desired bounded actions → the selected user/browser manually clicks **Allow these actions** → `claim_browser_approval` to obtain a short-lived grant → `search_media` → `play_media` → `get_player_state` until playback is observed. `pause`, `resume`, `stop` and `revoke_browser_approval` use the same grant and device identity. Permission is revoked on disconnect and expires automatically.

The development bridge accepts only `list_devices`, `request_browser_approval`, `claim_browser_approval`, `revoke_browser_approval`, `get_player_state`, `search_media`, `play_media`, `pause`, `resume`, and `stop`. Arguments are typed; media IDs must match an 11-character YouTube video ID. No Mac OS commands, arbitrary video URLs, code execution, automatic approval or cross-tab fallback.

## Trust boundaries and limitations

1. **Local OS user boundary:** Unix socket owner-only path and mode prevent other OS users from accessing it. Programs running as **the same Mac account can reach it**; they cannot issue playback until the owner explicitly grants that selected browser permission. This is not a defense against compromised same-user programs or a substitute for workstation security.
2. **Remote browser boundary:** Actual browser login still requires independently signed Cloudflare Access cookie, verified server-side with pinned Access JWKS/issuer/audience/subject/origin. Local bridge requests identify the subject as `Mac Control (local)`. No Cloudflare JWT needs to be supplied to the Mac Control CLI.
3. **Permission boundary:** Browser must click an exact on-tab request for the exact scope, tracked by the server's existing approval registry. App XSS could compromise browser behavior; current trusted click checks alone do not prove physical human presence.
4. **Transport boundary:** **Never forward the private socket or bearer-only `/dev/*` endpoints over a Cloudflare tunnel.** The trusted browser WS is still a separate local-development listener; exposing it needs explicit TLS/Access ingress and CSP/CSRF review.
5. **Lifecycle:** The local bridge library is loaded **only by an opt-in caller/test harness**; this PR does **not** start a permanent daemon, set up launchd, modify the production app, connect a real Tesla browser, or supply an active socket. Mac Control can call the CLI once a reviewed service is explicitly started, but cannot control an offline browser.
6. **Playback evidence:** The real Chrome test verifies rendered video frames increased after resume and an MP3 media request was received. It does not establish physical speaker audio, Tesla browsing compatibility, or that ChatGPT has used a native YT Streamer custom MCP plugin.

## Test commands (run in isolated webapp worktree)

```sh
npm run check
npm test
npm run test:ai-agent-mac-control-browser
```

The latest locally verified baseline here: `npm test` **480 passed, zero failed**; Chrome 155 private Mac Control CLI → signed WS → manual browser approval → real buffered MJPEG video rendering, pause, resume, stop, audio-fixture request, unselected decoy idle and authorization revocation **PASS**.

## Before user-approved launch

- Add a reviewed **real Access/TLS WebSocket ingress** and a browser-side secure pairing flow that can operate on the Tesla site (the development browser UI currently requires localhost and an entered local port).
- Confirm per-tab consent and CSP/XSS/CSRF restrictions under real browser conditions, with a short-lived grant and no implicit approval.
- Decide an OS-user-isolated service start/stop and secretless configuration plan, and test recovered state and disconnects.
- Use the already-connected Mac Control tool to invoke CLI only when a real approved browser is registered, then perform **parked Tesla** audio/video acceptance and rollback tests before any production deployment.
- Keep integration **draft** and preserve current live revision until explicit owner approval.
