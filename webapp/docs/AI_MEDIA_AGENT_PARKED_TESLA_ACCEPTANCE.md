# AI Media Agent — parked Tesla / iPhone acceptance and rollback (#32)

Updated 2026-10-08. **Checklist only. None of the physical tests below have been run.**
No production changes are authorized. Browser relay/MCP in this branch are **loopback developer proofs**, not suitable for public routing.

## Prerequisites and safety
- [ ] Owner explicitly approves a separate staging setup, TLS ingress, verified provider identity, browser session approval and nonpublic transport. Never forward `/dev/mcp` or `/dev/player` through Cloudflare.
- [ ] Tesla is physically parked, vehicle display confirms Park, and a passenger/owner can use the touchscreen safely. Do not infer Park from garage state.
- [ ] Production playback and routing documented, backup/recovery plan verified without restarting production.
- [ ] iPhone has actual compatible voice client with authenticated MCP **write** invocation; verify account/app capabilities instead of assuming ChatGPT Voice support.
- [ ] Use a low-sensitivity public YouTube clip, no history/credentials in benchmark artifacts.
- [ ] iPhone and Tesla browser each display independent verified session identifiers; owner explicitly approves target browser.
- [ ] Access token/session expiry, revocation, consent and origin rules independently reviewed.

## Real-device command matrix (all pending)
- [ ] Search by natural speech; confirm bounded selectable results and selected title.
- [ ] Play public video, then song; verify audio is actually audible from Tesla speakers and the video visibly renders.
- [ ] Pause, resume, next, seek forward/back and state; check observed phase changes instead of treating `accepted` as completed.
- [ ] Fullscreen request returns `needs_user_gesture` where activation is required; Tesla touchscreen enters/exits fullscreen manually.
- [ ] Volume changes only if explicitly supported and empirically confirmed by target; otherwise `unsupported`.
- [ ] WebCodecs and buffered MJPEG, with audio clock/frame progress, rebuffer count and visible A/V drift in both.
- [ ] Classic and New UI variants after reconciling independent UI work (#24 / PR #25); retain toggle and /money routes.
- [ ] Background browser/tab, iPhone lock/unlock, network switch and Tesla sleep/wake; verify reconnection identity changes and resumption behavior.
- [ ] Attempt while Tesla is not confirmed Park: respect original Tesla browser controls and do not bypass any driving restrictions.

## Metrics to record per attempt (without media history or identifiers)
- command ACK latency p50/p95, time to first visible picture, time to first audible sound **manually observed**;
- success rate across >=10 trials per action/transport, timeout/unknown rate, reconnect time;
- position accuracy before/after seek; rebuffer count and duration; sampled video/audio drift (where available);
- device-switch targeting correctness and browser background suspension recovery.
- Include client type, browser version, network class and explicitly marked observation method; do not call JS AudioContext state proof of speaker output.

## Security negative tests
- [ ] Anonymous/wrong-user MCP requests rejected, including cross-user device IDs.
- [ ] Unpaired browser, expired approval and revoked session rejected; no owner token embedded in browser source.
- [ ] CSRF/Origin and malicious WebSocket upgrade denied; session bound to verified identity and the exact browser approval.
- [ ] Token leakage checks for logs, GitHub, Obsidian, browser storage and URLs.
- [ ] Duplicate commands, late ACK, stale target IDs, replay after reconnect, flooding, offline and timeout all fail safely.
- [ ] Disconnect/revoke turns control off immediately; no replay of previous state-changing commands.

## Deployment and rollback (not authorized; planning only)
1. Record production revision, health and known-good backup; stage isolated service and public-domain test data.
2. Obtain explicit approval for **any** production, Cloudflare or launchd change.
3. Enable only approved authenticated ingress, verify deny-by-default before connecting a browser.
4. Rollback: disable newly added ingress; disconnect/revoke paired devices; restore known-good app revision if explicitly approved; verify production HTTP health and normal playback. Do not alter garage automations.
5. After rollback verify no remaining public relay/MCP route and document failures without secrets.

## Current lab evidence (2026-10-08)
An **isolated localhost** server, port 18199 with a distinct temp DATA_DIR and Chrome profile, successfully performed real YouTube search using yt-dlp. Real Chrome decoded/rendered a public Big Buck Bunny clip in MJPEG and WebCodecs. Both modes entered buffering during later sampling, so continuous playback and all physical acceptance remain open. Audio-element and WebCodecs clock progress are not proof of audible speaker output. See development sprint checkpoint for exact results.
