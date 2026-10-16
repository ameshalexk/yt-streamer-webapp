import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/ui-switch.js", import.meta.url), "utf8");

class Target {
  constructor(dataset = {}) { this.dataset = dataset; this.attrs = new Map(); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
}

function setup({ url = "http://localhost/?keep=1", stored = null, storageThrows = false } = {}) {
  const listeners = new Map();
  const rootListeners = new Map();
  const links = [new Target({ uiMode: "classic" }), new Target({ uiMode: "new" })];
  const uiSwitch = { querySelectorAll: () => links };
  const html = { dataset: {}, attrs: new Map(), removeAttribute(key) { this.attrs.delete(key); if (key === "data-ui") delete this.dataset.ui; }, setAttribute(key, value) { this.attrs.set(key, String(value)); if (key === "data-ui") this.dataset.ui = String(value); } };
  const styles = [];
  const doc = {
    documentElement: html,
    head: { appendChild(node) { styles.push(node); node.parentElement = this; } },
    readyState: "complete",
    createElement(tag) { return { tagName: tag.toUpperCase(), rel: "", href: "", onload: null, onerror: null }; },
    querySelector(selector) { return selector === "#uiSwitch" ? uiSwitch : null; },
    querySelectorAll(selector) { return selector === "#uiSwitch [data-ui-mode]" ? links : []; },
    addEventListener(type, fn) { listeners.set(type, fn); },
  };
  const saved = new Map(stored == null ? [] : [["ytStreamerUiMode", stored]]);
  const storage = storageThrows ? {
    getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); },
  } : { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } };
  let current = new URL(url);
  const history = { state: { test: true }, replaceState(_state, _title, next) { current = new URL(next, current); } };
  const win = {
    document: doc,
    localStorage: storage,
    history,
    get location() { return { href: current.href, search: current.search }; },
    addEventListener(type, fn) { rootListeners.set(type, fn); },
    dispatchEvent(event) { rootListeners.get(event.type)?.(event); },
  };
  win.window = win;
  win.URL = URL;
  win.URLSearchParams = URLSearchParams;
  win.module = { exports: {} };
  const context = vm.createContext(win);
  vm.runInContext(source, context, { filename: "ui-switch.js" });
  const api = win.module.exports;
  const controller = api.controller;
  const loadCss = () => styles.at(-1)?.onload?.();
  const failCss = () => styles.at(-1)?.onerror?.();
  const register = (impl) => win.dispatchEvent({ type: "yt-streamer-modern-ready", detail: impl });
  const click = async (mode) => {
    let prevented = false;
    listeners.get("click")?.({ target: { closest: () => links.find(link => link.dataset.uiMode === mode) }, preventDefault() { prevented = true; } });
    await new Promise(resolve => setTimeout(resolve, 0));
    return prevented;
  };
  return { api, controller, doc, html, links, styles, saved, win, loadCss, failCss, register, click, get url() { return current; } };
}

const modern = { init() { return true; } };

test("Classic is the initial and invalid-preference fallback", () => {
  for (const opts of [{}, { stored: "bogus" }, { storageThrows: true }]) {
    const h = setup(opts);
    h.register(modern);
    h.loadCss();
    assert.equal(h.html.dataset.ui, undefined);
    assert.equal(h.links[0].getAttribute("aria-pressed"), "true");
    assert.equal(h.links[1].getAttribute("aria-pressed"), "false");
  }
});

test("persisted New UI is restored only after both assets are ready; explicit Classic query wins", async () => {
  const persisted = setup({ stored: "new" });
  persisted.register(modern);
  assert.equal(persisted.html.dataset.ui, undefined, "waits for CSS readiness");
  persisted.loadCss();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(persisted.html.dataset.ui, "new");

  const explicit = setup({ url: "http://localhost/?ui=classic&tab=library", stored: "new" });
  explicit.register(modern);
  explicit.loadCss();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(explicit.html.dataset.ui, undefined);
  assert.equal(explicit.saved.get("ytStreamerUiMode"), "new", "query override does not rewrite preference");
});

test("switches without navigation and removes only ui query parameter", async () => {
  const h = setup({ url: "http://localhost/?ui=classic&tab=library&debug=1" });
  h.register(modern);
  h.loadCss();
  await h.click("new");
  assert.equal(h.html.dataset.ui, "new");
  assert.equal(h.saved.get("ytStreamerUiMode"), "new");
  assert.equal(h.url.searchParams.get("tab"), "library");
  assert.equal(h.url.searchParams.get("debug"), "1");
  assert.equal(h.url.searchParams.has("ui"), false);
  await h.click("classic");
  assert.equal(h.html.dataset.ui, undefined);
  assert.equal(h.saved.get("ytStreamerUiMode"), "classic");
});

test("missing modern script and failed CSS keep Classic available and recover to Classic on New request", async () => {
  const missingScript = setup();
  missingScript.loadCss();
  await missingScript.click("new");
  assert.equal(missingScript.html.dataset.ui, undefined);

  const failedCss = setup({ stored: "new" });
  failedCss.register(modern);
  failedCss.failCss();
  assert.equal(failedCss.html.dataset.ui, undefined);
  await failedCss.click("new");
  assert.equal(failedCss.html.dataset.ui, undefined);
});

test("a throwing modern initializer rolls back to Classic without a reload", async () => {
  const h = setup({ stored: "new" });
  h.register({ init() { throw new Error("fixture initialization failure"); } });
  h.loadCss();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.html.dataset.ui, undefined);
  assert.equal(h.links[0].getAttribute("aria-pressed"), "true");
});
