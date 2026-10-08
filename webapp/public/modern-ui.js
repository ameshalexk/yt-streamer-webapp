/* Shared-DOM presentation layer. It never creates or reparents the player. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) {
    root.YTStreamerModernUI = api;
    root.dispatchEvent(new CustomEvent("yt-streamer-modern-ready", { detail: api }));
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const PREF_KEY = "ytStreamerModernDeviceLayout";
  const SIDE_KEY = "ytStreamerModernQuickSide";
  let mounted = false;
  let observers = [];
  let created = [];
  let quickBar = null;
  let addedDockClass = false;

  function safeGet(key) { try { return root.localStorage.getItem(key); } catch { return null; } }
  function safeSet(key, value) { try { root.localStorage.setItem(key, value); } catch {} }
  function make(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function add(host, node, before) {
    host.insertBefore(node, before || null);
    created.push(node);
    return node;
  }
  function keepHidden(node) {
    node.hidden = true;
    node.style.setProperty("display", "none", "important");
  }
  function syncNowPlaying() {
    const screen = root.document.querySelector("#screen");
    const playing = Boolean(screen?.classList.contains("playing"));
    const title = root.document.querySelector("#nowPlaying")?.textContent?.trim();
    const status = root.document.querySelector("#status")?.textContent?.trim() || "";
    const labelNode = root.document.querySelector(".modern-now-label");
    const titleNode = root.document.querySelector(".modern-now-title");
    const statusNode = root.document.querySelector(".modern-now-status");
    if (labelNode) labelNode.textContent = playing ? "NOW PLAYING" : "PLAYER READY";
    if (titleNode) titleNode.textContent = playing && title ? title : "Choose a video";
    if (statusNode) statusNode.textContent = status;
  }
  function syncAuto() {
    const selected = root.document.querySelector('#qualityQuick [data-stream-profile="auto"]');
    const button = root.document.querySelector(".modern-quality-auto");
    if (button) {
      const activeProfile = root.document.querySelector('#qualityQuick [aria-pressed="true"], #qualityQuick .active');
      const active = Boolean(selected && activeProfile === selected);
      button.setAttribute("aria-pressed", String(active));
      const mode = activeProfile?.textContent?.trim() || "No quality profile selected";
      button.dataset.actualStatus = mode;
      button.setAttribute("aria-label", `Quality Auto; selected mode: ${mode}`);
      button.title = `Selected mode: ${mode}`;
    }
  }
  function detectLayout() {
    const ua = root.navigator?.userAgent || "";
    if (/Tesla/i.test(ua)) return "tesla";
    if (/BRAVIA|SonyDTV/i.test(ua)) return "tv";
    return "auto";
  }
  function applyLayout(value) {
    if (!["auto", "tesla", "tv"].includes(value)) value = "auto";
    const resolved = value === "auto" ? detectLayout() : value;
    root.document.documentElement.dataset.deviceLayout = resolved;
    const select = root.document.querySelector("#modernDeviceLayout");
    if (select && select.value !== value) select.value = value;
  }
  function setVisible(visible) {
    created.forEach((node) => {
      if (visible) {
        node.hidden = false;
        node.style.removeProperty("display");
      } else keepHidden(node);
    });
  }
  function cleanup() {
    observers.forEach((observer) => observer.disconnect());
    observers = [];
    created.forEach((node) => node.remove());
    created = [];
    root.document.documentElement.removeAttribute("data-device-layout");
    if (addedDockClass) quickBar?.classList.remove("modern-quick-dock");
    addedDockClass = false;
    mounted = false;
    quickBar = null;
  }
  function init() {
    if (mounted) return true;
    const doc = root.document;
    const layout = doc.querySelector("#layout");
    const everyday = doc.querySelector(".everyday-controls");
    const screen = doc.querySelector("#screen");
    if (!layout || !everyday || !screen || screen.parentElement !== doc.querySelector("#playerBody")) throw new Error("Shared dashboard is not ready");
    try {
      const intro = make("section", "modern-intro");
      intro.setAttribute("aria-label", "Dashboard introduction");
      intro.append(make("p", "modern-eyebrow", "YOUR STREAMING DASHBOARD"), make("h1", "", "Pick up where you left off"), make("p", "modern-intro-copy", "Your player, saved channels and daily picks in one place."));
      keepHidden(intro);
      add(layout.parentElement, intro, layout);

      const now = make("section", "modern-now-playing");
      now.setAttribute("aria-live", "polite");
      now.append(make("span", "modern-now-label", "NOW PLAYING"), make("strong", "modern-now-title", "Player"), make("span", "modern-now-status", ""));
      keepHidden(now);
      add(everyday.parentElement, now, everyday);

      quickBar = everyday;
      if (!quickBar.classList.contains("modern-quick-dock")) {
        quickBar.classList.add("modern-quick-dock");
        addedDockClass = true;
      }
      function quick(label, cls, selector) {
        const button = make("button", `everyday-control modern-only ${cls}`, label);
        button.type = "button";
        button.dataset.modernAction = cls;
        button.setAttribute("aria-label", label);
        keepHidden(button);
        button.addEventListener("click", () => doc.querySelector(selector)?.click());
        quickBar.append(button);
        created.push(button);
      }
      quick("APNE Daily", "modern-apne", '.mode-tabs [data-mode="apne"]');
      quick("Fullscreen", "modern-fullscreen", "#fullscreenBtn");
      quick("Quality Auto", "modern-quality-auto", '#qualityQuick [data-stream-profile="auto"]');
      const settings = make("section", "modern-reach-settings modern-only");
      keepHidden(settings);
      settings.setAttribute("aria-label", "Device layout and quick action placement");
      const label = make("label", "", "Device layout ");
      const select = make("select", "");
      select.id = "modernDeviceLayout";
      [["auto", "Auto"], ["tesla", "Tesla"], ["tv", "TV / Bravia"]].forEach(([value, title]) => {
        const option = make("option", "", title); option.value = value; select.append(option);
      });
      const savedLayout = safeGet(PREF_KEY);
      select.value = ["auto", "tesla", "tv"].includes(savedLayout) ? savedLayout : "auto";
      if (savedLayout !== select.value) safeSet(PREF_KEY, select.value);
      select.addEventListener("change", () => { safeSet(PREF_KEY, select.value); applyLayout(select.value); });
      label.append(select);
      settings.append(label);
      const side = safeGet(SIDE_KEY) === "passenger" ? "passenger" : "driver";
      ["driver", "passenger"].forEach((which) => {
        const button = make("button", "modern-side-choice", which === "driver" ? "Driver side" : "Passenger side");
        button.type = "button";
        button.dataset.quickSide = which;
        button.setAttribute("aria-pressed", String(which === side));
        button.addEventListener("click", () => {
          safeSet(SIDE_KEY, which);
          doc.documentElement.dataset.quickSide = which;
          settings.querySelectorAll("[data-quick-side]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        });
        settings.append(button);
      });
      add(everyday.parentElement, settings, everyday.nextSibling);

      const uiSwitch = doc.querySelector("#uiSwitch");
      if (!uiSwitch || !uiSwitch.querySelector('[data-ui-mode="classic"]') || !uiSwitch.querySelector('[data-ui-mode="new"]')) throw new Error("UI switch is missing");
      syncNowPlaying();
      syncAuto();
      applyLayout(select.value);
      doc.documentElement.dataset.quickSide = side;
      const textObserver = new root.MutationObserver(syncNowPlaying);
      [doc.querySelector("#nowPlaying"), doc.querySelector("#status")].forEach((node) => {
        if (node) textObserver.observe(node, { subtree: true, childList: true, characterData: true });
      });
      if (screen) textObserver.observe(screen, { attributes: true, attributeFilter: ["class"] });
      observers.push(textObserver);
      const qualityObserver = new root.MutationObserver(syncAuto);
      const quality = doc.querySelector("#qualityQuick");
      if (quality) qualityObserver.observe(quality, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed", "class"] });
      observers.push(qualityObserver);
      mounted = true;
      return true;
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  return { init, cleanup, setVisible, syncNowPlaying, syncAuto };
});
