/* Reversible, fail-safe UI selection. Safe to load before the document body. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) api.install();
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const KEY = "ytStreamerUiMode";

  function create(options = {}) {
    const doc = options.document || root.document;
    const win = options.window || root;
    const storage = options.storage || (() => { try { return win.localStorage; } catch { return null; } })();
    let modernStyleReady = false;
    let modernModule = null;
    let bodyReady = false;
    let applyInitial = null;
    let initialFinished = false;
    let userSelected = false;
    let activationEpoch = 0;
    let desiredMode = "classic";

    function persist(mode) { try { storage?.setItem(KEY, mode); } catch {} }
    function clearQuery() {
      try {
        const url = new URL(win.location.href);
        if (url.searchParams.has("ui")) {
          url.searchParams.delete("ui");
          win.history.replaceState(win.history.state, "", url.href);
        }
      } catch {}
    }
    function setPressed(mode) {
      doc.querySelectorAll("#uiSwitch [data-ui-mode]").forEach((link) =>
        link.setAttribute("aria-pressed", link.dataset.uiMode === mode ? "true" : "false"));
    }
    function classic({ save = false, clear = false } = {}) {
      activationEpoch += 1;
      desiredMode = "classic";
      try { modernModule?.setVisible?.(false); } catch {}
      try { modernModule?.cleanup?.(); } catch {}
      doc.documentElement.removeAttribute("data-ui");
      setPressed("classic");
      if (save) persist("classic");
      if (clear) clearQuery();
    }
    async function activateNew({ save = false, clear = false, epoch } = {}) {
      if (!modernStyleReady || !modernModule || typeof modernModule.init !== "function") throw new Error("New UI is not ready");
      if (epoch == null) epoch = ++activationEpoch;
      await modernModule.init();
      if (epoch !== activationEpoch) {
        if (desiredMode === "classic") {
          try { modernModule.setVisible?.(false); } catch {}
          try { modernModule.cleanup?.(); } catch {}
          doc.documentElement.removeAttribute("data-ui");
          setPressed("classic");
        }
        return;
      }
      doc.documentElement.dataset.ui = "new";
      modernModule.setVisible?.(true);
      setPressed("new");
      if (save) persist("new");
      if (clear) clearQuery();
    }
    function registerModern(module) { modernModule = module; applyInitial?.(); }
    function markStyleReady(ok) {
      modernStyleReady = Boolean(ok);
      if (!modernStyleReady) classic();
      else applyInitial?.();
    }
    function handleClick(event) {
      const link = event.target.closest?.("#uiSwitch [data-ui-mode]");
      if (!link) return;
      if (link.dataset.uiMode === "new" && (!modernStyleReady || !modernModule)) return;
      event.preventDefault();
      userSelected = true;
      if (link.dataset.uiMode === "classic") { classic({ save: true, clear: true }); return; }
      desiredMode = "new";
      const epoch = ++activationEpoch;
      activateNew({ save: true, clear: true, epoch }).catch(() => {
        if (epoch === activationEpoch) classic({ save: true, clear: true });
      });
    }
    function install() {
      if (!doc || doc.documentElement.dataset.uiSwitchInstalled) return;
      doc.documentElement.dataset.uiSwitchInstalled = "true";
      const style = doc.createElement("link");
      style.rel = "stylesheet";
      style.href = "/modern-ui.css?v=20261008-v3";
      style.onload = () => { markStyleReady(true); applyInitial(); };
      style.onerror = () => { markStyleReady(false); classic(); };
      doc.head.appendChild(style);
      doc.addEventListener("click", handleClick);
      win.addEventListener?.("error", (event) => {
        if (desiredMode === "new" && /(?:^|\/)modern-ui\.js(?:\?|$)/.test(event.filename || "")) {
          classic({ save: true, clear: true });
        }
      });
      win.addEventListener?.("unhandledrejection", (event) => {
        const stack = String(event.reason?.stack || event.reason || "");
        if (desiredMode === "new" && /modern-ui\.js/.test(stack)) {
          classic({ save: true, clear: true });
        }
      });
      applyInitial = function () {
        if (initialFinished || userSelected || !bodyReady || !modernStyleReady || !modernModule) return;
        let requested = "classic";
        try {
          const query = new URLSearchParams(win.location.search).get("ui");
          const stored = storage?.getItem(KEY);
          requested = query === "classic" || query === "new" ? query : (stored === "new" ? "new" : "classic");
        } catch {}
        initialFinished = true;
        if (requested === "new") {
          desiredMode = "new";
          const epoch = ++activationEpoch;
          activateNew({ epoch }).catch(() => { if (epoch === activationEpoch) classic(); });
        }
        else classic();
      };
      const ready = () => { bodyReady = true; applyInitial(); };
      if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", ready, { once: true });
      else ready();
      win.addEventListener?.("yt-streamer-modern-ready", (event) => registerModern(event.detail));
      if (win.YTStreamerModernUI) registerModern(win.YTStreamerModernUI);
    }
    return { install, activateNew, classic, registerModern, markStyleReady };
  }

  let controller;
  function install() {
    if (!controller) controller = create();
    controller.install();
    return controller;
  }
  return { create, install, get controller() { return controller; } };
});
