# V2-04 — Slowdown diagnosis and startup latency

Implemented locally on September 14, 2026 in the `version-2.0` worktree. Production/version 1 was not changed.

## What was measured

Representative VOD: `https://www.youtube.com/watch?v=40nfhLC7i84`, 480p / 24 FPS / JPEG Q7, local v2 port 8100.

### Before V2-04

| Stage | Measured wall time from Play |
| --- | ---: |
| Optional `/api/youtube/info` lookup when metadata was missing | 2.36 s by itself |
| First MJPEG frame received | 5.42 s |
| 4 s media buffer available | 6.11 s |
| First visible rendered picture | 6.16 s |

Direct endpoint measurements before the repair:
- video first byte: 5.01 s
- audio first byte: 4.12 s

The 4-second startup policy was not adding four wall-clock seconds. FFmpeg is allowed to burst for VOD, so the queue filled from first frame to the 4-second media target in about 0.7 seconds. The dominant blank-screen cost was source resolution plus FFmpeg startup.

### After V2-04

Fresh-process cold run with duration already known:

| Stage | Measured wall time from Play |
| --- | ---: |
| yt-dlp/source resolution | 2.04 s |
| FFmpeg start → first output | 1.31 s |
| First decoded picture visible | 3.45 s |
| 4 s media buffer available | ~3.69 s |
| Audio ready | ~4.25 s |
| Synchronized playback / first moving frame | ~4.3 s |

Fresh-process run with duration missing, so metadata also had to be discovered:
- first picture: **3.17 s**
- buffer target: **3.52 s**
- audio ready: **3.57 s**
- synchronized playback: **~3.6–3.7 s**
- source resolution: **1.92 s**
- FFmpeg first output: **1.19 s**

Warm 90-second resolver-cache run:
- first picture: **~1.43 s from Play**
- 4-second media buffer: **~1.68 s**
- synchronized playback: **~2.8 s**
- resolver: cache hit
- FFmpeg first output: **~1.30 s**

These are representative single-machine/source runs, not fixed promises. YouTube/CDN resolution varies.

## Changes

### Startup latency

- Video and audio requests now share one in-flight/short-lived YouTube source resolve.
- yt-dlp now resolves the muxed/H.264-split/generic fallback choices in one process instead of potentially launching a failed muxed attempt and a second split-stream attempt.
- H.264 is preferred when split video is needed, with generic codec fallback.
- The upstream YouTube source is capped to the requested playback height (for example 480p playback no longer resolves a 720p source just to scale it back down).
- The audio request carries the same requested height so it shares the video resolver entry.
- Missing duration/title metadata no longer blocks the initial stream request; it is fetched in parallel and updates seeking when available.
- The first decoded JPEG is drawn immediately as a **startup preview**. The player still waits for the safety buffer/audio readiness before declaring playback started.

### Why the 4-second startup target remains

Keep **4 s startup / 8 s max / 2 s rebuffer** for synchronized moving playback. The September 11 controlled A/B test showed the 4/8/2 policy survived a deliberate 5-second frame-ingress interruption without a rebuffer, while the older 3/5/1.5 policy rebuffered.

The latency repair therefore separates:
1. **time to first picture** — show the first decoded frame immediately; from ~6.16 s to ~3.45 s cold in the representative run,
2. **time to safe synchronized motion/audio** — retain the resilience target.

### Slowdown diagnosis

New client stats include:
- received bytes and bytes/sec
- effective received FPS
- rendered FPS
- requested-FPS producer ratio
- queue direction (growing/stable/shrinking)
- JPEG decode average/max time
- A/V drift
- stale frames dropped
- rebuffer/recovery state
- source-resolve timing
- server/FFmpeg first-output timing

Server stream summaries now include:
- bytes written
- HTTP backpressure count
- cumulative time waiting for response drain
- first FFmpeg output time

Slowdown feedback distinguishes:
- **network/producer starvation** — queue is shrinking or input rate cannot replenish it
- **renderer/device backlog** — frames are available but the device cannot display them fast enough
- **audio-only trouble** — does not suggest lowering video quality

The existing Low profile remains a user choice. There is no automatic quality downgrade.

## Renderer backlog repair

A controlled 24 FPS run before V2-04 rendered/received about **16.1 FPS** over an 8-second sample while the queue stayed full and A/V drift rose from about 81 ms to 140 ms. The old catch-up mechanism could pause the audio master clock when video fell more than 250 ms behind, making playback feel slowed.

V2-04 keeps the audio clock moving and drops bounded obsolete video frames when they are already behind the audio clock.

Post-change 8-second sample:
- audio advanced **8.02 s during 8.00 s wall time**
- about **20.4 rendered FPS** over the sample
- **27 stale frames dropped**
- final A/V drift about **80 ms**
- no rebuffer

A warm-run server summary reported substantial HTTP backpressure while the 8-second browser queue was full. That is expected throttling caused by a healthy full queue, not evidence of a slow upstream network.

## Validation

- `npm test`: 58/58 passing
- `npm run check`: passing
- `git diff --check`: passing
- real local YouTube cold/warm browser playback measured on port 8100
- production port 8099 untouched

## Still required

- Parked Tesla validation of startup preview visibility, 24 FPS catch-up behavior, audio continuity, Try Low feedback and long-session stability.


## Final isolated rerun

After restarting only the isolated v2 service on port 8100, the same representative VOD produced:

- cold source resolve: **2.44 s**
- FFmpeg start to first output: **1.25 s**
- first MJPEG frame received: **3.75 s from Play**
- first decoded picture visible: **3.82 s from Play**
- audio ready: **3.92 s from Play**
- 4-second media buffer target: **3.98 s from Play**
- synchronized playback: **3.98–3.99 s from Play**

An immediate warm-cache run produced:

- source resolve: **0 ms cache hit**
- first decoded picture: **1.29 s**
- synchronized playback: **1.51 s**
- 8-second steady sample: **23.84 rendered FPS**, audio advanced **8.01 s in 8.01 s wall time**, final A/V drift **21 ms**, **0 rebuffers**

A separate 5× CPU-throttled Chrome run forced a renderer backlog:

- receive rate: **23.89 FPS**
- rendered rate: **17.69 FPS**
- obsolete frames dropped: **62 in 10 s**
- audio advanced **10.01 s in 10.00 s wall time**
- final A/V drift: **56 ms**
- rebuffers: **0**

This confirms the catch-up policy preserves normal media time under device/render pressure instead of pausing the audio master clock.
