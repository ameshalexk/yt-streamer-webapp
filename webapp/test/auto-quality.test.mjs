import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

await import("../public/e-auto.js");
await import("../public/auto-quality.js");

const { AutoQualityController, BUFFER_POLICIES } = globalThis.YtAutoQuality;
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function harness({ tier = "medium", transport = "webcodecs" } = {}) {
  let now = 0, frames = 0, drops = 0;
  const controller = new AutoQualityController({ now: () => now });
  controller.enable({ tier });
  return {
    controller,
    step(overrides = {}, seconds = 1) {
      now += seconds * 1000;
      const fps = ({ low: 12, medium: 15, high: 24 })[controller.tier];
      frames += overrides.frames ?? fps;
      drops += overrides.drops ?? 0;
      return controller.observe({
        transport, state: "playing", fps, renderedFrames: frames, droppedFrames: drops,
        averageDecodeMs: 5, decoderQueueSize: 0, queueSeconds: transport === "webcodecs" ? 0.34 : 3,
        queueTargetSeconds: transport === "webcodecs" ? 0.30 : 2,
        producerSpeed: 1, capacityBps: transport === "webcodecs" ? 6e6 : null, mediaBps: 850000,
        deliveryBps: 860000, latencyMs: 25, rebufferCount: 0, rebufferDurationMs: 0,
        ...overrides,
      });
    },
  };
}

function run(h, seconds, sample) {
  const decisions = [];
  for (let n = 0; n < seconds; n++) {
    const result = h.step(typeof sample === "function" ? sample(n) : sample);
    if (result) {
      decisions.push(result);
      h.controller.beginAttempt();
    }
  }
  return decisions;
}

test("Auto keeps the existing transport buffer policies and starts at Medium", () => {
  assert.equal(harness().controller.tier, "medium");
  assert.deepEqual(BUFFER_POLICIES.low, {
    id: "auto-low", startupSeconds: 3.5, rebufferSeconds: 2.25, maxQueueSeconds: 7,
  });
  assert.equal(BUFFER_POLICIES.medium.maxQueueSeconds, 6);
  assert.equal(BUFFER_POLICIES.high.maxQueueSeconds, 8);
});

test("WebCodecs can upgrade with a healthy short decoded queue and paced production", () => {
  const h = harness();
  assert.equal(run(h, 20).length, 0);
  const [decision] = run(h, 10);
  assert.deepEqual([decision?.from, decision?.to, decision?.reason], ["medium", "high", "stable-headroom"]);
  assert.ok(decision.metrics.sustainableBps > decision.metrics.candidateBps);
});

test("capacity disappearance and long callback gaps cannot finish an upgrade dwell", () => {
  const h = harness();
  assert.equal(run(h, 18).length, 0);
  assert.equal(h.step({ capacityBps: null }, 80), null);
  assert.equal(run(h, 20, { capacityBps: null }).length, 0);
  assert.equal(h.controller.tier, "medium");
});

test("sustained collapse downshifts and later headroom restores quality after rebuffers", () => {
  const h = harness({ tier: "high" });
  run(h, 12);
  const collapse = { frames: 5, producerSpeed: 0.4, queueSeconds: 0.02, capacityBps: 250000, deliveryBps: 240000 };
  assert.equal(run(h, 2, collapse).length, 0);
  const down = run(h, 10, (i) => ({ ...collapse, state: "buffering", rebufferCount: i > 1 ? 2 : 1,
    rebufferDurationMs: i * 1000 }));
  assert.ok(down.length >= 1);
  assert.equal(down[0].to, "medium");
  const up = run(h, 125, { capacityBps: 8e6, rebufferCount: 2, rebufferDurationMs: 2000 });
  assert.equal(up.at(-1)?.to, "high");
  assert.ok(h.controller.getTelemetry().adaptiveRebuffers >= 2);
  assert.ok(h.controller.getTelemetry().adaptiveRebufferMs >= 2000);
});

test("a video stall needs delivery evidence and a fresh burst does not oscillate", () => {
  const h = harness();
  const weak = { frames: 10, producerSpeed: 0.55, queueSeconds: 0.09, capacityBps: 700000 };
  const good = { capacityBps: 2200000 };
  assert.deepEqual(run(h, 72, (n) => n % 6 === 1 ? weak : good), []);
  assert.deepEqual(run(h, 12, { state: "buffering", frames: 0, rebufferCount: 4, capacityBps: null,
    queueSeconds: 0.3, producerSpeed: 1 }), []);
});

test("available input plus decoder pressure downshifts independently of network", () => {
  const h = harness({ tier: "high" });
  const down = run(h, 16, { frames: 11, drops: 7, decoderQueueSize: 8, queueSeconds: 0.65 });
  assert.equal(down[0]?.reason, "device-overload");
  assert.equal(down[0]?.to, "medium");
});

test("upstream and audio failures, startup, pause, offline and background do not train pressure", () => {
  const h = harness();
  const weak = { frames: 2, producerSpeed: 0.2, queueSeconds: 0, capacityBps: 150000 };
  for (const flags of [{ sourceFailure: true }, { audioOnlyPressure: true }, { hidden: true },
    { paused: true }, { offline: true }, { sourceEnded: true }, { transitioning: true },
    { state: "buffering", renderedFrames: 0 }, { adaptiveEligible: false }]) {
    assert.deepEqual(run(h, 12, { ...weak, ...flags }), []);
  }
  assert.equal(h.controller.tier, "medium");
  assert.equal(run(h, 10).length, 0);
});

test("MJPEG only tries a paced upgrade after prolonged health and projected decode headroom", () => {
  const h = harness({ transport: "mjpeg", tier: "low" });
  assert.deepEqual(run(h, 90, { averageDecodeMs: 28 }), []);
  assert.deepEqual(run(h, 55), []);
  const upgrade = run(h, 20).at(-1);
  assert.equal(upgrade?.to, "medium");
  assert.equal(upgrade?.reason, "paced-delivery-trial");
  assert.equal(upgrade?.metrics.sustainableBps, null);
});

test("missing next rendition or an unchanged WebCodecs rendition does not restart playback", () => {
  const h = harness();
  const medium = { height: 480, fps: 15, quality: 7 };
  assert.deepEqual(run(h, 40, { profiles: { medium } }), []);
  assert.deepEqual(run(h, 40, { profiles: { medium, high: { ...medium, quality: 4 } } }), []);
});

test("an uncommitted app switch can be canceled without counting a quality change", () => {
  const h = harness();
  let decision;
  while (!decision) decision = h.step();
  h.controller.cancelSwitch(decision);
  assert.equal(h.controller.tier, "medium");
  assert.equal(h.controller.getTelemetry().adaptiveUpgrades, 0);
});

test("Auto UI is separate from Low Medium High and is persisted as a mode", () => {
  assert.match(html, /data-stream-profile="auto"[^>]*>[\s\S]*?<strong>Auto<\/strong><small>Adaptive<\/small>/);
  assert.match(html, /id="qualityQuick"[\s\S]*data-stream-profile="auto"/);
  assert.match(app, /AUTO_STREAM_QUALITY_ID = "auto"/);
  assert.match(app, /localStorage\.setItem\(STREAM_QUALITY_PROFILE_KEY, streamQualitySelection\)/);
  assert.match(app, /auto_quality_switch/);
  assert.match(app, /maybeAdaptAutoQuality\(stats\)/);
});

test("manual Low Medium High profiles remain unchanged", () => {
  assert.match(app, /low:\s*Object\.freeze\(\{ id: "low", label: "Low", height: "360", fps: "12", quality: "12" \}\)/);
  assert.match(app, /medium:\s*Object\.freeze\(\{ id: "medium", label: "Medium", height: "480", fps: "15", quality: "7" \}\)/);
  assert.match(app, /high:\s*Object\.freeze\(\{ id: "high", label: "High", height: "480", fps: "24", quality: "4" \}\)/);
});

test("each new video resets to Auto while manual tiers stay current-video only", () => {
  assert.match(app, /function resetStreamSettings\(\{ persist = true \} = \{\}\)[\s\S]*setStreamQualitySelection\(AUTO_STREAM_QUALITY_ID/);
  assert.match(app, /function beginNewPlaybackQuality\(\)[\s\S]*resetStreamSettings\(\{ persist: true \}\)/);
  assert.match(app, /async function streamYoutubeSearchResult[\s\S]*?beginNewPlaybackQuality\(\)/);
  assert.match(app, /async function streamRecommendation[\s\S]*?beginNewPlaybackQuality\(\)/);
});

test("Auto quality changes stay silent and WebCodecs feeds Auto telemetry", () => {
  assert.match(app, /silent: Boolean\(transition\.silentToast\)/);
  assert.match(app, /if \(!transition\.silentToast\) \{[\s\S]*Changing quality/);
  assert.match(app, /onStats\(stats\) \{[\s\S]*maybeAdaptAutoQuality\(stats\)/);
});
