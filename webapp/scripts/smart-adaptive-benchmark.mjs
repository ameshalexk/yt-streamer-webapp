#!/usr/bin/env node
/*
 * Deterministic, synthetic comparison for the smart adaptive quality controller.
 * This does not contact a server, browser, media source, or device. Its KPIs are
 * outputs of the explicit simulation model below, not measurements of YT Streamer.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(WEBAPP_DIR, "..");
const BASELINE = "dfc719cf50d22c794e700d9e514d2fba546520ca";
const DT = 1;
const SWITCH_REPLAY_COST_SECONDS = 1.5;
const TRANSPORT_BUFFER = Object.freeze({
  mjpeg: Object.freeze({ targetSeconds: 2.25, startupSeconds: 3.25, maxSeconds: 7.5 }),
  webcodecs: Object.freeze({ targetSeconds: 1.0, startupSeconds: 0.35, maxSeconds: 3.0 }),
});

// Synthetic tier media demands, in bits/s. These are scenario parameters only.
const TIER_DEMAND_BPS = Object.freeze({
  mjpeg: Object.freeze({ low: 450_000, medium: 800_000, high: 1_400_000 }),
  webcodecs: Object.freeze({ low: 260_000, medium: 500_000, high: 900_000 }),
});
const DEFAULT_PROFILES = Object.freeze({
  low: Object.freeze({ height: 360, fps: 12, quality: 12 }),
  medium: Object.freeze({ height: 480, fps: 15, quality: 7 }),
  high: Object.freeze({ height: 480, fps: 24, quality: 4 }),
});
const TIER_SCORE = Object.freeze({ low: 1, medium: 2, high: 3 });
const tierAt = (value) => ["low", "medium", "high"].includes(value) ? value : "medium";
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));

function sourceAt(revision, file) {
  return execFileSync("git", ["show", `${revision}:${file}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function loadController({ label, source, eAutoSource = null }) {
  const context = vm.createContext({
    console: { debug() {}, warn() {}, error() {}, log() {} },
    Uint8Array,
    DataView,
    BigInt,
    Blob,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    AbortController,
  });
  if (eAutoSource) new vm.Script(eAutoSource, { filename: "public/e-auto.js" }).runInContext(context);
  new vm.Script(source, { filename: `${label}/public/auto-quality.js` }).runInContext(context);
  const API = context.YtAutoQuality;
  if (!API?.AutoQualityController) throw new Error(`${label}: YtAutoQuality.AutoQualityController not found`);
  return API;
}

const baselineSource = sourceAt(BASELINE, "webapp/public/auto-quality.js");
const currentSource = readFileSync(path.join(WEBAPP_DIR, "public/auto-quality.js"), "utf8");
const eAutoSource = readFileSync(path.join(WEBAPP_DIR, "public/e-auto.js"), "utf8");
const baselineAPI = loadController({ label: "baseline", source: baselineSource });
const currentAPI = loadController({ label: "working-tree", source: currentSource, eAutoSource });

const cases = [
  {
    id: "fast-slow-collapse-recovery",
    durationSeconds: 240,
    capacity: (t) => t < 35 ? 3_200_000 : t < 92 ? 330_000 : Math.min(3_200_000, 330_000 + (t - 92) * 52_000),
    upstream: () => 4_000_000,
    latency: (t) => 32 + (t % 7) * 4,
    loss: (t) => t >= 35 && t < 53 ? 0.18 : 0,
  },
  {
    id: "stable-fast-headroom",
    durationSeconds: 300,
    capacity: () => 5_000_000,
    upstream: () => 5_000_000,
    latency: (t) => 24 + (t % 8) * 2,
    loss: () => 0,
  },
  {
    id: "stable-slow-link",
    durationSeconds: 300,
    capacity: () => 1_050_000,
    upstream: () => 1_050_000,
    latency: (t) => 42 + (t % 6) * 3,
    loss: () => 0,
  },
  {
    id: "latency-jitter-loss-burst",
    durationSeconds: 180,
    capacity: (t) => 1_650_000 + [0, 500_000, -150_000, 300_000, -250_000, 100_000][t % 6],
    upstream: () => 2_500_000,
    latency: (t) => 45 + [0, 210, 18, 350, 35, 140, 12, 265][t % 8],
    loss: (t) => (t >= 42 && t < 51) ? 0.97
      : (t >= 112 && t < 119) ? 0.68
        : (t % 31 === 0 ? 0.08 : 0),
  },
  {
    id: "temporary-source-outage",
    durationSeconds: 150,
    capacity: (t) => t >= 42 && t < 50 ? 0 : 2_500_000,
    upstream: () => 3_000_000,
    latency: (t) => 35 + (t % 11) * 2,
    loss: () => 0,
  },
  {
    id: "decoder-overload-recovery",
    durationSeconds: 180,
    capacity: () => 4_000_000,
    upstream: () => 4_000_000,
    latency: (t) => 28 + (t % 5) * 3,
    loss: () => 0,
    decoder: (t) => t >= 28 && t < 104 ? 0.67 : 1.35,
  },
  {
    id: "upstream-saturation",
    durationSeconds: 180,
    capacity: () => 5_000_000,
    upstream: (t) => t >= 22 && t < 100 ? 320_000 : 5_000_000,
    latency: (t) => 38 + (t % 9) * 2,
    loss: () => 0,
  },
  {
    id: "holds-and-long-session",
    durationSeconds: 900,
    capacity: (t) => (t >= 260 && t < 310) || (t >= 570 && t < 602) ? 650_000 : 2_600_000,
    upstream: (t) => t >= 420 && t < 465 ? 700_000 : 3_000_000,
    latency: (t) => 30 + [0, 8, 25, 5, 70, 18, 40][t % 7],
    loss: (t) => (t >= 575 && t < 585) ? 0.32 : 0,
    // Repeated pause, seek/replay, background, and audio-only holds.
    state: (t) => [[92, 97], [392, 398], [792, 797]].some(([a, b]) => t >= a && t < b) ? "paused"
      : [[195, 210], [695, 708]].some(([a, b]) => t >= a && t < b) ? "background"
        : [[145, 150], [505, 510], [760, 765], [865, 870]].some(([a, b]) => t >= a && t < b) ? "seeking"
          : [[710, 724], [840, 850]].some(([a, b]) => t >= a && t < b) ? "audio-hold" : "playing",
    seek: (t) => [145, 505, 760, 865].includes(t),
  },
];

function makeController(API, label, startTime = 0) {
  let clock = startTime;
  const controller = new API.AutoQualityController({ now: () => clock });
  controller.enable?.({ tier: "medium" });
  if (!controller.enable) controller.enabled = true;
  return {
    controller,
    now: () => clock,
    advance: (seconds) => { clock += seconds * 1000; },
    label,
  };
}

function syntheticCapacityHistory() {
  const samples = [];
  return {
    add(t, bps, eligible) {
      if (eligible) samples.push({ t, bps });
      while (samples.length && t - samples[0].t > 5) samples.shift();
    },
    read(t) {
      if (!samples.length || t - samples.at(-1).t > 5) return null;
      const sorted = samples.map((sample) => sample.bps).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
  };
}

function pressureWindow(history, current) {
  history.push(current);
  while (history.length > 4) history.shift();
  const total = history.reduce((sum, row) => ({
    receive: sum.receive + row.receive,
    rendered: sum.rendered + row.rendered,
    dropped: sum.dropped + row.dropped,
    decodeMs: sum.decodeMs + row.decodeMs,
    driftMs: sum.driftMs + row.driftMs,
  }), { receive: 0, rendered: 0, dropped: 0, decodeMs: 0, driftMs: 0 });
  return {
    receivedFrames: total.receive,
    renderedFrames: total.rendered,
    droppedFrames: total.dropped,
    averageDecodeMs: total.decodeMs / Math.max(1, history.length),
    lastAvDriftMs: total.driftMs / Math.max(1, history.length),
    receiveFps: total.receive / Math.max(1, history.length),
    renderedFps: total.rendered / Math.max(1, history.length),
  };
}

function actionToTier(action) {
  return action?.to ?? action?.toTier ?? action?.tier ?? action?.target ?? null;
}

function resetControllerAfterCommit(controller) {
  controller.beginAttempt?.();
}

function applyTier(controller, tier, switched = true) {
  if (typeof controller.selectTier === "function") {
    controller.selectTier(tier, { switched });
  } else if ("tier" in controller) {
    controller.tier = tier;
  }
}

function makeInput({ transport, tier, queueSeconds, state, t, counters, history, capacityBps, measuredDeliveryBps,
  mediaBps, latencyMs, producerSpeed, renderRatio, dropRatio, averageDecodeMs, decoderQueueSize,
  queueTrend, profiles, sourceFailure }) {
  const buffer = TRANSPORT_BUFFER[transport];
  const profile = profiles[tier];
  return {
    transport,
    deliveryBps: measuredDeliveryBps,
    ...(transport === "webcodecs" ? { capacityBps } : {}),
    mediaBps,
    latencyMs,
    queueTargetSeconds: buffer.targetSeconds,
    state,
    queueSeconds,
    fps: profile.fps,
    requestedFps: profile.fps,
    profiles,
    producerSpeed,
    ...history,
    rebufferCount: counters.rebuffers,
    rebufferDurationMs: counters.rebufferDurationMs,
    droppedFrames: counters.totalDropped,
    receivedFrames: counters.totalReceived,
    renderedFrames: counters.totalRendered,
    renderedFps: profile.fps * renderRatio,
    averageDecodeMs,
    decoderQueueSize,
    decodeMs: averageDecodeMs,
    renderRatio,
    dropRatio,
    queueTrend,
    sourceFailure,
    audioOnlyPressure: state === "audio-hold",
    hidden: state === "background",
    paused: state === "paused",
    seeking: state === "seeking",
    nowMs: t * 1000,
  };
}

function baselineInput(input) {
  return {
    fps: input.fps,
    receiveFps: input.receiveFps ?? input.producerSpeed * input.fps,
    renderedFps: input.renderedFps,
    receivedFrames: input.receivedFrames,
    renderedFrames: input.renderedFrames,
    droppedFrames: input.droppedFrames,
    averageDecodeMs: input.averageDecodeMs,
    lastAvDriftMs: input.lastAvDriftMs,
    queueSeconds: input.queueSeconds,
    queueTrend: input.queueTrend,
    rebufferCount: input.rebufferCount,
    state: input.state,
    producerSpeed: input.producerSpeed,
  };
}

function runScenario(API, version, transport, spec) {
  const run = makeController(API, version);
  const controller = run.controller;
  const profiles = DEFAULT_PROFILES;
  const bufferPolicy = TRANSPORT_BUFFER[transport];
  const history = [];
  const capacityHistory = syntheticCapacityHistory();
  let tier = tierAt(controller.tier);
  let queue = Math.max(bufferPolicy.targetSeconds, bufferPolicy.startupSeconds);
  let rebufferCount = 0;
  let attemptRebufferCount = 0;
  let buffering = false;
  let bufferingFromUnderrun = false;
  let replayPenalty = 0;
  let seekingPenalty = 0;
  let totalSwitches = 0;
  let switchesByDirection = { up: 0, down: 0 };
  let switchesByReason = {};
  let switchRecords = [];
  let replayCostSeconds = 0;
  let switchUnavailableSeconds = 0;
  let rebuildingAfterSwitch = false;
  let rebufferDurationSeconds = 0;
  let attemptRebufferDurationMs = 0;
  let playingSeconds = 0;
  let pausedOrHiddenSeconds = 0;
  let totalQualityScore = 0;
  let timeAtTier = { low: 0, medium: 0, high: 0 };
  let latencyValues = [];
  let lastQueue = queue;
  let sourceLossFrames = 0;
  const counters = { rebuffers: 0, rebufferDurationMs: 0, totalReceived: 0, totalRendered: 0, totalDropped: 0 };

  for (let t = 0; t < spec.durationSeconds; t++) {
    run.advance(DT);
    const eventState = spec.state?.(t) ?? "playing";
    if (spec.seek?.(t)) {
      queue = 0;
      seekingPenalty = 1;
      buffering = true;
      bufferingFromUnderrun = false;
      rebuildingAfterSwitch = false;
      attemptRebufferCount = attemptRebufferDurationMs = 0;
      controller.beginAttempt();
    }
    const held = eventState !== "playing";
    if (held) pausedOrHiddenSeconds += DT;
    const requested = TIER_DEMAND_BPS[transport][tier];
    const pathCapacity = Math.max(0, spec.capacity(t));
    const upstreamCapacity = Math.max(0, spec.upstream(t));
    const loss = clamp(spec.loss(t), 0, 0.99);
    const effectiveCapacity = Math.min(pathCapacity, upstreamCapacity) * (1 - loss);
    const sourceFailure = pathCapacity < 1 || upstreamCapacity < 1;
    const eligibleSample = eventState === "playing" && loss < 0.10 && !sourceFailure;
    capacityHistory.add(t, pathCapacity, eligibleSample);
    const recentCapacity = capacityHistory.read(t);

    const rawProducerSpeed = requested > 0 ? effectiveCapacity / requested : 0;
    const producerSpeed = transport === "mjpeg"
      ? Math.min(1, rawProducerSpeed)
      : clamp(rawProducerSpeed, 0, 1.4);
    // Paced MJPEG reports content delivery, not spare path capacity. WebCodecs
    // segment fetches can expose a bounded burst above its current demand.
    const deliveredBps = transport === "mjpeg"
      ? Math.min(effectiveCapacity, requested)
      : Math.min(effectiveCapacity, requested * 1.4);
    const decoderSpeed = Math.max(0.1, spec.decoder?.(t) ?? 2.4);
    const renderRatio = clamp(Math.min(1, decoderSpeed / (profiles[tier].fps / 15)), 0.1, 1);
    const renderPressure = renderRatio < 0.95;
    const dropRatio = renderPressure ? clamp((1 - renderRatio) * 0.36, 0, 0.25) : 0.005;
    const averageDecodeMs = renderPressure ? 1000 / profiles[tier].fps * (1.08 + (1 - renderRatio)) : 8;
    const latencyMs = Math.max(0, spec.latency(t));
    latencyValues.push(latencyMs);
    const queueTrend = queue < lastQueue - 0.05 ? "shrinking" : queue > lastQueue + 0.05 ? "growing" : "steady";
    lastQueue = queue;

    const old = pressureWindow(history, {
      receive: held ? 0 : profiles[tier].fps * Math.min(1.4, producerSpeed),
      rendered: held ? 0 : profiles[tier].fps * renderRatio,
      dropped: held ? 0 : profiles[tier].fps * dropRatio,
      decodeMs: averageDecodeMs,
      driftMs: latencyMs * 0.12,
    });
    counters.totalReceived += old.receiveFps;
    counters.totalRendered += old.renderedFps;
    counters.totalDropped += profiles[tier].fps * dropRatio;
    sourceLossFrames += held ? 0 : profiles[tier].fps * clamp(1 - Math.min(1, producerSpeed), 0, 1);

    const stateForController = buffering ? "buffering" : eventState;
    const input = {
      transport,
      tier,
      queueSeconds: queue,
      state: stateForController,
      t,
      counters: { ...counters, rebuffers: attemptRebufferCount, rebufferDurationMs: attemptRebufferDurationMs },
      history: old,
      capacityBps: recentCapacity,
      measuredDeliveryBps: deliveredBps,
      mediaBps: requested,
      latencyMs,
      producerSpeed,
      renderRatio,
      dropRatio,
      averageDecodeMs,
      decoderQueueSize: renderPressure ? Math.ceil((1 - renderRatio) * 20) : 1,
      queueTrend,
      profiles,
      sourceFailure,
    };
    const stats = makeInput(input);
    let action;
    if (version === "baseline") action = controller.observe(baselineInput(stats));
    else action = controller.observe(stats);

    if (action?.action === "switch") {
      const target = actionToTier(action);
      if (["low", "medium", "high"].includes(target) && target !== tier) {
        const from = tier;
        const reason = String(action.reason || "unspecified");
        tier = target;
        if (controller.tier !== tier) applyTier(controller, tier, true);
        resetControllerAfterCommit(controller);
        totalSwitches++;
        const direction = TIER_SCORE[target] > TIER_SCORE[from] ? "up" : "down";
        switchesByDirection[direction]++;
        switchesByReason[reason] = (switchesByReason[reason] || 0) + 1;
        switchRecords.push({ atSeconds: t, from, to: target, direction, reason });
        attemptRebufferCount = 0;
        attemptRebufferDurationMs = 0;
        replayPenalty = SWITCH_REPLAY_COST_SECONDS;
        replayCostSeconds += SWITCH_REPLAY_COST_SECONDS;
        rebuildingAfterSwitch = true;
        queue = Math.min(queue, bufferPolicy.startupSeconds * 0.35);
        buffering = true;
        bufferingFromUnderrun = false;
      }
    }

    if (!held && rebuildingAfterSwitch) switchUnavailableSeconds += DT;
    if (held) {
      // Keep queued media frozen for pause/background/audio holds.
    } else if (replayPenalty > 0) {
      replayPenalty = Math.max(0, replayPenalty - DT);
    } else if (seekingPenalty > 0) {
      seekingPenalty = Math.max(0, seekingPenalty - DT);
    } else {
      const queueFillSpeed = transport === "mjpeg"
        ? clamp(effectiveCapacity / Math.max(1, requested) - 1, 0, 0.8)
        : Math.max(0, producerSpeed - 1);
      if (!buffering) {
        queue = clamp(queue + (producerSpeed - 1) * DT, 0, bufferPolicy.maxSeconds);
      } else {
        // MJPEG can be transport paced while an upstream buffer fills; DASH
        // uses segment throughput relative to modeled media demand.
        const fillRate = transport === "mjpeg" ? queueFillSpeed : Math.max(0, producerSpeed - 0.35);
        queue = clamp(queue + fillRate * DT, 0, bufferPolicy.maxSeconds);
        if (queue >= bufferPolicy.startupSeconds) {
          buffering = false;
          bufferingFromUnderrun = false;
          rebuildingAfterSwitch = false;
        }
      }
      if (!buffering && queue <= 0.02) {
        buffering = true;
        bufferingFromUnderrun = true;
        rebufferCount++;
        attemptRebufferCount++;
        counters.rebuffers = rebufferCount;
        queue = 0;
      }
      if (bufferingFromUnderrun) {
        rebufferDurationSeconds += DT;
        attemptRebufferDurationMs += DT * 1000;
        counters.rebufferDurationMs = rebufferDurationSeconds * 1000;
      }
    }

    if (!held && !buffering && replayPenalty === 0 && seekingPenalty === 0) {
      playingSeconds += DT;
      totalQualityScore += TIER_SCORE[tier] * DT;
      timeAtTier[tier] += DT;
    }
  }

  const latencySorted = latencyValues.slice().sort((a, b) => a - b);
  const percentile = (p) => latencySorted[Math.min(latencySorted.length - 1, Math.floor((latencySorted.length - 1) * p))] ?? null;
  return {
    scenario: spec.id,
    transport,
    controller: version,
    durationSeconds: spec.durationSeconds,
    switches: totalSwitches,
    switchesByDirection,
    switchesByReason,
    switchRecords,
    rebuffers: rebufferCount,
    rebufferDurationSeconds: round(rebufferDurationSeconds),
    timeAtTierSeconds: Object.fromEntries(Object.entries(timeAtTier).map(([key, value]) => [key, round(value)])),
    weightedQualityScore: playingSeconds ? round(totalQualityScore / playingSeconds) : null,
    playableSeconds: round(playingSeconds),
    heldSeconds: round(pausedOrHiddenSeconds),
    replayCostSeconds: round(replayCostSeconds),
    switchUnavailableSeconds: round(switchUnavailableSeconds),
    playbackPercent: round(100 * playingSeconds / Math.max(1, spec.durationSeconds)),
    sourceLimitedFrameEquivalent: round(sourceLossFrames),
    latencyP50Ms: percentile(0.50),
    latencyP95Ms: percentile(0.95),
    finalTier: tier,
  };
}

const rows = [];
for (const spec of cases) {
  for (const transport of ["mjpeg", "webcodecs"]) {
    rows.push(runScenario(baselineAPI, "baseline", transport, spec));
    rows.push(runScenario(currentAPI, "working-tree", transport, spec));
  }
}

const summary = {
  benchmark: "smart-adaptive-controller-deterministic-simulation",
  baselineRevision: BASELINE,
  workingTreeController: path.relative(REPO_ROOT, path.join(WEBAPP_DIR, "public/auto-quality.js")),
  simulationOnly: true,
  realNetworkOrDeviceAccess: false,
  assumptions: {
    tickSeconds: DT,
    tierDemandBps: TIER_DEMAND_BPS,
    transportBuffer: TRANSPORT_BUFFER,
    replayCostSecondsPerCommittedSwitch: SWITCH_REPLAY_COST_SECONDS,
    capacitySample: "WebCodecs-only synthetic median of eligible path-capacity samples no older than five seconds; MJPEG is paced and omits capacityBps.",
    producerPacing: "MJPEG producerSpeed is capped at 1.0; its queue can fill from modeled excess delivery during buffering. WebCodecs producerSpeed is capped at 1.4.",
    replayAndRecovery: "Every returned switch action is applied and starts a new attempt; it incurs a fixed 1.5s modeled replay interruption. There is no synthetic app-side bandwidth eligibility gate.",
    limitation: "All KPIs are deterministic model outputs. They do not establish actual media behavior, controller benefit, wire throughput, real queue/replay costs, or device performance.",
  },
  results: rows,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write("# Smart adaptive controller benchmark (deterministic simulation)\n\n");
  process.stdout.write(`Baseline: \`${BASELINE}\`; candidate: working-tree \`${summary.workingTreeController}\`.\n\n`);
  process.stdout.write("These are simulated KPIs from the declared deterministic model, not real streaming or device measurements.\n\n");
  process.stdout.write("| Scenario | Transport | Controller | Switches up/down | Switch reasons | Rebuffers / s | Playable % | Quality 1-3 | Low / Med / High s | Nominal / switch unavailable s | Latency p95 ms |\n");
  process.stdout.write("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n");
  for (const row of rows) {
    const reasons = Object.entries(row.switchesByReason).map(([reason, count]) => `${reason}:${count}`).join(", ") || "none";
    process.stdout.write(`| ${row.scenario} | ${row.transport} | ${row.controller} | ${row.switchesByDirection.up}/${row.switchesByDirection.down} | ${reasons} | ${row.rebuffers} / ${row.rebufferDurationSeconds} | ${row.playbackPercent} | ${row.weightedQualityScore} | ${row.timeAtTierSeconds.low} / ${row.timeAtTierSeconds.medium} / ${row.timeAtTierSeconds.high} | ${row.replayCostSeconds} / ${row.switchUnavailableSeconds} | ${row.latencyP95Ms} |\n`);
  }
  process.stdout.write("\n## Model and limitations\n\n");
  process.stdout.write(`- Tick: ${DT}s. Modeled media demand (bps): ${JSON.stringify(TIER_DEMAND_BPS)}.\n`);
  process.stdout.write(`- Buffer targets/startup/max (seconds): ${JSON.stringify(TRANSPORT_BUFFER)}. Every controller switch action is applied, resets queue to 35% of startup, and incurs ${SWITCH_REPLAY_COST_SECONDS}s of synthetic replay cost.\n`);
  process.stdout.write("- WebCodecs receives only a synthetic recent eligible capacity sample. MJPEG receives paced delivery, with producerSpeed capped at 1.0 and no capacityBps. No app-side bandwidth gate is simulated.\n");
  process.stdout.write("- The decoder supports 24 FPS normally (synthetic service factor 2.4); overload cases lower it to 0.67. This is a scenario assumption, not device characterization.\n");
  process.stdout.write("- No production endpoint, browser, network, media, or physical device is accessed. Results do not predict real throughput, interruption cost, or device performance.\n");
}
