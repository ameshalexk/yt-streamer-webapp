# AI Media Agent — production audit and technical feasibility (2026-10-08)

**Issue:** #27 (partial; empirical iPhone Voice-to-custom-MCP test still pending). **Baseline:** production only read, no deployment or live service restart.

## Verified production baseline
- LaunchAgent `com.ytstreamer.webapp` running Node 26 at loopback `127.0.0.1:8099`; `/api/health` reports healthy and deployed revision `06507e539becb7ed3f261d3db86f479b34bd9952`.
- Deployment markers `DEPLOYED_COMMIT` and `release.json` agree. Live `src/server.js` and `public/app.js` SHA256 match GitHub `origin/main` at inspection, **not** the dirty local checkout.
- Legacy checkout `/Users/amesh/Desktop/ytstreamerhabkupfin` has uncommitted player, UI, browser and money work. Never reset or overwrite. Separate UI modernization worktree on `feature/yt-streamer-ui-modernization` (PR #25) has independent UI assets and tests; integration must accommodate both UIs.
- Live modes include MJPEG + separate audio, buffered MJPEG, WebCodecs/Cyberdash; pause/resume take mode-specific branches (`pausePlayback`, `resumePlayback`); seek uses `streamSeek` + `replayFn`; queue advance goes through existing `advanceAutoplayQueue`; search endpoint `GET /api/youtube/search?q=&limit=` via yt-dlp. No second streaming engine.
- Fullscreen currently has `requestFullscreen`, a webkit alternative and synthetic CSS fallback; a remote request cannot guarantee native fullscreen without transient user activation. Existing playback already notices autoplay rejections. Remote agent must report `needs_user_gesture` rather than treating CSS fallback as native fullscreen success.
- Server code describes some endpoints as single-user/no-auth; existing `requireMoneyAccess` protects *money* specifically, not arbitrary new endpoints. Public `/api/` routes must not be mistaken for authenticated remote-agent capabilities.
- Production service plist contains an OAuth client secret in cleartext environment variables. **No value copied here.** Existing configuration hardening/rotation should be a separate approved maintenance action, not part of this agent sprint.

## AI-client / WebMCP compatibility (2026-10-08)
| Surface | Finding | Status |
|---|---|---|
| ChatGPT Voice plugins on iOS | OpenAI Sep 23 2026 release notes say Live supports available plugins on iOS/web/Android | **Documented capability**, not yet tested with this custom app |
| Arbitrary owner-built remote MCP write tools on personal Plus | No successful account-specific deployment/invocation test. Developer-mode full MCP help currently documents organizational beta scope | **Unproven**; do not promise Voice can call this eventual MCP |
| Generic MCP-capable test client | Use typed/authenticated remote MCP client, independent of any particular AI/voice model | **Feasible design**, implementation/testing pending |
| WebMCP | Chrome documents `document.modelContext` with Chrome 149 origin trial or local flag | **Experimental browser enhancement only** |
| Tesla browser WebMCP | No verified support or exposed API | **Unknown; not required for remote bridge** |
| Fullscreen/autoplay in Tesla | Transient browser user activation and parked-vehicle policy must apply | **Must physically test in Park** |

Sources:
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes (2026-09-23 plugins in Voice)
- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt
- https://developer.chrome.com/docs/ai/webmcp (2026-10-07 update)
- https://developer.chrome.com/docs/ai/webmcp/secure-tools
- https://developer.chrome.com/docs/ai/webmcp/compare-mcp

## Adjacent garage service
`garage.ameshalex.com` redirects to `www.garage.ameshalex.com`. Local service is `com.amesh.tesla-garage-bookmark`, not a browser media relay. Its source contains a session-cookie/CSRF/origin guard, unique idempotency keys, cooldown and Home Assistant state verification. Reuse *security/reliability patterns*, **not** its garage-door action or access tokens. Garage state does **not** prove Tesla transmission Park, so never use it to bypass Tesla video restrictions.

## Threat model / engineering guardrails
1. Require `AI_MEDIA_AGENT_ENABLED=1` and loopback-only development by default. No unprotected public `/api/agent`, no unauthenticated WebSocket upgrades.
2. Separate device binding (short-lived owner-approved pairing) from remote-agent authorization. Device labels are untrusted user-assigned aliases, not proof that the device is a Tesla. Bind to trusted principal, exact session and tab. No implicit global/current device.
3. Authenticate remote MCP callers (scoped server-issued token and verified identity); authenticate browser session and check exact expected Origin and authenticated Cloudflare Access context at ingress. Do not trust arbitrary forwarded identity headers unless verified against Cloudflare's issuer/signature. Reject cross-origin and CSRF-sensitive commands.
4. Commands: explicit random device/session IDs, bounded schema/argument length, strict action allowlist, monotonically fresh sessions, queued command IDs, timeout, duplicate detection, no automatic retry for ambiguous completion. Distinguish `accepted`, `completed`, `needs_user_gesture`, `unsupported` and `failed` with state ACK. Read-only tools distinguish from mutations; throttle each principal/device.
5. Keep pairing/auth tokens and telemetry private, no token in URL/log; trim user media metadata and redact any secret. Media titles/search results are *untrusted data*, never executable agent instructions.
6. Feature flags default off, separate dev port, isolated test user data, regression matrix for classic/new UI + audio sync + WebCodecs/MJPEG. No deployment before owner approval.

## Proposed typed tool contract (v0; no arbitrary URLs)
- `list_devices() -> [{device_id,label,online,last_seen_at,capabilities}]` (principal-scoped).
- `get_player_state({device_id}) -> {item,paused,position,duration,mode,fullscreen_kind,observed_at}` read-only.
- `search_media({query,limit}) -> {results:[{media_id,title,creator,duration}]}` returns untrusted metadata, bound to authorized search provider.
- `play_media({device_id,media_id})`, `pause({device_id})`, `resume({device_id})`, `next({device_id})`.
- `seek({device_id,position_seconds})`, `set_volume({device_id,value_percent})`, `request_fullscreen({device_id})`; return bounded ACK/state, explicit unsupported if player mode cannot comply.

## Release gates
- [x] GitHub issues, design and Obsidian source inspected.
- [x] Production / main / dirty checkout / UI worktree compared, playback actions enumerated and health checked.
- [x] Current official WebMCP and Voice release notes checked.
- [x] Security threat model and typed tool outline documented.
- [ ] Actual iPhone Voice -> custom connected **write** tool experiment. Requires a safe test MCP plugin/agent exposed to this account, not simulated.
- [ ] Confirm Tesla browser behavior physically in Park; no guessed user-gesture results.
- [ ] Test registered session transport and negative cases (#28) in isolated dev.
- [ ] Test live playback facade, full regressions and release approval (#29-32).
