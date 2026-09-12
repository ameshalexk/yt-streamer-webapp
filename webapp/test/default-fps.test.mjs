import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("YT Streamer defaults new playback to 24 FPS", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const buffered = fs.readFileSync(new URL("../public/buffered-mjpeg.js", import.meta.url), "utf8");
  assert.match(app, /const DEFAULT_STREAM_SETTINGS = \{[\s\S]*fps: "24"/);
  assert.match(app, /parsed\.searchParams\.get\("fps"\) \|\| \$\("#ctlFps"\)\.value \|\| 24/);
  assert.match(html, /value="24" selected>24 risky<\/option>/);
  assert.doesNotMatch(html, /value="12" selected>12<\/option>/);
  assert.match(buffered, /Number\(fps\) \|\| 24/);
});

test("12 FPS remains available as an explicit selectable option", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /<option value="12">12<\/option>/);
  assert.match(app, /\{ value: "12", label: "12" \}/);
});
