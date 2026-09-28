import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("Tesla browser touch keeps small finger jitter as a tap", () => {
  assert.match(app, /const BROWSER_TOUCH_SCROLL_THRESHOLD_PX = 18/);
  assert.match(
    app,
    /if \(browserInputTouchScroll\) \{[\s\S]*Math\.hypot\(totalDx, totalDy\) > BROWSER_TOUCH_SCROLL_THRESHOLD_PX[\s\S]*e\.preventDefault\(\);[\s\S]*e\.stopPropagation\(\);[\s\S]*return true;/
  );
});

test("touch jitter does not fall through to remote mouse drag", () => {
  const start = app.indexOf("function handleBrowserInputPointerMove(e)");
  const end = app.indexOf("function handleBrowserInputPointerUp(e)", start);
  assert.ok(start >= 0 && end > start);
  const handler = app.slice(start, end);
  const touchBranchStart = handler.indexOf("if (browserInputTouchScroll) {");
  const drag = handler.indexOf('sendBrowserPointer("drag", e)');
  const touchReturn = handler.indexOf("return true;", touchBranchStart);
  assert.ok(touchBranchStart >= 0);
  assert.ok(touchReturn > touchBranchStart);
  assert.ok(drag > touchReturn, "mouse drag should occur only after the touch branch returns");
});

test("Tesla touch tap uses touch-down coordinates", () => {
  assert.match(app, /clientX: browserInputStartX/);
  assert.match(app, /clientY: browserInputStartY/);
  assert.match(app, /pointerType: e\.pointerType \|\| "touch"/);
});
