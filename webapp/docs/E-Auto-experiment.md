# Smart Adaptive Quality v3

Status: review candidate. Mac baseline: v2.1.0, `dfc719cf50d22c794e700d9e514d2fba546520ca` (also the GitHub base). Production asset hashes for the previous controller, E-Auto primitives, app, and recovery monitor matched that commit. In the existing playback log, all 11 Auto changes were Medium → Low: 4 rebuffer, 4 device-overload, 3 slow delivery. Several WebCodecs samples had about 0.29–0.34 seconds queued while still rendering near target. The old controller expected 3.48 seconds queued at Medium, 4.06 at Low, producer speed of at least 1.10×, and no prior rebuffer within that attempt. Those gates confused a short decoded queue or a paced producer with a lack of upgrade headroom. Cumulative drop history and render rate also made starvation look like device load.

The original [E-Auto transport experiment](https://github.com/ameshalexk/yt-streamer-webapp/blob/experimental/e-auto/webapp/docs/E-Auto-experiment.md) is a separate branch. The v3 controller reuses its fast/slow EWMA primitives; it does not enable EAJF, change transports, or add a dependency. The time-based EWMA now uses actual half-lives (3 and 9 seconds for the dual estimator).

## How decisions work

- **WebCodecs:** Samples successful dynamic video segment fetches, including time to headers. Short transfers use a conservative elapsed-time floor; very small segments, init, and prepared-cache responses do not provide capacity evidence. The lower of the fast/slow EWMAs is discounted for latency or volatility, then compared with the next tier's encoder peak budget plus an audio reserve. The decoded-buffer target comes from the engine. A waiting server producer, low rendered FPS on an empty queue, and audio-only refill do not by themselves justify a downshift.
- **MJPEG:** Measures delivered bytes per wall second and JPEG payload per media second. Continuous, paced HTTP cannot measure spare link capacity; the controller displays delivered throughput separately. Candidate demand scales recent content cost by output pixel rate and JPEG quality. Sustained delivery and device headroom can authorize an upgrade; a healthy paced stream may attempt a single-tier trial after a longer dwell. Failed trials back off. JPEG decode time and frame-drop deltas help separate the renderer from delivery starvation.
- **Both:** The controller requires consecutive healthy samples to upgrade, upgrades one tier at a time, skips an intermediate restart when delivery collapses well below it, uses faster downshift holds, and lets healthy playback recover after a previous rebuffer. A startup, pause, seek, hidden tab, offline state, source failure, audio-only repair, or an in-progress switch does not qualify as quality pressure. The controller leaves prepared/static WebCodecs, non-seekable live and source-managed/native playback on their existing paths. Manual presets remain available; new videos still start in Auto at Medium.
- **Switch and recovery:** Automatic decisions leave the renderer callback, recheck source/attempt ownership and user state, then sample the current position and rebuild at that position. The old canvas pixels are retained during the same-source replacement. A seek, new source or Stop invalidates the transition; stale callbacks cannot report it as completed. Failed targets return to the previous profile before normal recovery. Recovery samples actual rendered video progress, skips video retry while a quality replacement is starting, and keeps capped backoff across replays. Existing independent MJPEG audio repair stays independent.

## Switching limitation

This is a single-session rebuild. The held frame reduces blanking; playback still freezes until the replacement renders and the audio path still restarts. The server creates a new encoder session at the new quality. Overlapping would require concurrently encoded tracks, a shared timeline and audio clock handoff, and a combined memory/encoder budget; reusing a previous audio clock without validating timestamps can increase drift. V3 deliberately keeps one browser decoding pipeline and does not increase buffer ceilings. No seamless claim.

## Diagnostics

The existing playback log and copyable diagnostics record effective frame size/FPS, delivery and available sustainable-rate estimates, buffer and depletion, switch reason, attempted upgrades/downgrades, active time by tier, rebuffer count/time, first replacement frame delay, frame drops, decode pressure, drift, and recovery outcomes. Video-only capacity is omitted when unmeasurable. The new switch events have no media URLs; the server allowlists scalar adaptive fields and keeps the existing rotating log bound. A recovery request, launched replay, and actual replacement frame are different events.

## Upstream references

The implementation is original and uses no third-party source from these projects. [hls.js ABR controller](https://github.com/video-dev/hls.js/blob/master/src/controller/abr-controller.ts) ([Apache-2.0](https://github.com/video-dev/hls.js/blob/master/LICENSE)) informed the conservative dual estimate, separate upgrade/downshift behavior, and starvation/latency risk. [dash.js ABR](https://dashif.org/dash.js/pages/usage/abr/) ([BSD-3-Clause](https://github.com/Dash-Industry-Forum/dash.js/blob/development/LICENSE.md)) informed separate buffer, throughput, and dropped-frame signals; BOLA itself is not applied to the short decoded queue. [Shaka SimpleAbrManager](https://shaka-player.github.io/shaka-player/docs/api/lib_abr_simple_abr_manager.js.html) ([Apache-2.0](https://github.com/shaka-project/shaka-player/blob/main/LICENSE)) informed variant eligibility, margins, and switch intervals.

## Reproduce and roll back

From `webapp` with the baseline commit available locally:

```sh
npm ci
npm run check
npm test
node scripts/smart-adaptive-benchmark.mjs
node scripts/smart-adaptive-benchmark.mjs --json
```

The deterministic model compares the exact production controller and candidate under the same inputs and transport/restart assumptions; it cannot establish real playback, network, CPU, memory, or sync performance. The shared release workflow also runs a loopback Chrome fixture with local FFmpeg media and a delayed replacement to compare blank frames and position continuity. It is muted and measures an intentionally triggered switch, so it does not certify live network ABR or audible sync. Physical iPhone Safari, Tesla, HA runtime, and matched sustained CPU/RSS and A/V acceptance remain deployment gates.

The draft does not publish a release. Before any installation, reconcile open draft PRs #138–#141 and obtain explicit approval. To roll back an eventual installation, restore the previously verified release for each host using the existing rollback procedure, retaining live data, HA options, and the signed Mac audio helper; verify the revision and playback on both hosts. If only the code has merged, revert the PR in source; this alone does not change any installed runtime.
