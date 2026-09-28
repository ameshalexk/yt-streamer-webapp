import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const browser = fs.readFileSync(new URL("../src/lib/browser-renderer.js", import.meta.url), "utf8");
const realChrome = fs.readFileSync(new URL("../src/lib/real-chrome-renderer.js", import.meta.url), "utf8");

test("Real Chrome reuses the virtual fullscreen shim", () => {
  assert.match(browser, /export const FULLSCREEN_SHIM = `\(\(\) => \{/);
  assert.match(realChrome, /import \{ FULLSCREEN_SHIM \} from "\.\/browser-renderer\.js";/);
  assert.match(realChrome, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(realChrome, /source: FULLSCREEN_SHIM/);
  assert.match(realChrome, /runImmediately: true/);
  assert.match(realChrome, /Runtime\.evaluate[\s\S]*expression: FULLSCREEN_SHIM/);
  assert.match(realChrome, /await installFullscreenShim\(session, cdp\);/);
});

test("remote touch taps normalize to one deterministic desktop mouse activation", () => {
  const start = realChrome.indexOf("async function dispatchRealChromeTap");
  const end = realChrome.indexOf("export async function input", start);
  const tap = start >= 0 && end > start ? realChrome.slice(start, end) : "";
  assert.doesNotMatch(tap, /Input\.dispatchTouchEvent/);
  assert.match(tap, /type: "mousePressed"/);
  assert.match(tap, /type: "mouseReleased"/);
  assert.equal((tap.match(/Input\.dispatchMouseEvent/g) || []).length, 2);
});

test("Real Chrome disables touch emulation for desktop click semantics", () => {
  assert.match(realChrome, /Emulation\.setTouchEmulationEnabled", \{ enabled: false \}/);
});
