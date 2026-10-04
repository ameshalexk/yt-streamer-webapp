import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { enqueueBrowserInput } from "../src/lib/browser-input-queue.js";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = fs.readFileSync(new URL("../src/lib/real-chrome-renderer.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  let brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function makeCancelHarness({ pointerType = "touch", tracked = true, touchScroll = true } = {}) {
  const calls = [];
  const pointerId = 7;
  const context = {
    browserInputPointerId: tracked ? pointerId : 99,
    browserInputTouchScroll: touchScroll,
    browserInputTouchMoved: false,
    browserInputMouseDragging: pointerType === "mouse",
    browserInputStartEvent: pointerType === "mouse" ? { clientX: 10, clientY: 10, button: 0, pointerType: "mouse" } : null,
    browserZoom: {
      pointers: new Map(tracked ? [[pointerId, { clientX: 10, clientY: 10 }]] : []),
      pinching: pointerType !== "mouse",
    },
    sendBrowserPointer(type, event) {
      calls.push({ type, event });
      return true;
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(app, "handleBrowserInputPointerCancel"), context);
  const event = {
    pointerId,
    pointerType,
    clientX: 10,
    clientY: 10,
    currentTarget: { releasePointerCapture() {} },
    preventDefault() { calls.push({ type: "preventDefault" }); },
    stopPropagation() { calls.push({ type: "stopPropagation" }); },
  };
  return { context, calls, event };
}

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

test("browser touch mode disables native browser gesture handling", () => {
  assert.match(css, /\.screen\.browser-input-active\s*\{[\s\S]*?touch-action:\s*none;/);
});

test("cancelled touch never becomes a remote tap", () => {
  const { context, calls, event } = makeCancelHarness({ pointerType: "touch", tracked: true, touchScroll: true });
  assert.equal(context.handleBrowserInputPointerCancel(event), true);
  assert.equal(calls.some((call) => call.type === "tap"), false);
  assert.equal(calls.some((call) => call.type === "up"), false);
  assert.equal(context.browserInputPointerId, null);
  assert.equal(context.browserZoom.pointers.size, 0);
  assert.equal(context.browserZoom.pinching, false);
  assert.equal(context.browserInputTouchMoved, true);
});

test("cancelled mouse gesture releases remote mouse button once", () => {
  const { context, calls, event } = makeCancelHarness({ pointerType: "mouse", tracked: true, touchScroll: false });
  assert.equal(context.handleBrowserInputPointerCancel(event), true);
  assert.equal(calls.filter((call) => call.type === "up").length, 1);
  assert.equal(calls.some((call) => call.type === "tap"), false);
});

test("untracked pointer cancellation is ignored", () => {
  const { context, calls, event } = makeCancelHarness({ pointerType: "touch", tracked: false, touchScroll: true });
  assert.equal(context.handleBrowserInputPointerCancel(event), false);
  assert.equal(calls.length, 0);
});

test("pointercancel uses cancel cleanup instead of normal pointer-up activation", () => {
  const listenerBlock = app.slice(
    app.indexOf('screen.addEventListener("pointercancel", (e) => {'),
    app.indexOf('screen.addEventListener("pointerup", (e) => {')
  );
  assert.match(listenerBlock, /handleBrowserInputPointerCancel\(e\)/);
  assert.doesNotMatch(listenerBlock, /handleBrowserInputPointerUp\(e\)/);
});

test("lost pointer capture also cleans browser gesture state", () => {
  assert.match(app, /screen\.addEventListener\("lostpointercapture", handleBrowserInputPointerCancel\)/);
});

test("multi-touch pinch cancels single-tap ownership", () => {
  const pinch = extractFunction(app, "beginBrowserPinch");
  assert.match(pinch, /browserInputPointerId = null/);
  assert.match(pinch, /browserInputTouchMoved = true/);
});

test("Real Chrome input queue serializes commands per session", async () => {
  const context = { Promise, enqueueBrowserInput };
  vm.createContext(context);
  vm.runInContext(extractFunction(renderer, "queueRealChromeInput"), context);

  const session = { inputTail: Promise.resolve() };
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = context.queueRealChromeInput(session, async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  const second = context.queueRealChromeInput(session, async () => {
    order.push("second-start");
    order.push("second-end");
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(order[0], "first-start");
  assert.equal(order.includes("second-start"), false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("failed Real Chrome input does not poison the next command", async () => {
  const context = { Promise, enqueueBrowserInput };
  vm.createContext(context);
  vm.runInContext(extractFunction(renderer, "queueRealChromeInput"), context);

  const session = { inputTail: Promise.resolve() };
  const order = [];
  await assert.rejects(
    context.queueRealChromeInput(session, async () => {
      order.push("bad");
      throw new Error("synthetic failure");
    }),
    /synthetic failure/
  );
  await context.queueRealChromeInput(session, async () => {
    order.push("good");
  });
  assert.deepEqual(order, ["bad", "good"]);
});

test("Tesla tap backend uses desktop mouse click semantics", () => {
  const start = renderer.indexOf("async function dispatchRealChromeTap");
  const end = renderer.indexOf("export async function input", start);
  const tap = renderer.slice(start, end);
  assert.doesNotMatch(tap, /Input\.dispatchTouchEvent/);
  assert.equal((tap.match(/Input\.dispatchMouseEvent/g) || []).length, 2);
  assert.match(renderer, /Emulation\.setTouchEmulationEnabled", \{ enabled: false \}/);
});

test("Real Chrome queues all input before dispatching tap or capturing a CDP target", () => {
  const inputStart = renderer.indexOf("export async function input(id, payload = {})");
  const dispatchStart = renderer.indexOf("async function dispatchRealChromeInput(session, payload = {})");
  const input = renderer.slice(inputStart, dispatchStart);
  const dispatch = renderer.slice(dispatchStart, renderer.indexOf("export async function mediaPlayback", dispatchStart));
  assert.match(input, /return queueRealChromeInput\(session, \(\) => dispatchRealChromeInput\(session, payload\)\)/);
  assert.match(dispatch, /if \(payload\.type === "tap"\) return dispatchRealChromeTap\(session, payload\)/);
  assert.ok(dispatch.indexOf('if (payload.type === "tap")') < dispatch.indexOf("const cdp = continuingDrag"));
});
