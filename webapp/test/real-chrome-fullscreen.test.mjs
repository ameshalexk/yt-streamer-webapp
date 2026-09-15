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
  const tap = realChrome.match(/if \(payload\.type === "tap"\) \{[\s\S]*?\n  \}/)?.[0] || "";
  const touchBranch = tap.match(/if \(payload\.pointerType === "touch"\) \{[\s\S]*?return \{ ok: true \};\n    \}/)?.[0] || "";
  assert.match(touchBranch, /Input\.dispatchTouchEvent/);
  assert.doesNotMatch(touchBranch, /Input\.dispatchMouseEvent/);
  assert.match(tap, /Input\.dispatchMouseEvent/);
});
