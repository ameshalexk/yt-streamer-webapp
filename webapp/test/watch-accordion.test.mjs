import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Classes {
  values = new Set();
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force = !this.values.has(value)) { force ? this.add(value) : this.remove(value); return force; }
  contains(value) { return this.values.has(value); }
}

class Element {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.classList = new Classes(); this.hidden = false; this.inert = false;
    this.textContent = ""; this.listeners = new Map();
  }
  set className(value) { this._className = value; this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return this._className ?? [...this.classList.values].join(" "); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  append(...nodes) { for (const node of nodes) { node.parentNode?.removeChild(node); node.parentNode = this; this.children.push(node); } }
  prepend(node) { node.parentNode?.removeChild(node); node.parentNode = this; this.children.unshift(node); }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; return node; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { return selector === ".legacy-item" ? this.children.filter(n => n.classList.contains("legacy-item")) : []; }
  get firstElementChild() { return this.children[0] ?? null; }
}

function harness() {
  const ids = ["layout", "playerBody", "channelsView", "playlistDrawer", "downloadsDrawer", "streamSettingsPanel",
    "qualityQuick", "streamSettings", "homeTiles", "playerDropdownBtn", "streamSettingsBtn", "closeSavedDrawerBtn",
    "closeDownloadsDrawerBtn", "savedDrawerBackdrop", "downloadsDrawerBackdrop", "screen", "nowPlaying", "playlistList", "legacyList"];
  const byId = new Map(ids.map(id => [id, new Element("div", id)]));
  const overlay = new Element("div", "video-controls-overlay");
  const screen = byId.get("screen");
  const screenParent = new Element("div", "screenHost"); screenParent.append(screen, overlay);
  const selectors = { ".player-toolbar": new Element(), ".quick": new Element(), ".player": new Element() };
  const quality = new Element(); quality.textContent = "1080p"; quality.setAttribute("aria-pressed", "true");
  byId.get("qualityQuick").querySelector = selector => selector === '[aria-pressed="true"]' ? quality : null;
  byId.get("legacyList").querySelectorAll = selector => selector === ".legacy-item" ? byId.get("legacyList").children.filter(n => n.classList.contains("legacy-item")) : [];
  let observerCallback;
  const document = {
    activeElement: null,
    createElement: tag => { const node = new Element(tag); node.ownerDocument = document; return node; },
    querySelector: selector => selector.startsWith("#") ? byId.get(selector.slice(1)) : selectors[selector],
  };
  for (const node of [...byId.values(), ...Object.values(selectors), overlay, screenParent]) node.ownerDocument = document;
  document.querySelector = selector => selector.startsWith("#") && selector.includes(" ")
    ? (selector === '#qualityQuick [aria-pressed="true"]' ? byId.get("qualityQuick").querySelector('[aria-pressed="true"]') : null)
    : selector.startsWith("#") ? byId.get(selector.slice(1)) : selectors[selector];
  class MutationObserver { constructor(fn) { observerCallback = fn; } observe() {} }
  const state = { playlists: [], mode: "watch", savedDrawerOpen: false, downloadsDrawerOpen: false };
  const context = vm.createContext({ document, MutationObserver, state, console,
    $(selector) { return document.querySelector(selector); }, setPanelHidden(el, hidden) {
    el.hidden = hidden; el.inert = hidden; el.setAttribute("aria-hidden", hidden ? "true" : "false");
  }, setPlayerDropdownOpen() {}, openChannels() {}, renderPlaylists() {}, renderItems() {},
    loadLegacyLibrary: async () => {}, toast() {} });
  const source = fs.readFileSync(new URL("../public/accordion.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  context.initWatchAccordion();
  const accordion = context.watchAccordion;
  return { context, document, byId, selectors, state, accordion: vm.runInContext("watchAccordion", context),
    observer: () => observerCallback, screenParent, overlay };
}

test("moves the five existing control groups once and leaves screen and fullscreen overlay in place", () => {
  const h = harness();
  const moved = [h.selectors[".player-toolbar"], h.selectors[".quick"], h.byId.get("channelsView"),
    h.byId.get("playlistDrawer"), h.byId.get("downloadsDrawer"), h.byId.get("streamSettingsPanel"), h.byId.get("qualityQuick")];
  assert.equal(h.accordion.rows.size, 5);
  for (const node of moved) assert.equal(node.parentNode?.className, "watch-section-panel");
  assert.equal(h.byId.get("screen").parentNode, h.screenParent);
  assert.equal(h.overlay.parentNode, h.screenParent);
  for (const node of moved) assert.equal(node.parentNode.children.filter(child => child === node).length, 1);
});

test("only one section expands and hidden, inert, and aria state stay synchronized", () => {
  const { context, accordion, document } = harness();
  context.setWatchSection("saved");
  for (const [key, row] of accordion.rows) {
    const open = key === "saved";
    assert.equal(row.button.getAttribute("aria-expanded"), String(open));
    assert.equal(row.panel.hidden, !open);
    assert.equal(row.panel.inert, !open);
    assert.equal(row.panel.getAttribute("aria-hidden"), String(!open));
  }
});

test("closing a section moves focus out when it was inside the panel", () => {
  const { context, accordion, document } = harness();
  const row = accordion.rows.get("settings");
  const control = new Element("button"); control.ownerDocument = document; row.panel.append(control); context.setWatchSection("settings");
  control.focus(); context.setWatchSection(null);
  assert.equal(document.activeElement, row.button);
});

test("headers toggle their section and Escape closes it and restores header focus", () => {
  const { accordion, document } = harness();
  const row = accordion.rows.get("playback"); row.button.onclick();
  assert.equal(accordion.open, "playback"); row.button.onclick(); assert.equal(accordion.open, null);
  row.button.onclick();
  let stopped = false;
  accordion.host.listeners.get("keydown")({ key: "Escape", stopPropagation() { stopped = true; } });
  assert.equal(accordion.open, null); assert.equal(stopped, true);
  assert.equal(document.activeElement, row.button);
});

test("summaries reflect the selected quality preset", () => {
  const h = harness();
  assert.equal(h.accordion.rows.get("settings").summary.textContent, "1080p");
  const selected = new Element("button"); selected.textContent = "720p"; selected.setAttribute("aria-pressed", "true");
  h.byId.get("qualityQuick").querySelector = () => selected;
  h.observer()();
  assert.equal(h.accordion.rows.get("settings").summary.textContent, "720p");
});

test("same-mode resizing preserves the user's selected section", () => {
  const { context, accordion } = harness();
  context.setWatchSection("downloads");
  context.syncWatchMode("watch", "watch");
  assert.equal(accordion.open, "downloads");
  context.syncWatchMode("watch", "watch");
  assert.equal(accordion.open, "downloads");
});
