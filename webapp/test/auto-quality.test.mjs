import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

await import("../public/auto-quality.js");

const { AutoQualityController, BUFFER_POLICIES } = globalThis.YtAutoQuality;
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function strongStats({ fps = 15, queueSeconds = 4, renderedFrames = 180 } = {}) {
  return {
    state: "playing",
    fps,
    receiveFps: fps * 1.2,
    renderedFps: fps,
    producerSpeed: 1.2,
    renderedFrames,
    receivedFrames: renderedFrames + fps * 3,
    droppedFrames: 0,
    averageDecodeMs: 8,
    lastAvDriftMs: 40,
    queueSeconds,
    queueTrend: "growing",
    rebufferCount: 0,
  };
}

test("v2.1 Auto exposes dedicated buffer policies for all quality tiers", () => {
  assert.deepEqual(BUFFER_POLICIES.low, {
    id: "auto-low",
    startupSeconds: 3.5,
    rebufferSeconds: 2.25,
    maxQueueSeconds: 7,
  });
  assert.equal(BUFFER_POLICIES.medium.maxQueueSeconds, 6);
  assert.equal(BUFFER_POLICIES.high.maxQueueSeconds, 8);
});

test("Auto starts at Medium and upgrades only after sustained headroom", () => {
  let now = 0;
  const controller = new AutoQualityController({ now: () => now });
  controller.enable();
  assert.equal(controller.tier, "medium");

  assert.equal(controller.observe(strongStats()), null);
  now = 17_000;
  assert.equal(controller.observe(strongStats()), null);
  now = 18_100;
  const decision = controller.observe(strongStats());
  assert.equal(decision?.from, "medium");
  assert.equal(decision?.to, "high");
  assert.equal(decision?.reason, "stable-headroom");
});

test("Auto drops one tier immediately after a rebuffer", () => {
  let now = 1000;
  const controller = new AutoQualityController({ now: () => now });
  controller.enable({ tier: "high" });
  const decision = controller.observe({
    ...strongStats({ fps: 24, queueSeconds: 0.5 }),
    state: "buffering",
    rebufferCount: 1,
  });
  assert.equal(decision?.from, "high");
  assert.equal(decision?.to, "medium");
  assert.equal(decision?.reason, "rebuffer");
});

test("Auto can detect delivery pressure before a full stall", () => {
  let now = 1000;
  const controller = new AutoQualityController({ now: () => now });
  controller.enable({ tier: "medium" });
  const decision = controller.observe({
    state: "playing",
    fps: 15,
    receiveFps: 10,
    renderedFps: 14.8,
    producerSpeed: 0.67,
    renderedFrames: 100,
    receivedFrames: 100,
    droppedFrames: 0,
    averageDecodeMs: 8,
    lastAvDriftMs: 30,
    queueSeconds: 0.6,
    queueTrend: "shrinking",
    rebufferCount: 0,
  });
  assert.equal(decision?.to, "low");
  assert.equal(decision?.reason, "delivery-slow");
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
