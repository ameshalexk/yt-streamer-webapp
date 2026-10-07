import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/everyday-controls.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/everyday-controls.css", import.meta.url), "utf8");

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this._text = "";
    this.className = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...children) { for (const child of children.flat()) { child.parentElement = this; this.children.push(child); } }
  prepend(...children) { for (const child of children.flat().reverse()) { child.parentElement = this; this.children.unshift(child); } }
  after(node) {
    const siblings = this.parentElement.children;
    node.parentElement = this.parentElement;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async click() { for (const listener of this.listeners.click || []) await listener({ target: this }); }
  focus() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    const result = [];
    for (const child of this.children) {
      if (className && child.className.split(/\s+/).includes(className)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}

function moduleHarness(fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const screen = new Element("div");
  screen.id = "screen";
  const document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => { const node = new Element("#text"); node.textContent = text; return node; },
    querySelector: (selector) => selector === "#screen" ? screen : null,
  };
  const window = { fetch, confirm: () => false };
  vm.runInNewContext(source, { window, document });
  return { api: window.EverydayControls, screen };
}

function response(data) { return { ok: true, status: 200, json: async () => data }; }
const statusData = {
  usage: { libraryBytes: 1024, cacheBytes: null, freeBytes: 4096, totalBytes: 8192 },
  policy: { enabled: false, watchedRetentionDays: 30 },
  downloads: [{ id: "processed-1", title: "Episode One", pinned: false, watchedAt: null, bytes: 1024 }],
};

test("shortcuts expose expected everyday actions and land after the player screen", async () => {
  const { api, screen } = moduleHarness();
  const host = new Element("main");
  host.append(screen);
  const called = [];
  const shortcuts = api.init({ container: host, actions: Object.fromEntries(["resume", "saved", "browse", "downloads"].map((key) => [key, () => called.push(key)])) });
  assert.equal(host.children[0], screen);
  assert.equal(host.children[1], shortcuts.element);
  for (const button of shortcuts.element.children) await button.click();
  assert.deepEqual(called, ["resume", "saved", "browse", "downloads"]);
});

test("cleanup renders candidate titles and applies only IDs in the confirmed preview", async () => {
  const calls = [];
  const reviewed = [{ id: "reviewed-1", title: "Reviewed episode", bytes: 512 }];
  let confirmCount = 0;
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/storage/cleanup" && options.body && JSON.parse(options.body).apply === false) {
      return response({ candidates: reviewed, reclaimableBytes: 512 });
    }
    if (url === "/api/storage/cleanup" && options.body && JSON.parse(options.body).apply === true) {
      return response({ applied: true, reclaimedBytes: 512 });
    }
    return response(statusData);
  };
  const { api } = moduleHarness(fetch);
  const panel = api.createStoragePanel({ container: new Element(), confirm: () => { confirmCount += 1; return true; } });
  await panel.refresh();
  const cleanup = panel.element.querySelector(".everyday-storage-cleanup");
  await cleanup.click();
  const preview = panel.element.querySelector(".everyday-storage-preview");
  assert.match(preview.textContent, /Reviewed episode/);
  const apply = calls.find((call) => call.url === "/api/storage/cleanup" && call.options.body && JSON.parse(call.options.body).apply === true);
  assert.ok(apply);
  assert.deepEqual(JSON.parse(apply.options.body), { apply: true, ids: ["reviewed-1"] });
  assert.equal(confirmCount, 1);
  assert.match(panel.element.textContent, /Only watched processed downloads; original APNE and iCloud files are kept\./);
  assert.match(panel.element.textContent, /CacheUnavailable/);
});

test("cancelling cleanup never applies, and pin and mark-watched send their explicit requests", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/storage/cleanup") return response({ eligible: [{ id: "reviewed-2", title: "Another episode", bytes: 17 }] });
    return response(statusData);
  };
  const { api } = moduleHarness(fetch);
  const panel = api.createStoragePanel({ container: new Element(), confirm: () => false });
  await panel.refresh();
  await panel.element.querySelector(".everyday-storage-cleanup").click();
  assert.equal(calls.some((call) => call.url === "/api/storage/cleanup" && call.options.body && JSON.parse(call.options.body).apply === true), false);
  assert.equal(panel.element.querySelectorAll(".everyday-storage-pin").length, 1);
  await panel.element.querySelector(".everyday-storage-pin").click();
  await panel.element.querySelector(".everyday-storage-mark-watched").click();
  const pinCall = calls.find((call) => call.url === "/api/storage/downloads/processed-1");
  assert.equal(pinCall.options.method, "PATCH");
  assert.deepEqual(JSON.parse(pinCall.options.body), { pinned: true });
  const watchedCall = calls.find((call) => call.url === "/api/storage/downloads/processed-1/watched");
  assert.equal(watchedCall.options.method, "POST");
  assert.deepEqual(JSON.parse(watchedCall.options.body), { completed: true });
  assert.match(panel.element.textContent, /Only watched processed downloads; original APNE and iCloud files are kept\./);
});

test("shortcuts remain touch sized and visibly keyboard focused", () => {
  assert.match(css, /min-height:\s*48px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /grid-template-columns:\s*repeat\(4/);
});
