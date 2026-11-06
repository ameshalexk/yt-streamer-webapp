# Buffer Lab: experimental WebCodecs VOD buffering

**Status: draft only — do not merge or deploy.** Default remains the existing player on both Mac and StreamHA.

## Enable and immediately revert

1. In **Video mode**, choose **WebCodecs** (the existing MJPEG default is unchanged).
2. Enable **Buffer Lab (experimental)**. The setting is stored only in that browser under `ytStreamerBufferLabV1=1`.
3. Uncheck it to revert to the standard buffer for the next/current WebCodecs stream. If a video is playing, switching restarts it at the saved position. Paused playback is preserved by the existing playback-method restore path.
4. Disabling the flag never changes stored videos, stream source, Home Assistant settings or server-wide configuration.

The flag is **off on all browsers unless explicitly enabled**. JXL, MJPEG, prepared/static DASH, non-seekable live and source-managed playback use their existing pipelines. FFmpeg receives `bufferLab: true` only from an explicit WebCodecs dynamic-VOD start request. Production is unchanged until a separately authorized deployment.

## Candidate changes when enabled

- A bounded, ordered **compressed fMP4 segment reserve** separates fetching from decoding: maximum **36 fragments** (approximately **18 source seconds** with 0.5s segments) and **24 MiB per track**; separate video and audio pumps with four concurrent segment HTTP requests each.
- The **decoded** video/PCM lead is limited to approximately **4 source seconds at 1×**; VideoDecoder in-flight queue pressure is reduced from 40 to 8. This is not 18 seconds of uncompressed frames in Tesla RAM.
- FFmpeg reads a normal-speed source at up to **2×** instead of the existing **1.15×** read pacing; an initial burst of up to 8s is permitted where the installed FFmpeg supports it. Faster *actual* production depends on CPU and upstream delivery. Existing faster playback settings are not reduced.
- Startup waits for 1.25 seconds of video/audio and a stall refills to 2 seconds, trading a little startup time for resilience.
- With capacity/decoder evidence, Auto can downshift sooner and consider a measured upshift when at least 6 seconds of compressed video are queued, even if the decoded VideoFrame queue stays short. Manual quality choices and existing non-lab decisions are unchanged.

## Limitations and acceptance

- Quality changes **still rebuild the current single-representation FFmpeg session**. Holding the previous frame does not guarantee a seamless switch; true multibitrate DASH + MSE requires its own isolated prototype and Tesla capability testing.
- A source/encoder that cannot stay ahead of real time cannot accumulate the full reserve. The finite reserve cannot cure a permanent outage or broken hardware decoder.
- Segment-fetch concurrency costs network and memory; two separate audio/video track reserves may coexist. Avoid enabling on low-memory browsers before physical checks.
- A decoder backlog still invokes existing recovery if progress stops. This change reduces pressure; it does not guarantee every decoder freeze is solved.
- Required before merge/deploy: **Both platforms passed** exact-head CI, macOS + Linux/amd64 + arm64 coverage, simulated loss/jitter/throughput and long-play tests, verified audio/video sync, CPU/RSS, independent test on physical Tesla and iPhone, and explicit release approval. Do not assume the local Chrome fixture proves Tesla readiness.

## Local checks

```sh
cd webapp
npm ci
npm run check
npm test
node scripts/mobile-player-browser-check.mjs
node scripts/buffer-lab-browser-check.mjs
```

The isolated tests use only localhost; no release artifact is generated. Compare against standard WebCodecs with the toggle off using the same videos, network conditions, time-to-first-frame, rebuffer duration/count, quality transitions, A/V drift and peak memory.
