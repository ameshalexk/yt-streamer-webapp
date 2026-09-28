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

test("touch taps do not send a second explicit mouse activation", () => {
  const start = realChrome.indexOf("async function dispatchRealChromeTap");
  const end = realChrome.indexOf("export async function input", start);
  const tap = start >= 0 && end > start ? realChrome.slice(start, end) : "";
  const touchStart = tap.indexOf('if (payload.pointerType === "touch") {');
  const touchEnd = tap.indexOf('return { ok: true };', touchStart);
  const touchBranch = touchStart >= 0 && touchEnd > touchStart
    ? tap.slice(touchStart, touchEnd + 'return { ok: true };'.length)
    : "";
  assert.match(touchBranch, /Input\.dispatchTouchEvent/);
  assert.doesNotMatch(touchBranch, /Input\.dispatchMouseEvent/);
  assert.match(tap.slice(touchEnd), /Input\.dispatchMouseEvent/);
});
