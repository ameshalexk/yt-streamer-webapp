# AI Media Agent — production Mac release (2026-10-22)

Scope: `stream.ameshalex.com` on the existing Mac mini. Home Assistant `streamha.ameshalex.com` is not deployed as part of this owner-scoped rollout. Source is shared and covered by Shared release CI.

## Playback control

The already-connected ChatGPT Mac Control integration invokes the existing typed `ai-agent-mac-control-cli.mjs` through one `terminal_run`. The CLI talks to an owner-only Unix socket (`0600` under a `0700` directory), not HTTP. Direct commands are `list_devices`, `select_device`, `search_selected`, `play_selected`, `pause_selected`, `resume_selected`, `stop_selected`, `state_selected`; the original consent-scoped APIs remain for compatibility. A selected device is saved privately across Mac service restarts and bound to the subject from its *verified* Cloudflare Access JWT. If multiple authorized browser tabs exist without a previous selection, the bridge returns `ambiguous_target` instead of controlling an arbitrary tab.

Each browser tab requires the user to click **Enable AI** once. The setting persists in that browser's local storage; tab identity uses session storage and survives reload. The authenticated page's same-origin WSS client reconnects automatically on visibility/network/reload, with heartbeats and real player ACK/state. Per-command DOM approval is not required for these six bounded media actions once opted in. **Do not interpret browser opt-in as permission for arbitrary tools or cross-app OS control.** Only current media search results can be played by ID; no arbitrary URLs, script execution or credential access.

For a single already-selected browser, one Mac Control call suffices for Pause or Resume:

```sh
node scripts/ai-agent-mac-control-cli.mjs --socket "$HOME/.yt-ai-media-control/bridge.sock" --action pause_selected --args '{}'
node scripts/ai-agent-mac-control-cli.mjs --socket "$HOME/.yt-ai-media-control/bridge.sock" --action resume_selected --args '{}'
```

Use `list_devices` then `select_device --args '{"device_key":"..."}'` once to change the exact browser target. `search_selected` takes `{"query":"...","limit":5}`, `play_selected` takes a returned `{"media_id":"11charID"}`. `state_selected` reads observed playback phase, position, frame count and paused state. The existing YT Streamer manual seek/fullscreen controls and Classic/New UI are unchanged. Playback completion and audio audibility cannot be inferred from an `accepted` or `buffering` response alone.

If Safari is suspended/offline, a Resume can queue for at most 120 seconds **only for a previously selected exact tab key and signed Access subject**. It is delivered after authenticated reconnect. Queueing is not proof that iOS allowed background playback. Pause/Stop clear queued resume and report offline rather than claiming success when no tab is connected. Commands have UUIDs, bounded pending capacity and replay protection. Restarting the Mac service preserves the selected browser key but not an unconfirmed pending command.

## Security and Cloudflare

No new Cloudflare application, route, tunnel, DNS, or authentication policy is required. Use the existing Access session on the existing stream hostname. WSS upgrade at `/ai-agent/player` requires HTTPS-page `Origin` match and a cryptographically verified RS256 Cloudflare Access JWT with pinned issuer (`ameshalex.cloudflareaccess.com`), exact **stream-app** audience (not the unrelated Money/cast Access audience), signing keys from the pinned JWKS endpoint, non-expired token, valid subject. If an explicit subject allowlist is configured, enforce it; otherwise the existing Cloudflare Access application policy defines authorized subjects. Never accept client-supplied principal, device ID, OS command, remote JavaScript, bearer-only `/dev` route or forged email header. The site remains subject to the existing Cloudflare session expiry/login policy.

The server offers **no public media-control POST endpoint**; trusted WSS browser messages can only register/ack/heartbeat, not request playback. Only the same-user Mac Control socket may dispatch commands. Other software running as the Mac owner's OS user can reach that socket, so maintain workstation security. Restrict tool access and keep any production JWT/audience or credentials outside the public repository (the audience is not a password). Never disable Cloudflare Access to make pairing easier.

App boot enables the control relay only when private environment has both `YT_AI_AGENT_ACCESS_AUDIENCE` and `YT_AI_AGENT_CONTROL_DIR`. Optional `YT_AI_AGENT_ACCESS_TEAM_DOMAIN` and `YT_AI_AGENT_ALLOWED_SUBJECTS` provide issuer and subject policy. A disconnected or expired browser cannot receive immediate commands. Live signed Cloudflare session, parked Tesla and iPhone Safari background behavior need owner validation after release.

## Release and rollback

The deployed commit is embedded in `release.json`. Verify the Mac `GET /api/health` revision **and** the private socket by running the CLI `list_devices`; a healthy web server by itself is insufficient to prove control. Check unauthenticated public Access routing still requires sign-in. Do not copy test certificates or credentials into Git. Keep a scoped copy of the prior Mac release code/dependencies and its immutable Git SHA before restart; rollback replaces only the Mac application code and restores its prior LaunchAgent environment without touching runtime data, Home Assistant or Cloudflare. Physical phone and Tesla tests are explicitly waived by owner *before rollout* but must be reported as unvalidated, not passed.

Focused regression coverage: Node registry, production Access signature/origin and cross-device control tests; Chrome Classic/New/MJPEG real frame and pause/resume tests, separate audio fixture, JXL/WASM decoding and seek recovery, mobile layout. The project remains limited to ChatGPT text with the connected Mac Control capability; native ChatGPT Voice remote custom-MCP writes are not assumed.

## 2026-10-22 production reconnect hotfix

The initial production browser client could repeatedly display `AI: reconnecting` when an authenticated Cloudflare Access browser WebSocket did not forward a signed Access assertion/cookie during `Upgrade`. This was a transport assumption, not evidence that the website or service was offline. The hotfix obtains a single-use, 15-second pairing ticket through a **same-origin HTTPS POST `/api/ai-agent/bootstrap`**, which independently verifies the signed Cloudflare Access JWT with the existing issuer/audience/JWKS/subject policy and strict Host/Origin/Fetch-Site checks. The browser then presents that one-time ticket in its first WSS `hello` frame; neither the signed JWT nor the ticket enters URL/query strings or public logs. Unauthenticated WSS connections cannot register, receive playback commands or obtain a device grant. Stolen/expired/replayed tickets are rejected and capacity bounded. No Cloudflare login policy, DNS, application, tunnel, player or other services need modification. The status UI now separates session-verification failures from WebSocket failures and retries connectivity with bounded delay, preserving original browser opt-in. The URL version for production JS was changed to ensure reload picks up this fix.

Automated safety coverage: signed bootstrap, wrong audience/origin, tokenless WSS success, missing and duplicate/replayed ticket denial, one-call exact selected-device control and reconnect queue, and existing Chrome playback regression. Physical iPhone/Tesla validation remains pending; no false claim of a tested live signed-in remote browser.

## 2026-10-22 Cloudflare reauthentication UI hotfix

The existing AI panel has a visible **Sign in again** link even when AI is off, connecting, or repeatedly reconnecting. It navigates the current tab to the same **Access-protected** YT Streamer root at `/?ai_access_signin=1`; Cloudflare displays OTP when a new session is needed and otherwise reuses the valid session. This does **not** log out other Access applications or invent/bypass a Cloudflare login endpoint. Browser AJAX bootstrap now sets `X-Requested-With: XMLHttpRequest` (per Cloudflare's documented 401 response guidance), rejects invisible cross-origin redirects and shows direct sign-in instructions for authentication, redirect and WS errors. The script cache-bust changes to `20261022-ai-reauth-ui1`. No Cloudflare DNS, tunnel, Access policy or backend auth settings change.


## 2026-10-22 production sign-in correction

The prior Sign in again link navigated to the same YT Streamer root with an irrelevant querystring, which reloads the site when Cloudflare has already approved the session. A valid browser login can coexist with failing AI bootstrap: the prior TeslaMon production release restored obsolete Host equality and 24h JWT lifetime checks in the AI backend.

Changes:
- Restores previously deployed signed Cloudflare JWT behavior (pinned RS256/issuer/audience/subject/iat/nbf/exp) with actual policy session length accepted for the trusted browser path. Generic remote verifier keeps its stricter default.
- Accepts valid signed edge assertions even when the independent browser cookie was rotated; never downgrades an invalid edge assertion to a cookie.
- Uses exact trusted public Origin, request metadata, signed app JWT but does not require the Cloudflare tunnel's internal Host to match browser Origin.
- Explicit Sign out & sign in now uses Cloudflare's documented /cdn-cgi/access/logout endpoint, not a same-site reload; this logs the user out across Access apps. No automatic logout or new AI account.
- Preserves TeslaMon local player and streaming transport. Cache-busts the browser client.
- Adds long-session, Host rewrite, cookie rotation, bad signature, logout route and responsive UI regression tests. Both platforms CI and owner device acceptance remain separate.
