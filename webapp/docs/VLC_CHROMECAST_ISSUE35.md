# VLC → Chromecast handoff (GitHub #35)

Status: isolated development only. **No production deployment or Tunnel/Access change.**
Branch: \`feature/vlc-chromecast-issue35-20261011\`, stacked on UI v3 PR #25.

## Supported now

- Classic and New UI share the same player toolbar: **Cast / Open in VLC**.
- Sources: saved file items, saved YouTube items, direct YouTube playback (search, recommendations, pasted YouTube URL), and processed-library videos. Arbitrary remote IPTV/M3U8, browser desktop mirroring and prepared-only WebCodecs cache are not yet supported.
- Server creates an optional on-demand single-stream H.264 video / AAC audio HLS session using FFmpeg, separate from MJPEG/WebCodecs and browser audio.
- Rolling HLS keeps eight ~4-second segments, deleting older data to avoid filling Mac storage. This is linear playback, **not full HLS seek/DVR**.
- Per-session random 256-bit media ticket, TTL **90 minutes**, inactivity cutoff **15 minutes**, at most **two concurrent** transcodes. Revocation removes segment files. Explicit Stop session cancels the cast. A stopped/expired session needs a fresh link.
- Signed Cloudflare Access JWT (issuer, audience, kid / JWKS, RS256, exp, nbf, sub) is required for POST/status/DELETE session controls; unsafe cross-origin creation/revocation is rejected.
- Receiver manifest/segments use only a temporary ticket scoped to a single cast, without cookies or Cloudflare user credentials. Tickets appear in the manifest URL path and are bearer capabilities: do not share them publicly. The app does not add token-bearing media paths to its own diagnostic events.
- No paid API, new NPM dependency, or existing player change.

## Deployment prerequisites — *not performed*

Set private runtime environment from reviewed Access app configuration:
- \`CAST_ENABLED=1\`
- \`CAST_PUBLIC_ORIGIN=https://stream.ameshalex.com\`
- \`CAST_ACCESS_ISSUER=https://<your-CF-team>.cloudflareaccess.com\`
- \`CAST_ACCESS_AUDIENCE=<the Access application audience tag>\`

Protect \`/api/cast/*\` with the matching **Cloudflare Access application** so authenticated browser requests receive the signed Access assertion. Do not expose session-control APIs without Access. The app also verifies the assertion. The Chromecast cannot use the user's browser Access cookie/JWT; \`/cast/media/*\` must be publicly **reachable** through the Tunnel but is separately authorized for every request by the one-session random ticket. If Cloudflare Access gates the entire hostname including this receiver route, cast playback cannot work: a narrow media-path exception or separate hostname/ingress policy with the equivalent ticket gate must be explicitly reviewed and approved. This is not a general Access bypass; do not turn off Access for any other app or route. Check Tunnel/edge logging and caching to ensure ticket-bearing paths are not retained or indexed. Do not put Cloudflare tokens or service credentials in URLs.

Feature remains disabled if opt-in configuration is absent. Preview/test must use a separate isolated data directory and port, not the deployed \`com.ytstreamer.webapp\` service.

## Physical iPhone / Chromecast acceptance (after separately approved release)

1. On the iPhone, connect to the friend's Wi-Fi and ensure Chromecast/Google TV is on **that same LAN**. Grant VLC permission for **Local Network** in iOS Settings.
2. In iPhone Safari or Chrome open \`https://stream.ameshalex.com\`, sign in to Access if prompted, and start a supported video.
3. Tap **Cast / Open in VLC** (available in both Classic/New). Once the HLS session is ready, tap the second **Open VLC** link. This two-tap flow is intentional: iOS may reject a deep link after an async network operation loses user activation.
4. In VLC, select the Chromecast/renderer icon and the TV. It should fetch the media over HTTPS from the Mac's Cloudflare Tunnel; the Mac and TV are **not** on the same LAN.
5. If the URL scheme does not launch your VLC version, tap **Copy temporary link**, then in VLC choose **Network > Open Network Stream** and paste; or use **Share link** with an appropriate destination. Avoid sending a live bearer link to other people.
6. Check video and audio start together, playback for 10+ minutes, reconnect after an iPhone app switch, expired-token behavior, link revocation via **Stop casting session**, and no effect on MJPEG/WebCodecs playback.
7. VLC URL scheme \`vlc-x-callback://x-callback-url/stream?url=...\` is documented by VideoLAN, but **Safari/Chrome → the specific installed iOS VLC version, Chromecast receiver selection, and actual remote-network playback are not proven until physical acceptance**.

## Tests

- \`npm run check\` syntax checking of server, HLS, Access and UI scripts.
- \`node --test test/vlc-cast.test.mjs\`: synthetic JWT signed/forged/expired, source restrictions, scoped ticket/segment, 403/410/revoke, and an **actual local FFmpeg** 7-second fabricated video+audio HLS file validated via FFprobe for H.264 and AAC.
- \`npm test\`: full existing suite and new tests.
- \`npm run test:ui\`: existing Chrome UI v3 checks; a pre-existing fullscreen quick-dock assertion at the UI v3 base must be reconciled with its independent owner before this PR can pass all browser checks.
- GitHub Actions: confirm exact commit head after push, never infer CI from local results.

## Outstanding release gates

- Actual installed iOS VLC deep-link launch and Chromecast renderer behavior.
- Exact Cloudflare Access routing architecture, gateway log redaction, signed user session ingress and remote Chromecast fetch.
- Real streaming from YouTube with its independent video/audio proxy, processed library content, rate/bandwidth stability; offline fabricated media proves the codec pipeline, not these upstreams.
- Seek and playback after 90 minutes (currently link will expire; issue a new session); HLS is rolling with no rewind.
- Chrome UI full suite quick-dock fullscreen baseline fix in separate UI v3 owner branch.
- No merge, production restart, Cloudflare policy edit, deploy, or service changes without explicit separate approval.
