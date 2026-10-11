# VLC Chromecast v2 — bounded, seekable video on demand (#38)

**State:** isolated branch, automated acceptance only. Do not deploy/merge this
branch without separate approval. **Real iPhone VLC/Chromecast acceptance is pending**;
the v1 handoff itself has not been physically verified after the browser cookie fix.

## Architecture

The already protected `stream.ameshalex.com` POST/GET/DELETE control API still
verifies a signed Cloudflare Access RS256 assertion or signed application cookie,
issuer/audience/expiry, owner, and same-origin mutation. Source allowlisting,
2-session limit, random 256-bit per-session bearer tokens and the **media-only**
`cast.ameshalex.com` receiver hostname remain in place. No Cloudflare session
cookie travels to the Chromecast and no paid API is used.

For duration-known VOD (up to **4 h 15 min**), FFprobe determines the movie length
server-side. The receiver gets a complete immutable HLS VOD playlist with numbered
6-second MPEG-TS segments and `#EXT-X-ENDLIST`. The app pre-encodes only segment
zero; other segments are encoded on the receiver's request with identical audio
and video seeks and absolute output presentation timestamp offsets. The Chromecast
can request segment 2,100 without waiting for segments 1 through 2,099. Encoder
processes are bounded and terminate after each segment. No FFmpeg process runs
while the receiver is paused. A maximum 24 cached segments per session plus up to
8 pinned in-flight downloads limits disk use. LRU eviction means old positions
can be re-encoded on a backward seek. One encoding job runs at a time per session,
with at most four queued segment requests. Jobs time out at 30 seconds.

For a source whose FFprobe duration is **unknown**, the existing rolling HLS path
still works but is explicitly marked **not seekable**. This fallback is not a
promised long-movie solution. A detected duration over 4 h 15 min is rejected.
Live streams, desktop browser streaming, and other browser transports are unchanged.
VOD creation's startAt offset is not transferred to initial VLC playback; VLC can
seek in the full movie timeline after handoff.

## Revocable receiver-driven authorization

The Chromecast cannot send signed Cloudflare Access controls or renew a URL via
the browser. Instead, the original random per-cast URL stays the same only while
the server session remains active. Each authorized media request extends a **90 min
sliding lease**, without ever exceeding a **6 h immutable hard maximum from
creation**. **45 min idle** ends the session even before that lease expires.
Signed owner DELETE stops the session and revokes the bearer URL immediately.
The 6-hour ceiling also ends active playback; it is not perpetual renewal.
A new browser-authorized cast is required afterward. The TV does not receive the
Access JWT or a permanent public media feed.

Bearer tokens appear in media URL paths (necessary for a cookie-less receiver).
Do not copy these into logs, analytics, screenshots, or public tickets. Receiver
media responses send no-store, no-referrer and noindex headers. Cloudflare edge,
tunnel, browser history and external URL log retention **still require deployment
review**; these headers alone cannot erase CDN request logs or VLC history.

## Controls and recovery

Classic/New UI retain Cast/Open VLC, Copy temporary link, Share and Stop. New
**Check / Reconnect** queries the signed control endpoint and checks when the
browser returns to the foreground. Re-open VLC to reconnect a renderer with a
still-active link. A stopped/expired session requires a *new* Cast action.
A backgrounded iPhone is not necessary to continue server-side delivery if the
Chromecast keeps fetching segments, but that **must be tested on real hardware**.
A 503 response indicates a failed/busy encoder; 403 invalid ticket, 410 revoked/
expired, 429 overloaded receiver; the TV may not render those HTTP codes clearly.

## Verified automatically on isolated worktree

- 4-hour playlist has 2,400 segments, VOD endlist, and matching seek indices.
- Mock clock: >5-minute pause, forward seek beyond 3h, backward seek, 24-segment
  cache limit, signed owner revocation, 45-minute idle cutoff, receiver-driven
  lease renewal and six-hour hard stop. Invalid-token/HTTP scope tests inherited.
- Real fabricated 15-second separate video/audio FFmpeg source: on-demand
  12-second seek segment has H.264/AAC, synchronized starts within 250ms,
  expected absolute PTS; FFprobe can demux entire HLS playlist via HTTP.
- Byte-range request for an encoded segment returns 206.
- Full Node, Chrome and exact-head GitHub Actions results must be recorded with
  commit SHA and run link; they are not equivalent to physical TV acceptance.

## Required physical testing before production release

On iPhone Safari and Chrome, test authenticated Cast → installed VLC → actual
Chromecast/Google TV on the iPhone's *remote* Wi-Fi, Mac mini at home. Test 3h
continuous real playback; pause >5m and resume; seek to 20m, 2h, near the end
and backward; confirm audio lip sync and no freezes at 6-second boundaries;
lock screen >30m, switch/close Safari and VLC, disconnect/reconnect, stop/revoke
and new link. Observe Cloudflare request-path logging/cache rules before rollout.

**Known risks:** on-demand encoding latency after cold seeks, source URL expiry
at the upstream YouTube provider, client-specific TS discontinuities/gap handling,
and Chromecast buffering behavior. Tests on actual receiver hardware remain
necessary. Production, launchd, Tunnel, Access, HAOS, existing UI and browser
transport paths have not been modified.

## Follow-up lifecycle hardening (isolated, #38)

- Concurrent POST requests now reserve their cast slots before any asynchronous
  media lookup, preventing more than two sessions from starting in a race.
  Shutdown rejects late source lookups and avoids creating new cast sessions.
- The authenticated session GET sweeps expired state before reporting active.
  If a disconnected iPhone cannot check status, the UI **preserves** the existing
  VLC URL and offers retry; only a confirmed 404/410 or ended/error session
  clears the link. This is a recovery UI improvement, not proof that a specific
  Chromecast reconnects successfully in real hardware.
- Requested VOD segments are pinned before asynchronous encoding starts, and
  remain pinned until HTTP response completion/close, preventing eviction races.
- An app startup cleanup scans only the dedicated cast scratch root and removes
  valid-looking session directories older than 8 hours (6h max session lifetime
  plus 2h grace). It skips other files/dirs and any currently active sessions.
- Cast bearer URLs are redacted from application exception logs. Local Tunnel
  YAML has no explicit log-file or cache setting and no cloudflared log file was
  found; **Cloudflare edge request-log/path retention and cache rules could not
  be verified from local files** and must be checked before rollout.
- Automated tests now exercise concurrent admission, shutdown-before-lookup,
  stale scratch cleanup, temporary browser outage preservation, known revocation
  and token redaction. Phone-lock / Chromecast hardware acceptance remains open.


## Native VLC and public-edge pre-release verification — 2026-10-11

Mac mini VLC is installed at `/Applications/VLC.app/Contents/MacOS/VLC`.
`npm run test:vlc-native` creates an **isolated localhost HTTP cast service**
and two fabricated FFmpeg sources. It launches **headless native macOS VLC**
with `--ignore-config`, reads the temporary HLS URL and streams out MPEG-TS.
VLC yielded **2,125,340 bytes**, with **H.264 and AAC** confirmed by FFprobe;
actual VLC playback/demux **PASS**. All synthetic scratch assets are removed.

Read-only external Cloudflare probe using a **fabricated, never-issued ticket**:
`cast.ameshalex.com` responded HTTP **410**, `Cache-Control: private,
no-store, max-age=0`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow, nosnippet`, and
`CF-Cache-Status: DYNAMIC`. This supports denial/no-cache behavior at that
moment only; it does **not** establish path-log retention or valid-ticket
response behavior. v2 also explicitly emits `CDN-Cache-Control: no-store`
and `Cloudflare-CDN-Cache-Control: no-store` for defense in depth.

### Remaining real-device acceptance (must not be marked passed synthetically)

On the iPhone and Chromecast/Google TV sharing a friend's remote Wi-Fi:
1. Authenticate to `stream.ameshalex.com` in Safari/Chrome, start an
   authorized saved movie, then tap Cast / Open VLC → Open VLC.
2. Select the TV in VLC. If the iOS URL handler fails, copy the temporary
   link into VLC > Network > Open Network Stream.
3. Verify picture/audio immediately, cross multiple six-second boundaries,
   pause for at least 6 minutes then resume at the same position.
4. Seek near 10 min, 2h, 2h50, near the end, and backward. Confirm lip sync.
5. Lock phone >30 min, change apps, reopen Safari/VLC and use Check / Reconnect.
6. Disconnect/reconnect TV or Wi-Fi; confirm recoverable status and no lingering
   transcoders. Play a **real** complete 3h movie.
7. Stop Cast from authenticated Streamer, verify old bearer URL fails with
   410, check scratch cleanup. Review Cloudflare edge request URL/path logging
   retention and cache rules in account dashboard, not only local YAML.

If failure occurs, capture only status/error and timestamps. **Never paste a
live bearer ticket URL**, Access token, or secrets into bug reports.
Do not merge/deploy/restart or alter Cloudflare policy without separate approval.
