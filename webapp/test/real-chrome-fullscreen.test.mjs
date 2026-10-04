import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

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

test("Real Chrome tap dispatch sends one pinned desktop click for mouse and touch", async () => {
  const start = realChrome.indexOf("async function dispatchRealChromeTap(");
  const end = realChrome.indexOf("\nexport async function input(", start);
  assert.ok(start >= 0 && end > start, "actual tap dispatcher should exist");
  const harness = vm.createContext({
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    point: () => ({ x: 321, y: 123 }),
    tryApnePlayNowAtPoint: async () => ({ matched: false }),
    INPUT_COMMAND_TIMEOUT_MS: 2000,
  });
  vm.runInContext(realChrome.slice(start, end), harness);

  for (const pointerType of ["mouse", "touch"]) {
    const calls = [];
    const replacementCalls = [];
    let session;
    const pinned = {
      ready: Promise.resolve(),
      async call(method, params) {
        calls.push({ method, params });
        if (params.type === "mousePressed") session.cdp = replacement;
      },
    };
    const replacement = {
      ready: Promise.resolve(),
      async call(method, params) { replacementCalls.push({ method, params }); },
    };
    session = { cdp: pinned };
    await harness.dispatchRealChromeTap(session, { type: "tap", pointerType, x: 321, y: 123 });

    assert.deepEqual(calls.map(({ params }) => params.type), ["mousePressed", "mouseReleased"], pointerType);
    assert.deepEqual(calls.map(({ params }) => [params.x, params.y]), [[321, 123], [321, 123]], pointerType);
    assert.deepEqual(replacementCalls, [], pointerType);
    assert.equal(calls.filter(({ method }) => method === "Input.dispatchMouseEvent").length, 2, pointerType);
    assert.equal(calls.filter(({ method }) => method === "Input.dispatchTouchEvent").length, 0, pointerType);
  }
});

test("Real Chrome clears a possibly delivered press after a CDP press failure", async () => {
  const start = realChrome.indexOf("async function dispatchRealChromeTap(");
  const end = realChrome.indexOf("\nexport async function input(", start);
  const harness = vm.createContext({
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    point: () => ({ x: 40, y: 50 }),
    tryApnePlayNowAtPoint: async () => ({ matched: false }),
    INPUT_COMMAND_TIMEOUT_MS: 2000,
  });
  vm.runInContext(realChrome.slice(start, end), harness);
  const calls = [];
  const session = { cdp: {
    ready: Promise.resolve(),
    async call(method, params) {
      calls.push({ method, params });
      if (params.type === "mousePressed") throw new Error("CDP timeout");
    },
  } };

  await assert.rejects(harness.dispatchRealChromeTap(session, { type: "tap", pointerType: "touch" }), /CDP timeout/);
  assert.deepEqual(calls.map(({ params }) => params.type), ["mousePressed", "mouseReleased"]);
  assert.ok(calls.every(({ method }) => method === "Input.dispatchMouseEvent"));
});

 test("Real Chrome retries a failed release on the pinned target", async () => {
  const start = realChrome.indexOf("async function dispatchRealChromeTap(");
  const end = realChrome.indexOf("\nexport async function input(", start);
  const harness = vm.createContext({
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    point: () => ({ x: 40, y: 50 }),
    tryApnePlayNowAtPoint: async () => ({ matched: false }),
    INPUT_COMMAND_TIMEOUT_MS: 2000,
  });
  vm.runInContext(realChrome.slice(start, end), harness);
  const calls = [];
  let releases = 0;
  const replacementCalls = [];
  const session = {};
  session.cdp = { ready: Promise.resolve(), async call(method, params) {
    calls.push(params.type);
    if (params.type === "mouseReleased" && ++releases === 1) {
      session.cdp = { call: async (...args) => replacementCalls.push(args) };
      throw new Error("release timeout");
    }
  } };
  await assert.rejects(harness.dispatchRealChromeTap(session, { type: "tap" }), /release timeout/);
  assert.deepEqual(calls, ["mousePressed", "mouseReleased", "mouseReleased"]);
  assert.deepEqual(replacementCalls, []);
});
