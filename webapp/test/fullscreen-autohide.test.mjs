import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("periodic buffered stats do not keep waking fullscreen controls", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /markBufferedStreamPlaying\(attempt, stats, \{ revealControls: false \}\)/);
  assert.match(app, /if \(revealControls\) showFullscreenOverlays\(\{ withProgress: false \}\)/);
});

test("one shared player owns seek/pause and persistent in-player quality access", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const overlay = html.match(/<div class="video-controls-overlay"[\s\S]*?<div class="screen-empty"/)?.[0] || "";
  assert.match(overlay, /id="pauseBtn"/);
  assert.match(overlay, /id="muteBtn"/);
  assert.match(overlay, /id="fullscreenBtn"/);
  assert.match(overlay, /id="streamSeek"/);
  assert.match(overlay, /id="liveSeekStatus"/);
  assert.match(html, /id="playerQualityBtn"[^>]*aria-expanded="false"[^>]*aria-controls="playerQualityPanel"/);
  assert.match(html, /id="playerQualitySlot"[^>]*data-v2-story="quality-presets"/);
  assert.match(html, /id="playerQualityPresets"/);
  assert.doesNotMatch(overlay, /id="playerQualitySlot"/);
  assert.match(html, /id="playerQualityPanel"[^>]*hidden/);
  for (const id of ["pauseBtn", "muteBtn", "fullscreenBtn", "streamSeek"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must have one shared instance`);
  }
});

test("idle player overlay becomes invisible and non-interactive", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /body\.fullscreen-controls-idle \.video-controls-overlay \{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.video-control-btn \{[^}]*min-height:\s*52px;/s);
  const mobileCss = fs.readFileSync(new URL("../public/mobile-player-fixes.css", import.meta.url), "utf8");
  assert.match(mobileCss, /\.screen > \.player-quality-trigger/);
  assert.match(mobileCss, /\.screen:not\(\.playing\) > \.player-quality-trigger/);
  assert.match(mobileCss, /\.player-quality-panel \.player-quality-btn \{[^}]*min-height:\s*46px;/s);
  assert.match(mobileCss, /@media \(max-width: 520px\)[\s\S]*\.player-quality-panel \.player-quality-presets/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.stream-badge \{[^}]*top:\s*8px;[^}]*bottom:\s*auto;/s);
});

test("auto-hide is limited to uninterrupted playback", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /FULLSCREEN_OVERLAY_HIDE_MS = 5000/);
  assert.match(app, /!screen\.classList\.contains\("loading"\)/);
  assert.match(app, /!screen\.classList\.contains\("controls-interacting"\)/);
  assert.match(app, /!playbackPaused/);
  assert.match(app, /!noticeVisible/);
});

test("a tap from the hidden state reveals controls without toggling playback", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /fullscreenTapRevealOnly = canAutoHideScreenOverlays\(\)[\s\S]*document\.body\.classList\.contains\("fullscreen-controls-idle"\)/);
  assert.match(app, /if \(fullscreenTapRevealOnly\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*return;[\s\S]*\}/);
});

test("release outside the overlay and resting keyboard focus cannot strand controls", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /document\.addEventListener\("pointerup", finishVideoControlsPointer, true\)/);
  assert.match(app, /document\.addEventListener\("pointercancel", finishVideoControlsPointer, true\)/);
  assert.match(app, /videoControlsOverlay\.addEventListener\("focusin", \(\) => showFullscreenOverlays\(\)\)/);
  assert.match(app, /videoControlsOverlay\.addEventListener\("keydown", \(\) => showFullscreenOverlays\(\)\)/);
  assert.doesNotMatch(app, /videoControlsOverlay\.addEventListener\("focusin", beginScreenControlInteraction\)/);
});
