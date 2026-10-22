# TeslaMon isolated Mac staging — 2026-10-22

## Status

- A private Mac staging process is installed as user LaunchAgent `com.amesh.teslamon.staging` on **127.0.0.1:8107**, **not exposed on the internet or LAN**.
- Existing production YT Streamer remains on **127.0.0.1:8099** and is not modified or restarted. Existing prod Cloudflare tunnel `yt-streamer` is also unchanged.
- Source worktree: `/Users/amesh/Developer/ytstreamer-teslamon-staging-20261022`, branch `feature/teslamon-staging-20261022`, forked from immutable Mac MVP review commit `f4412102b571e89a306616595aa3857e07f0e218` (draft PR #85).
- Staging hostname reserved in the source/config: `https://teslamon-stage.ameshalex.com`. **Not currently DNS-routed or publicly accessible. Do NOT label it live until an Access policy is installed and end-to-end verified.**
- Separate named Cloudflare tunnel `teslamon-stage` (UUID `4d562ecd-93f5-4179-9802-f6c68a981edf`) has a private credential file and an ingress config `~/.cloudflared/teslamon-stage.yml` mapping this hostname to localhost:8107. Ingress config validated. **Tunnel intentionally stopped; no DNS route published.** No public staging traffic can reach it at this point.
- The existing Cloudflare Access audience and team domain are read at startup from the production launch-agent plist **without copying tokens**, but stage uses isolated `YT_AI_AGENT_CONTROL_DIR`. If Cloudflare protects staging as a *separate* Access application, the staging `YT_AI_AGENT_ACCESS_AUDIENCE` must be changed to the new application AUD before browser sign-in tests; never loosen JWT verification.

## Isolation / service controls

- Stage runtime directory: `~/Library/Application Support/TeslaMonStaging`, privately owned (0700).
- Isolated paths: `data/`, `library/`, `apne/`, `control/`, `chrome-profile/`; no reads/writes to production YT Streamer library, profile or control socket.
- Staging launcher: `~/Library/Application Support/TeslaMonStaging/run-stage.py`; launch agent: `~/Library/LaunchAgents/com.amesh.teslamon.staging.plist`. No API secret embedded in repo. Port 8107 loopback-only.
- The Mac env has `YT_TESLAMON_ENABLED=1` only in staging. `YT_TESLAMON_STAGING=1` disables the unrelated APNE background scanner, and `YT_TESLAMON_STAGING_SHA` is derived from the exact staging Git HEAD to identify the process without modifying tracked source files. `TESLAMON_OPENAI_API_KEY` and `TESLAMON_OPENAI_MODEL` are not supplied, therefore no paid model calls. Staging also has no private Whisper model configured, therefore text controls and browser-native speech support only where the browser provides it.
- To inspect locally: `curl http://127.0.0.1:8107/api/health`.
- To stop without touching production: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.amesh.teslamon.staging.plist`.
- To restart only staging: `launchctl kickstart -k gui/$(id -u)/com.amesh.teslamon.staging`.
- To stop external tunnel later if enabled, use its separate launch agent or `cloudflared tunnel cleanup teslamon-stage` **only after verifying tunnels**; never stop or edit existing `yt-streamer` tunnel.

## Security verification (actual local endpoints)

- `GET http://127.0.0.1:8107/api/health`: 200, staging process on private port, with `release.revision` equal to the staging branch's exact Git SHA.
- `POST /api/teslamon/devices` with matching staged Host, HTTPS forwarded proto, Origin and no signed JWT: **401 signed_access_required**.
- `POST /api/teslamon/command` with mismatched/cross-site Origin: **403 wrong_origin**.
- Separate production 8099 still responds normally; process not restarted.
- Full Node unit and signed two-WebSocket relay fixture suite passed in source PR #85 (609/609). Stage-specific origin override static check returned exact `https://teslamon-stage.ameshalex.com`.
- These are local developer and unauthenticated security tests, NOT public Cloudflare, real microphone, iPhone or parked Tesla acceptance.

## Required single external setup step before user device testing

In Cloudflare Zero Trust, configure an **Access self-hosted application** protecting `teslamon-stage.ameshalex.com`, restricted to the owner's existing identity/email with the same strict authentication policy as the production YT Streamer. Prefer a separate staging application, and note its **Application AUD tag** (not a secret). Do not rely on an unprotected DNS route or a bare Cloudflare Tunnel.

Once protection is configured:
1. Set the stage launcher to the new Access Application AUD tag; verify signed controller JWT from the staging app on localhost and ensure forged/mismatched JWT fails. Keep existing prod audience unchanged.
2. Create staging-only DNS CNAME route via `cloudflared tunnel route dns teslamon-stage teslamon-stage.ameshalex.com` and start **only** the new tunnel/config. Confirm Access challenges occur *before* origin traffic.
3. Verify browser HTTPS, session/WS pairing, selected and decoy browser, pet overlay, typed controls. Only then give user the stage URL for iPhone/parked Tesla acceptance.
4. No merge, restart or deployment to production. Stage fallback is stop staging tunnel, then staging launch agent; leave data private.

Do not present a localhost-only service or merely configured tunnel as a ready public staging URL. No user API keys, cookies or JWT strings should be copied to notes.
