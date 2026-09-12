import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("slow buffering suggestion uses requested 360p 15fps quality 5 profile", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /SLOW_BUFFER_PROFILE = \{ height: "360", fps: "15", quality: "5" \}/);
  assert.match(app, /SLOW_BUFFER_STARTUP_SUGGEST_MS = 20000/);
  assert.match(app, /SLOW_BUFFER_REBUFFER_SUGGEST_MS = 12000/);
  assert.match(app, /SLOW_BUFFER_SUGGESTION_VISIBLE_MS = 10000/);
  assert.match(app, /replayFn\(resumeAt\)/);
});

test("slow buffering suggestion has a 10-second animated countdown and explicit actions", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /id="slowBufferSuggestion"/);
  assert.match(html, /<option value="5">Q5<\/option>/);
  assert.match(html, /data-quality-value="5">Q5<\/button>/);
  assert.match(html, /Use 360p · 15fps · Q5/);
  assert.match(html, /id="slowBufferDismissBtn"/);
  assert.match(html, /id="slowBufferCountdownText">10</);
  assert.match(css, /animation: slow-buffer-countdown-ring 10s linear forwards/);
  assert.match(css, /@keyframes slow-buffer-countdown-ring/);
});

test("audio-only buffering does not trigger a video-quality suggestion", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /if \(reason === "audio"\) return/);
  assert.match(app, /if \(detail\.reason === "audio"\) cancelSlowBufferSuggestionSchedule\(\)/);
});
