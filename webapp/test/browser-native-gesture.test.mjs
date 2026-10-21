import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL("../public/" + name, import.meta.url), "utf8");
const css = read("styles.css");
const app = read("app.js");
const html = read("index.html");

test("browser frame image cannot be dragged while remote touch is active", () => {
  assert.match(html, /<img id="mjpeg" alt="" draggable="false"/);
  assert.match(css, /\.screen\.browser-input-active > :is\(video, img, canvas\)\s*\{[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.screen\.browser-input-active > :is\(video, img, canvas\)\s*\{[^}]*-webkit-user-drag:\s*none;/);
  assert.match(css, /\.screen\.browser-input-active\s*\{[^}]*touch-action:\s*none;/);
});

test("viewport touch swipes cancel native dragging without blocking controls", () => {
  const touch = app.slice(app.indexOf('screen.addEventListener("touchmove", (e) => {'));
  assert.match(touch, /browserNativeTouchMove\(e\)/);
  assert.match(app, /function browserTouchEventAllowed\(e\)/);
  assert.match(app, /e\.target\?\.closest\?\.\("button, input, select, textarea, a, \[role=button\]/);
  assert.match(app, /if \(e\.cancelable\) e\.preventDefault\(\)/);
  assert.match(touch, /passive: false/);
  assert.match(app, /screen\.addEventListener\("dragstart"/);
});

test("remote Chrome mouse-wheel dispatch and tap path are still wired", () => {
  assert.match(app, /sendBrowserScrollFromClient\(e\.clientX, e\.clientY, dx \* 1\.8, dy \* 1\.8\)/);
  assert.match(app, /sendBrowserPointer\("tap"/);
});
