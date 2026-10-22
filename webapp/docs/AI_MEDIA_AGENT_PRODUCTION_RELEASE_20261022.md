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

## 2026-10-22: Single existing Cloudflare Access session hotfix (operator declined testing)

User reports that signing in to YT Streamer still triggered a second Cloudflare OTP, and the former **Sign in again** link merely refreshed the page. Inspecting the existing implementation revealed that the private AI bootstrap rejected signed requests if Cloudflare's edge-injected Access assertion and HttpOnly app cookie were not byte-identical. Cloudflare may legitimately refresh either JWT independently. The AI flow now trusts the **cryptographically verified edge-injected Access assertion** (with a signed cookie fallback only when the assertion is absent) without comparing token strings. It also accepts a signed provider-issued session with up to 30-day JWT validity while still enforcing pinned issuer, exact audience, subject, signature and current expiry; unrelated remote authorizers retain the original 24-hour maximum.

Removed the ineffective `/?ai_access_signin=1` **Sign in again** link. A **Reconnect AI** button now cancels its in-page socket/pairing attempt and retries using the already-authenticated browser session, without navigating the webpage or displaying a new OTP. Authentication failures no longer instruct the owner to log in a second time. New cache-busted script version `20261022-reuse-existing-access1`. Existing permission/opt-in still required, no Cloudflare protection changes, no new login or public control endpoint.

**Do not claim the real-browser issue verified resolved.** The user explicitly requested no tests; this release was statically reviewed and deployed without executing test suites, browser checks or live request probes. Previous known-good Mac runtime remains backed up for rollback.

## 2026-10-22 minimal safe authorization rejection diagnostics

User's authenticated iPhone loads the main website but AI bootstrap returns HTTP 401. Cloudflare app AUD from live login redirect matches the runtime configured AUD, Node JWKS key retrieval works, yet the previous code suppressed all auth diagnostics. This private diagnostic patch records **only coarse rejection category codes** in local server logs (method/origin/host/Fetch-Site/no JWT/issuer/audience/timestamp/signature class). Never logs token, cookies, headers, subject, email or JWT payloads; original response remains generic 401, no authorization bypass. Not a user-facing test. On real user traffic after deployment, find precise category then implement minimal fix and remove temporary instrumentation if appropriate.

## Cloudflare Tunnel Host rewrite compatibility

The prior `authenticateHttp` rejected POSTs whenever Express's origin `Host` differed from the browser `Origin` host. Tunnel origin forwarding may legitimately alter the upstream Host/port. Removed this redundant equality condition; **exact allowlisted browser Origin**, valid POST method, same-origin Fetch-Site when supplied, and **fully signed Access application JWT with pinned team issuer and AUD** remain mandatory. Coarse rejection-only private logs still active for remaining causes. Client must not be routed through a second login just because the separate AI bootstrap failed. No broad allow or JWT bypass.

## Real Cloudflare logout entrypoint

The previous UI's **Reconnect AI** merely retried a rejected API call, and a prior **Sign in again** query string merely refreshed the site. The UI now uses Cloudflare's documented browser logout path: native `href="/cdn-cgi/access/logout"` labeled **Reset Cloudflare login**. Only an actual browser navigation can remove the HttpOnly authorization cookie from the owner's device. Cloudflare Access controls what screen follows logout; the owner can return to stream.ameshalex.com for the real login. **Cloudflare Access logout revokes the session across Access-protected apps**, not only YT Streamer; this is explicitly user-requested logout behavior. Existing opt-in remains saved and reconnects on return. The backend separately preserves exact Origin and signed app JWT verification after removal of the tunnel Host equality pitfall. No proxy or Access policy changes. JS client cache-bust: `20261022-native-cloudflare-logout1`. User previously requested no test runs; this is an unverified hotfix.
