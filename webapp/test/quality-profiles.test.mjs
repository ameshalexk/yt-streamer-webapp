import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("V2-03 defines complete Low Medium High profiles", () => {
  assert.match(app, /low:\s*Object\.freeze\(\{ id: "low", label: "Low", height: "360", fps: "12", quality: "12" \}\)/);
  assert.match(app, /medium:\s*Object\.freeze\(\{ id: "medium", label: "Medium", height: "480", fps: "15", quality: "7" \}\)/);
  assert.match(app, /high:\s*Object\.freeze\(\{ id: "high", label: "High", height: "480", fps: "24", quality: "4" \}\)/);
});

test("quality profiles live in the shared video overlay with friendly details", () => {
  const overlay = html.match(/<div class="video-controls-overlay"[\s\S]*?<div class="screen-empty"/)?.[0] || "";
  assert.match(overlay, /id="playerQualityPresets"/);
  assert.match(overlay, /data-stream-profile="low"[\s\S]*360p · 12/);
  assert.match(overlay, /data-stream-profile="medium"[\s\S]*480p · 15/);
  assert.match(overlay, /data-stream-profile="high"[\s\S]*480p · 24/);
  assert.match(overlay, /id="playerQualityCustom"/);
  assert.doesNotMatch(overlay, /Q(?:4|7|12)/);
});

test("selected preset requires height fps and JPEG quality to all match", () => {
  assert.match(app, /profile\.height === String\(settings\.height\)[\s\S]*profile\.fps === String\(settings\.fps\)[\s\S]*profile\.quality === String\(settings\.quality\)/);
  assert.match(app, /custom\.hidden = Boolean\(current\)/);
});

test("profile choice persists and rapid taps are coalesced", () => {
  assert.match(app, /STREAM_QUALITY_PROFILE_KEY = "ytStreamerQualityProfileV2"/);
  assert.match(app, /localStorage\.setItem\(STREAM_QUALITY_PROFILE_KEY, profile\.id\)/);
  assert.match(app, /clearTimeout\(qualitySwitchTimer\)/);
  assert.match(app, /qualitySwitchGeneration/);
  assert.match(app, /setTimeout\(\(\) => performQualityProfileSwitch\(transition\), STREAM_QUALITY_SWITCH_DELAY_MS\)/);
  assert.match(app, /replayFn !== transition\.replay/);
});

test("quality restart preserves position and paused intent and reports live restart", () => {
  assert.match(app, /streamReplayTime\(playbackPaused \? pausedResumeAt : getStreamCurrentTime\(\)\)/);
  assert.match(app, /pendingQualityRestore/);
  assert.match(app, /maybeRestorePlaybackAfterQualitySwitch\(attempt\)/);
  assert.match(app, /if \(currentAttempt\(attempt\) && !playbackPaused\) pausePlayback\(\)/);
  assert.match(app, /Returning to live/);
});

test("downloaded-library profiles choose and report an explicit supported fallback", () => {
  assert.match(app, /function legacyProfileHeightFallback/);
  assert.match(app, /available\.filter\(\(value\) => value <= requested\)/);
  assert.match(app, /unavailable, using/);
});
