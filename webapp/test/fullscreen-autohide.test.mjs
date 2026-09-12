import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("periodic buffered stats do not keep waking fullscreen controls", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /markBufferedStreamPlaying\(attempt, stats, \{ revealControls: false \}\)/);
  assert.match(app, /if \(revealControls && isScreenFullscreen\(\)\) showFullscreenProgress\(\)/);
  assert.match(app, /if \(revealControls\) showFullscreenOverlays\(\{ withProgress: false \}\)/);
});

test("idle fullscreen button becomes invisible and non-interactive", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /body\.fullscreen-controls-idle #fullscreenBtn\.fullscreen-overlay \{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
});
