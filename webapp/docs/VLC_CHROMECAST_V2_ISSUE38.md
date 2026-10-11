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
