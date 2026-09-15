// YT Streamer SPA. Vanilla JS, no build step. Talks to the same-origin API.
"use strict";

const $ = (s) => document.querySelector(s);
const api = {
  async parse(r) {
    if (r.status === 204) return null;
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      const looksHtml = /^\s*</.test(text) || /html/i.test(r.headers.get("content-type") || "");
      throw new Error(looksHtml
        ? "Backend route is not active yet. Restart the Node webapp so the new API routes load."
        : "Backend returned a non-JSON response.");
    }
    if (!r.ok) throw new Error(data?.error || r.statusText);
    return data;
  },
  async get(p) { return this.parse(await fetch(p)); },
  async send(method, p, body) {
    const r = await fetch(p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return this.parse(r);
  },
  post(p, b) { return this.send("POST", p, b); },
  patch(p, b) { return this.send("PATCH", p, b); },
  del(p) { return this.send("DELETE", p); },
};

function reportPlaybackEvent(event, detail = {}) {
  const payload = {
    event,
    ...detail,
    userAgent: navigator.userAgent,
  };
  try {
    fetch("/api/playback-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

const state = {
  playlists: [],
  selectedPlaylistId: null,
  playingItemId: null,
  mode: "watch",
  savedDrawerOpen: false,
  downloadsDrawerOpen: false,
  manageSaved: false,
  lastSavedPlaylistId: null,
  legacyItems: [],
  legacyPlayingId: null,
  legacyPlaylists: [],
  selectedLegacyPlaylistId: null,
  legacyPlaylistVideos: [],
  apneDaily: { today: "", shows: [], loading: false, pollTimer: null },
  youtubeAuth: null,
  recommendations: [],
  recommendationCategory: "all",
  recommendationVisibleCount: 25,
  recommendationsLoadedAt: null,
  recommendedPlayingId: null,
  youtubeSearchResults: [],
  youtubeSearchQuery: "",
  youtubeSearchLoading: false,
  youtubeSearchPlayingId: null,
  youtubeSearchError: "",
  browseYoutubePanel: "search",
  youtubeHistory: [],
  youtubeHistoryLoaded: false,
  youtubeHistoryLoading: false,
  youtubeHistoryPlayingId: null,
  youtubeHistoryError: "",
  youtubeSearchDownloads: {},
  recommendationDownloads: {},
  recommendationPrepared: {},
  desktopSources: null,
  savedEmbeds: [],
  savedEmbedsLoaded: false,
  browserHistory: [],
  browserHistoryLoaded: false,
  browserHistoryLoading: false,
};

const FPS_OPTIONS = [
  { value: "5", label: "5" },
  { value: "8", label: "8" },
  { value: "12", label: "12" },
  { value: "15", label: "15" },
  { value: "20", label: "20", risky: true },
  { value: "24", label: "24", risky: true },
  { value: "30", label: "30", risky: true },
  { value: "45", label: "45", risky: true },
  { value: "60", label: "60", risky: true },
];

const DEFAULT_STREAM_SETTINGS = {
  height: "480",
  fps: "24",
  quality: "7",
};

const STREAM_QUALITY_PROFILE_KEY = "ytStreamerQualityProfileV2";
const STREAM_QUALITY_SWITCH_DELAY_MS = 140;
const STREAM_QUALITY_PROFILES = Object.freeze({
  low: Object.freeze({ id: "low", label: "Low", height: "360", fps: "12", quality: "12" }),
  medium: Object.freeze({ id: "medium", label: "Medium", height: "480", fps: "15", quality: "7" }),
  high: Object.freeze({ id: "high", label: "High", height: "480", fps: "24", quality: "4" }),
});

const DESKTOP_AUDIO_KEY = "ytStreamerDesktopAudio";
const DESKTOP_AUDIO_NAME_KEY = "ytStreamerDesktopAudioName";
const DESKTOP_FEATURE_VISIBLE = false;
const EMBED_FEATURE_VISIBLE = false;
const BROWSER_AUDIO_KEY = "ytStreamerBrowserAudio";
const BROWSER_AUDIO_NAME_KEY = "ytStreamerBrowserAudioName";
const BROWSER_AUDIO_FORMAT_KEY = "ytStreamerBrowserAudioFormat";
const BROWSER_AUDIO_BITRATE_KEY = "ytStreamerBrowserAudioBitrate";
const BROWSER_AUDIO_DEFAULT_KEY = "ytStreamerBrowserAudioDefaultV2";
const BROWSER_AUDIO_CAPTURE_KEY = "ytStreamerBrowserAudioCaptureV2";
const BROWSER_QUALITY_KEY = "ytStreamerBrowserMjpegQuality";
const DESKTOP_INPUT_TOKEN_KEY = "ytStreamerDesktopInputToken";
const SAVED_EMBEDS_KEY = "ytStreamerSavedEmbeds";
const THEME_KEY = "ytStreamerTheme";
const AUTOPLAY_KEY = "ytStreamerAutoplay";
const WATCH_HISTORY_LIMIT = 300;
const RECOMMENDATION_PAGE_SIZE = 25;
const DEFAULT_EMBED_CODE = `<iframe title="Argentina vs Algeria Player" marginheight="0" marginwidth="0" src="https://embed.st/embed/admin/ppv-argentina-vs-algeria/1" scrolling="no" allowfullscreen="yes" allow="encrypted-media; picture-in-picture;" width="100%" height="100%" frameborder="0"></iframe>`;
const BROWSER_AUDIO_FORMATS = ["auto", "hls", "mp3"];
const BROWSER_AUDIO_BITRATES = ["32", "64", "96", "128", "192"];
const DEFAULT_BROWSER_AUDIO_FORMAT = "mp3";
const BROWSER_AUDIO_CAPTURE_MODES = ["manual", "blackhole-direct", "core-tap"];
const DEFAULT_BROWSER_AUDIO_CAPTURE = "core-tap";
const TOAST_OK_DURATION_MS = 3200;
const SESSION_POLL_MS = 10000;

// ---- UI helpers ----
function hideToast() {
  const t = $("#toast");
  if (!t) return;
  clearTimeout(toast._t);
  toast._t = null;
  t.hidden = true;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  const text = document.createElement("span");
  const close = document.createElement("button");
  text.className = "toast-message";
  text.textContent = msg;
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss message");
  close.textContent = "×";
  close.onclick = hideToast;
  t.replaceChildren(text, close);
  t.className = "toast" + (bad ? " bad" : " ok");
  t.setAttribute("role", bad ? "alert" : "status");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = bad ? null : setTimeout(hideToast, TOAST_OK_DURATION_MS);
}

function applyTheme(theme, persist = true) {
  const day = theme === "day";
  if (day) document.documentElement.dataset.theme = "day";
  else delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = day ? "light" : "dark";
  const button = $("#themeToggleBtn");
  if (button) {
    const nextLabel = day ? "Night" : "Day";
    button.querySelector(".theme-toggle-icon").textContent = day ? "☾" : "☀";
    button.querySelector(".theme-toggle-label").textContent = nextLabel;
    button.setAttribute("aria-label", `Switch to ${nextLabel.toLowerCase()} mode`);
    button.title = `Switch to ${nextLabel.toLowerCase()} mode`;
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = day ? "#f4f6f8" : "#0b0d10";
  if (persist) {
    try { localStorage.setItem(THEME_KEY, day ? "day" : "night"); } catch {}
  }
}

function initTheme() {
  let savedTheme = "night";
  try { savedTheme = localStorage.getItem(THEME_KEY) || "night"; } catch {}
  applyTheme(savedTheme, false);
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtDur(sec) {
  if (!sec || sec < 0) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(s).padStart(2, "0");
}
function cleanCountryName(name, code) {
  return String(name || code || "Unknown").replace(/\s*\([A-Z]{2}\)\s*$/i, "").trim() || "Unknown";
}
function itemCategory(it) { return it.meta?.category || it.meta?.group || "Other"; }
function isCountryChannelPlaylist(p) { return p?.meta?.kind === "channel-country"; }
function channelPlaylistSub(p) {
  if (!isCountryChannelPlaylist(p)) return `${p.items.length} item${p.items.length === 1 ? "" : "s"}`;
  const categories = new Set(p.items.map(itemCategory).filter(Boolean));
  return `${p.items.length} channel${p.items.length === 1 ? "" : "s"} · ${categories.size} categor${categories.size === 1 ? "y" : "ies"}`;
}
function categorySort(a, b) {
  const pinned = ["news", "movies"];
  const ar = pinned.indexOf(String(a || "").toLowerCase());
  const br = pinned.indexOf(String(b || "").toLowerCase());
  return (ar < 0 ? 99 : ar) - (br < 0 ? 99 : br) || String(a || "").localeCompare(String(b || ""));
}

let modalReturnFocus = null;
let modalDismissLocked = false;
function closeModal() {
  const backdrop = $("#modalBackdrop");
  if (backdrop.hidden) return;
  if (modalDismissLocked) return;
  backdrop.hidden = true;
  $("#modal").innerHTML = "";
  $("#modal").removeAttribute("aria-labelledby");
  $("#app").inert = false;
  document.body.classList.remove("modal-open");
  $("#restartMenuBtn")?.setAttribute("aria-expanded", "false");
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
}
function openModal(html, { locked = false } = {}) {
  const backdrop = $("#modalBackdrop");
  const modal = $("#modal");
  if (backdrop.hidden) modalReturnFocus = document.activeElement;
  modalDismissLocked = locked;
  modal.innerHTML = html;
  const title = modal.querySelector("h3");
  if (title) {
    title.id ||= "modalTitle";
    modal.setAttribute("aria-labelledby", title.id);
  } else {
    modal.removeAttribute("aria-labelledby");
  }
  backdrop.hidden = false;
  $("#app").inert = true;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    const target = modal.querySelector("[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])");
    (target || modal).focus();
  });
}
$("#modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
$("#modal").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const focusable = [...$("#modal").querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.getClientRects().length);
  if (!focusable.length) {
    e.preventDefault();
    $("#modal").focus();
    return;
  }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#modalBackdrop").hidden) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeModal();
}, true);

function isMobileMode() { return window.matchMedia("(max-width: 900px)").matches; }

function setPanelHidden(el, hidden) {
  if (!el) return;
  el.hidden = hidden;
  el.inert = hidden;
  el.setAttribute("aria-hidden", hidden ? "true" : "false");
}

function syncSavedDrawer() {
  const drawer = $("#playlistDrawer");
  const backdrop = $("#savedDrawerBackdrop");
  const open = state.mode === "browse" && state.savedDrawerOpen;
  drawer.classList.toggle("open", open);
  drawer.inert = !open;
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  backdrop.hidden = !open;
}

function setSavedDrawerOpen(open) {
  state.savedDrawerOpen = Boolean(open);
  syncSavedDrawer();
}

function syncDownloadsDrawer() {
  const drawer = $("#downloadsDrawer");
  const backdrop = $("#downloadsDrawerBackdrop");
  const open = state.mode === "library" && state.downloadsDrawerOpen;
  drawer.classList.toggle("open", open);
  drawer.inert = !open;
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  backdrop.hidden = !open;
}

function setDownloadsDrawerOpen(open) {
  state.downloadsDrawerOpen = Boolean(open);
  syncDownloadsDrawer();
}

function setMobileNavOpen(open) {
  const menu = $("#modeTabs");
  const toggle = $("#menuToggle");
  if (!menu || !toggle) return;
  const nextOpen = Boolean(open) && isMobileMode();
  menu.classList.toggle("open", nextOpen);
  toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  toggle.setAttribute("aria-label", nextOpen ? "Close navigation" : "Open navigation");
}

function screenIsPlaying() {
  return Boolean($("#screen")?.classList.contains("playing"));
}

function setPlayerDropdownOpen(open) {
  const player = $(".player");
  const button = $("#playerDropdownBtn");
  const expanded = Boolean(open);
  if (player) player.classList.toggle("player-collapsed", !expanded);
  if (button) {
    button.textContent = expanded ? "Hide Player" : "Show Player";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
}

function syncPlayerDropdownForMode(mode) {
  if (mode === "watch") {
    setPlayerDropdownOpen(true);
    return;
  }
  setPlayerDropdownOpen(!isMobileMode() || screenIsPlaying());
}

function setMode(mode) {
  if (mode === "embed" && !EMBED_FEATURE_VISIBLE) mode = "watch";
  state.mode = mode;
  setMobileNavOpen(false);
  if (mode !== "browse") state.savedDrawerOpen = false;
  if (mode !== "library") state.downloadsDrawerOpen = false;
  if (mode !== "apne" && state.apneDaily.pollTimer) { clearTimeout(state.apneDaily.pollTimer); state.apneDaily.pollTimer = null; }
  const layout = $("#layout");
  layout.classList.toggle("mode-watch", mode === "watch");
  layout.classList.toggle("mode-browse", mode === "browse");
  layout.classList.toggle("mode-recommended", mode === "recommended");
  layout.classList.toggle("mode-desktop", mode === "desktop");
  layout.classList.toggle("mode-browser", mode === "browser");
  layout.classList.toggle("mode-embed", mode === "embed");
  layout.classList.toggle("mode-library", mode === "library");
  layout.classList.toggle("mode-apne", mode === "apne");
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  setPanelHidden($("#channelsView"), mode !== "browse");
  setPanelHidden($("#recommendationsView"), mode !== "recommended");
  setPanelHidden($("#desktopView"), mode !== "desktop");
  setPanelHidden($("#browserView"), mode !== "browser");
  setPanelHidden($("#embedView"), mode !== "embed");
  setPanelHidden($("#legacyLibraryView"), mode !== "library");
  setPanelHidden($("#apneDailyView"), mode !== "apne");
  syncSavedDrawer();
  syncDownloadsDrawer();
  const player = $(".player");
  player.inert = false;
  player.setAttribute("aria-hidden", "false");
  syncPlayerDropdownForMode(mode);
}

function closePlaylistDrawer() {
  setSavedDrawerOpen(false);
}
function revealDrawerItems() {
  if (!isMobileMode()) return;
  const itemsHead = $("#itemsTitle");
  if (!itemsHead) return;
  requestAnimationFrame(() => {
    itemsHead.scrollIntoView({ block: "start", behavior: "smooth" });
    $("#itemList").scrollTop = 0;
  });
}

function openSavedPlaylist(playlistId) {
  if (playlistId) state.selectedPlaylistId = playlistId;
  if (state.mode !== "browse") openChannels();
  setSavedDrawerOpen(true);
  renderPlaylists();
  renderItems();
  revealDrawerItems();
}

function showAttemptedUrl(url) {
  const input = $("#quickUrl");
  if (input && url) input.value = String(url).trim();
}

function bindTap(container, handler) {
  let suppressClickUntil = 0;
  container.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") return;
    suppressClickUntil = Date.now() + 750;
    handler(e);
  });
  container.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) return;
    handler(e);
  });
}

// ---- Health ----
async function pingHealth() {
  try {
    const h = await api.get("/api/health");
    $("#status").textContent = `online · ${h.activeStreams} stream${h.activeStreams === 1 ? "" : "s"}`;
    $("#status").className = "status ok";
  } catch {
    $("#status").textContent = "offline";
    $("#status").className = "status bad";
  }
}

// ---- Playlists ----
async function loadPlaylists() {
  state.playlists = await api.get("/api/playlists");
  renderPlaylists();
  const visible = visibleSavedPlaylists();
  if (!state.selectedPlaylistId && visible.length) selectPlaylist(visible[0].id);
  else if (state.selectedPlaylistId && !visible.some((playlist) => playlist.id === state.selectedPlaylistId)) {
    state.selectedPlaylistId = visible[0]?.id || null;
    renderItems();
  } else renderItems();
  refreshChannelSavedStates();
}

function isDownloadedVideosPlaylist(playlist) {
  return playlist?.meta?.kind === "downloaded-files";
}

function visibleSavedPlaylists() {
  return state.playlists.filter((playlist) => !isDownloadedVideosPlaylist(playlist));
}

function downloadedLocalItems() {
  return state.playlists
    .filter(isDownloadedVideosPlaylist)
    .flatMap((playlist) => playlist.items || [])
    .filter((item) => item.type === "file");
}

function renderPlaylists() {
  const ul = $("#playlistList");
  const playlists = visibleSavedPlaylists();
  if (!playlists.length) { ul.innerHTML = `<div class="empty">No playlists yet.<br>Tap “+ New”.</div>`; return; }
  ul.innerHTML = playlists.map((p) => `
    <li data-id="${p.id}" class="${p.id === state.selectedPlaylistId ? "active" : ""}">
      <div class="meta">
        <div class="title">${esc(p.name)}</div>
        <div class="sub">${esc(channelPlaylistSub(p))}</div>
      </div>
      <div class="row-actions manage-only">
        <button class="icon-btn" data-act="rename" title="Rename">✎</button>
        <button class="icon-btn danger" data-act="delPlaylist" title="Delete">🗑</button>
      </div>
    </li>`).join("");
}

function selectPlaylist(id) {
  state.selectedPlaylistId = id;
  renderPlaylists();
  renderItems();
  revealDrawerItems();
}

function currentPlaylist() { return state.playlists.find((p) => p.id === state.selectedPlaylistId) || null; }

// ---- Items ----
function itemRowHtml(it) {
  const category = isCountryChannelPlaylist(currentPlaylist()) ? `${esc(itemCategory(it))} · ` : "";
  return `<li data-id="${it.id}" class="${it.id === state.playingItemId ? "active" : ""}">
    <span class="badge ${it.type}">${it.type}</span>
    <div class="meta">
      <div class="title">${esc(it.title)}</div>
      <div class="sub">${category}${it.meta?.duration ? fmtDur(it.meta.duration) + " · " : ""}${esc((it.url || "").slice(0, 60))}</div>
    </div>
    <div class="row-actions manage-only">
      <button class="icon-btn danger" data-act="delItem" title="Remove">🗑</button>
    </div>
  </li>`;
}

function renderItems() {
  const p = currentPlaylist();
  $("#addItemBtn").disabled = !p;
  $("#itemsTitle").textContent = p ? p.name : "Select a playlist";
  const ul = $("#itemList");
  if (!p) { ul.innerHTML = `<div class="empty">Pick a playlist on the left.</div>`; return; }
  if (!p.items.length) { ul.innerHTML = `<div class="empty">Empty playlist.<br>Tap “+ Add” to add a stream, YouTube link, or download.</div>`; return; }
  if (!isCountryChannelPlaylist(p)) {
    ul.innerHTML = p.items.map(itemRowHtml).join("");
    return;
  }
  const byCategory = p.items.reduce((acc, it) => {
    const category = itemCategory(it);
    if (!acc.has(category)) acc.set(category, []);
    acc.get(category).push(it);
    return acc;
  }, new Map());
  ul.innerHTML = [...byCategory.keys()].sort(categorySort).map((category) => {
    const items = byCategory.get(category);
    return `<li class="category-header" role="presentation">
      <div class="meta"><div class="title">${esc(category)}</div><div class="sub">${items.length} channel${items.length === 1 ? "" : "s"}</div></div>
    </li>` + items.map(itemRowHtml).join("");
  }).join("");
}

function setManageSaved(enabled) {
  state.manageSaved = enabled;
  const panel = $("#playlistDrawer");
  const btn = $("#manageSavedBtn");
  panel.classList.toggle("manage", enabled);
  btn.textContent = enabled ? "Done" : "Manage";
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
}

// ---- Player ----
function timestampValue(startAt) {
  const n = Number(startAt);
  return Number.isFinite(n) && n > 0 ? Math.max(0, n) : 0;
}

function streamQuery(startAt = 0) {
  const p = new URLSearchParams({
    height: $("#ctlHeight").value,
    fps: $("#ctlFps").value,
    quality: $("#ctlQuality").value,
    _: Date.now(), // cache-bust so re-play restarts ffmpeg
  });
  const timestamp = timestampValue(startAt);
  if (timestamp) p.set("timestamp", String(Math.floor(timestamp * 1000) / 1000));
  return p.toString();
}

function audioQuery(startAt = 0) {
  const p = new URLSearchParams({ _: Date.now(), height: $("#ctlHeight").value });
  const timestamp = timestampValue(startAt);
  if (timestamp) p.set("timestamp", String(Math.floor(timestamp * 1000) / 1000));
  return p.toString();
}

let soundOn = true;
let replayFn = null;     // rebuilds the current stream with the latest control values
let mpegtsPlayer = null; // active mpegts.js player instance
let hlsAudioPlayer = null; // active hls.js player for audio-only Browser capture
let browserPcmAudio = null; // low-latency Browser capture via Web Audio
let activeCompat = null; // active MJPEG + audio fallback URLs
let audioPrompted = false;
let playbackPaused = false;
let pausedResumeAt = 0;
let desktopStreamActive = false;
let desktopHlsSessionId = null;
let desktopAudioHlsSessionId = null;
let desktopAudioHlsStopBase = "/api/desktop/audio-hls";
let desktopInputStatus = null;
let desktopInputActive = false;
let desktopInputPointerId = null;
let desktopInputLastMoveAt = 0;
let desktopInputLastErrorAt = 0;
let browserSessionId = null;
let browserStreamActive = false;
let realChromeActive = false;
let browserInputActive = false;
let browserInputPointerId = null;
let browserInputLastMoveAt = 0;
let browserInputLastErrorAt = 0;
let browserInputStartX = 0;
let browserInputStartY = 0;
let browserInputLastX = 0;
let browserInputLastY = 0;
let browserInputTouchScroll = false;
let browserInputTouchMoved = false;
let browserFullscreenTapAt = 0;
let browserFullscreenTapX = 0;
let browserFullscreenTapY = 0;
let browserSettingsTimer = null;
let browserSettingsInFlight = false;
let browserSettingsPending = false;
let browserSettingsOpen = false;
let browserViewport = { width: 1280, height: 720 };
let browserKeyboardFocusTimer = null;
let browserKeyboardSyncing = false;
let browserKeyboardLastValue = "";
let browserSessionPollLastTotal = null;
let browserAudioRetryTimer = null;
let youtubeAuthPairingTimer = null;
const DESKTOP_ZOOM_MIN = 1;
const DESKTOP_ZOOM_MAX = 4;
const DESKTOP_ZOOM_STEP = 0.25;
const BROWSER_ZOOM_MIN = 1;
const BROWSER_ZOOM_MAX = 4;
const BROWSER_ZOOM_STEP = 0.25;
const desktopZoom = {
  scale: 1,
  panX: 0,
  panY: 0,
  panPointerId: null,
  panLastX: 0,
  panLastY: 0,
};
const browserZoom = {
  scale: 1,
  panX: 0,
  panY: 0,
  pointers: new Map(),
  pinching: false,
  pinchStartDistance: 0,
  pinchStartScale: 1,
  pinchLastCenterX: 0,
  pinchLastCenterY: 0,
};

function setDesktopStreamActive(active) {
  desktopStreamActive = Boolean(active);
  document.body.classList.toggle("desktop-streaming", desktopStreamActive);
}

function setBrowserStreamActive(active) {
  browserStreamActive = Boolean(active);
  document.body.classList.toggle("browser-streaming", browserStreamActive);
  if (!browserStreamActive) {
    browserSettingsOpen = false;
    hideBrowserKeyboard();
  }
  renderBrowserInputUi();
  renderBrowserZoomUi();
}

let syntheticFullscreen = false;
let activeEmbedCode = "";
let activeEmbedHeight = "";
let streamAttempt = 0;
let streamWarnTimer = null;
let streamFailTimer = null;
let restreamTimer = null;
let qualitySwitchTimer = null;
let qualitySwitchGeneration = 0;
let pendingQualityRestore = null;
let autoplayEnabled = localStorage.getItem(AUTOPLAY_KEY) === "true";
let autoplayContext = null;
let autoplayAdvancing = false;
let fullscreenOverlayHideTimer = null;
const FULLSCREEN_OVERLAY_HIDE_MS = 5000;
const SLOW_BUFFER_STARTUP_SUGGEST_MS = 20000;
const SLOW_BUFFER_REBUFFER_SUGGEST_MS = 12000;
const SLOW_BUFFER_REPEAT_REBUFFER_SUGGEST_MS = 6000;
const SLOW_BUFFER_SYNC_SUGGEST_MS = 4000;
const SLOW_BUFFER_SUGGESTION_VISIBLE_MS = 10000;
const SLOW_BUFFER_SUGGESTION_MAX_PER_VIDEO = 3;
const SLOW_BUFFER_PROFILE = { height: "360", fps: "15", quality: "5" };
const ADAPTIVE_BUFFER_PROFILE_KEY = "ytStreamerAdaptiveBufferV2";
const ADAPTIVE_BUFFER_PROFILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ADAPTIVE_BUFFER_PROFILES = Object.freeze({
  fast: Object.freeze({ id: "fast", startupSeconds: 2, rebufferSeconds: 1.25, maxQueueSeconds: 4 }),
  balanced: Object.freeze({ id: "balanced", startupSeconds: 3, rebufferSeconds: 1.5, maxQueueSeconds: 5 }),
  resilient: Object.freeze({ id: "resilient", startupSeconds: 4, rebufferSeconds: 2, maxQueueSeconds: 6 }),
});
let slowBufferSuggestTimer = null;
let slowBufferCountdownTimer = null;
let slowBufferAutoHideTimer = null;
let slowBufferSuggestionShownAttempt = -1;
let slowBufferSuggestionScope = { key: "", count: 0, stopped: false };
let playbackStartupTraceSeq = 0;

function readAdaptiveBufferState() {
  try {
    const raw = JSON.parse(localStorage.getItem(ADAPTIVE_BUFFER_PROFILE_KEY) || "null");
    const tier = raw?.tier;
    const updatedAt = Number(raw?.updatedAt || 0);
    if (!ADAPTIVE_BUFFER_PROFILES[tier] || !updatedAt || Date.now() - updatedAt > ADAPTIVE_BUFFER_PROFILE_MAX_AGE_MS) {
      return { tier: "balanced", fastStreak: 0, updatedAt: Date.now() };
    }
    return { tier, fastStreak: Math.max(0, Math.min(3, Number(raw.fastStreak) || 0)), updatedAt };
  } catch {
    return { tier: "balanced", fastStreak: 0, updatedAt: Date.now() };
  }
}

function adaptiveBufferPolicy() {
  const state = readAdaptiveBufferState();
  return { ...ADAPTIVE_BUFFER_PROFILES[state.tier], learnedTier: state.tier };
}

function saveAdaptiveBufferState(state) {
  try {
    localStorage.setItem(ADAPTIVE_BUFFER_PROFILE_KEY, JSON.stringify({
      tier: ADAPTIVE_BUFFER_PROFILES[state?.tier] ? state.tier : "balanced",
      fastStreak: Math.max(0, Math.min(3, Number(state?.fastStreak) || 0)),
      updatedAt: Date.now(),
    }));
  } catch {}
}

function evaluateAdaptiveBufferSample(stats = {}) {
  const fps = Math.max(1, Number(stats.fps || 24));
  const renderedFps = Number(stats.renderedFps);
  const avgDecodeMs = Number(stats.averageDecodeMs);
  const frameBudgetMs = 1000 / fps;
  const rendered = Math.max(0, Number(stats.renderedFrames || 0));
  const dropped = Math.max(0, Number(stats.droppedFrames || 0));
  const dropRatio = dropped / Math.max(1, rendered + dropped);
  const driftMs = Math.abs(Number(stats.lastAvDriftMs || 0));
  const rebufferCount = Math.max(0, Number(stats.rebufferCount || 0));
  const renderRatio = Number.isFinite(renderedFps) ? renderedFps / fps : 0;
  const slow = rebufferCount > 0 || dropRatio > 0.05
    || (Number.isFinite(renderedFps) && renderRatio < 0.88)
    || (Number.isFinite(avgDecodeMs) && avgDecodeMs > frameBudgetMs * 0.75)
    || driftMs > 180;
  if (slow) return { grade: "slow", renderRatio, dropRatio, driftMs, frameBudgetMs };
  const fast = Number.isFinite(renderedFps) && renderRatio >= 0.97 && dropRatio < 0.01
    && (!Number.isFinite(avgDecodeMs) || avgDecodeMs <= frameBudgetMs * 0.45)
    && driftMs <= 100;
  return { grade: fast ? "fast" : "balanced", renderRatio, dropRatio, driftMs, frameBudgetMs };
}

function learnAdaptiveBufferProfile(stats, { force = false } = {}) {
  const fps = Math.max(1, Number(stats?.fps || 24));
  const renderedFrames = Math.max(0, Number(stats?.renderedFrames || 0));
  if (!force && renderedFrames < fps * 8) return null;
  const sample = evaluateAdaptiveBufferSample(stats);
  const previous = readAdaptiveBufferState();
  let nextTier = previous.tier;
  let fastStreak = previous.fastStreak;
  if (sample.grade === "slow") {
    nextTier = "resilient";
    fastStreak = 0;
  } else if (sample.grade === "fast") {
    fastStreak = Math.min(3, fastStreak + 1);
    if (fastStreak >= 2) nextTier = "fast";
    else if (nextTier === "resilient") nextTier = "balanced";
  } else {
    fastStreak = 0;
    nextTier = "balanced";
  }
  const changed = nextTier !== previous.tier || fastStreak !== previous.fastStreak;
  if (changed) saveAdaptiveBufferState({ tier: nextTier, fastStreak });
  return { ...sample, previousTier: previous.tier, nextTier, fastStreak, changed };
}

function beginPlaybackStartupTrace(kind, item = {}) {
  const trace = {
    id: ++playbackStartupTraceSeq,
    kind: String(kind || "play"),
    label: item.title || "Video",
    streamUrl: item.url || "",
    clickAt: performance.now(),
    playerStartedAt: null,
  };
  reportPlaybackEvent("play_click", {
    label: trace.label,
    streamUrl: trace.streamUrl,
    timing: { traceId: String(trace.id), kind: trace.kind, clickMs: 0 },
  });
  return trace;
}

function playbackStartupTiming(trace, stats = null) {
  if (!trace) return {};
  const out = { traceId: String(trace.id), kind: trace.kind };
  const playerOffset = Number.isFinite(trace.playerStartedAt) ? Math.max(0, trace.playerStartedAt - trace.clickAt) : 0;
  out.clickToPlayerMs = playerOffset;
  const mapping = {
    responseStartMs: "clickToResponseMs",
    firstByteMs: "clickToFirstByteMs",
    firstFrameReceivedMs: "clickToFirstFrameReceivedMs",
    firstFrameDecodedMs: "clickToFirstFrameDecodedMs",
    firstPictureMs: "clickToFirstPictureMs",
    bufferReadyMs: "clickToBufferReadyMs",
    audioReadyMs: "clickToAudioReadyMs",
    audioStartMs: "clickToAudioStartMs",
    firstRenderedMs: "clickToFirstRenderedMs",
    startupMs: "clickToPlayingMs",
  };
  for (const [source, target] of Object.entries(mapping)) {
    const raw = stats?.[source];
    if (raw == null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out[target] = playerOffset + value;
  }
  if (stats?.serverResolveMs != null && Number.isFinite(Number(stats.serverResolveMs))) out.serverResolveMs = Number(stats.serverResolveMs);
  if (stats?.serverFirstOutputMs != null && Number.isFinite(Number(stats.serverFirstOutputMs))) out.serverFirstOutputMs = Number(stats.serverFirstOutputMs);
  if (stats?.ffmpegFirstOutputMs != null && Number.isFinite(Number(stats.ffmpegFirstOutputMs))) out.ffmpegFirstOutputMs = Number(stats.ffmpegFirstOutputMs);
  if (stats?.resolveCache) out.resolveCache = String(stats.resolveCache);
  return out;
}

function applyLateVodDuration(duration) {
  const value = Number(duration || 0);
  if (!Number.isFinite(value) || value <= 0 || streamSeek.isLive) return;
  streamSeek.duration = value;
  streamSeek.seekable = true;
  streamSeek.showUnavailable = false;
  updateStreamSeekUi();
  if (!streamSeek.timer && $("#screen")?.classList.contains("playing")) startStreamSeekTimer();
}

function bufferedSlowdownDiagnosis(stats = null, reason = "buffering") {
  const s = stats || {};
  if (reason === "audio") return { kind: "audio", title: "Audio is buffering", detail: "Video quality will not fix an audio-only stall." };
  const targetFps = Math.max(1, Number(s.fps || 0));
  const receiveFps = Number(s.receiveFps);
  const renderedFps = Number(s.renderedFps);
  const queueSeconds = Number(s.queueSeconds || 0);
  const maxQueueSeconds = Number(s.maxQueueSeconds || 0);
  const driftMs = Math.abs(Number(s.lastAvDriftMs || 0));
  const dropped = Number(s.droppedFrames || 0);

  const enoughRenderedHistory = Number(s.renderedFrames || 0) >= Math.max(8, targetFps * 2);
  const rendererBehind = dropped > 0
    || (enoughRenderedHistory && Number.isFinite(renderedFps) && renderedFps < targetFps * 0.8 && queueSeconds >= Math.max(2, maxQueueSeconds * 0.65))
    || (driftMs > 220 && queueSeconds > 1.5);
  if (rendererBehind) {
    return {
      kind: "renderer",
      title: "This device is falling behind",
      detail: "Video frames are arriving, but rendering cannot keep up. Try Low for smoother real-time playback.",
    };
  }

  const producerSlow = Number.isFinite(receiveFps)
    && receiveFps < targetFps * 0.8
    && queueSeconds < Math.max(2, maxQueueSeconds * 0.4);
  if (producerSlow || s.queueTrend === "shrinking") {
    return {
      kind: "network",
      title: "Video delivery is too slow",
      detail: "The buffer is not refilling fast enough. Try Low to reduce video demand.",
    };
  }

  return {
    kind: reason === "syncing" ? "sync" : "buffering",
    title: reason === "syncing" ? "Video is catching up" : "Buffering is very slow",
    detail: "Try Low to reduce video demand while keeping normal playback speed.",
  };
}

const streamSeek = {
  seekable: false,
  isLive: false,
  showUnavailable: false,
  duration: 0,
  startAt: 0,
  timer: null,
  liveAtMs: 0,
};
const STREAM_WARN_MS = 12000;
const STREAM_FAIL_MS = 30000;
const COMPAT_STREAM_WARN_MS = 25000;
const COMPAT_STREAM_FAIL_MS = 60000;
const STREAM_END_GUARD_SECONDS = 2;

function currentSettingsLabel() {
  const h = $("#ctlHeight");
  const hl = h.value === "0" ? "Source" : h.value + "p";
  const q = $("#ctlQuality").selectedOptions[0]?.textContent || "";
  return `${hl} · ${$("#ctlFps").value}fps · ${q}`;
}

function streamSettingsSnapshot() {
  return {
    height: $("#ctlHeight").value,
    fps: $("#ctlFps").value,
    quality: $("#ctlQuality").value,
  };
}

function streamQualityProfileForSettings(settings = streamSettingsSnapshot()) {
  return Object.values(STREAM_QUALITY_PROFILES).find((profile) =>
    profile.height === String(settings.height)
    && profile.fps === String(settings.fps)
    && profile.quality === String(settings.quality)
  ) || null;
}

function storedStreamQualityProfile() {
  const id = localStorage.getItem(STREAM_QUALITY_PROFILE_KEY);
  return id && STREAM_QUALITY_PROFILES[id] ? STREAM_QUALITY_PROFILES[id] : null;
}

function applyStreamSettings(settings) {
  $("#ctlHeight").value = String(settings.height);
  $("#ctlFps").value = String(settings.fps);
  $("#ctlQuality").value = String(settings.quality);
}

function resetStreamSettings() {
  const stored = storedStreamQualityProfile();
  applyStreamSettings(stored || DEFAULT_STREAM_SETTINGS);
}

function qualityProfilesAvailableForCurrentMode() {
  const screen = $("#screen");
  return !desktopStreamActive
    && !browserStreamActive
    && !screen?.classList.contains("embed-mode")
    && !screen?.classList.contains("browser-mode");
}

function renderQuickQuality() {
  const current = streamQualityProfileForSettings();
  document.querySelectorAll("[data-stream-profile]").forEach((btn) => {
    const active = btn.dataset.streamProfile === current?.id;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const custom = $("#playerQualityCustom");
  if (custom) custom.hidden = Boolean(current);
  const slot = $("#playerQualitySlot");
  if (slot) {
    const unavailable = $("#screen")?.classList.contains("playing") && !qualityProfilesAvailableForCurrentMode();
    slot.hidden = Boolean(unavailable);
  }
}

function renderSettingOptions() {
  const height = $("#ctlHeight").value;
  document.querySelectorAll("#heightOptions [data-height]").forEach((btn) => {
    const active = btn.dataset.height === height;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const quality = $("#ctlQuality").value;
  document.querySelectorAll("#qualityOptions [data-quality-value]").forEach((btn) => {
    const active = btn.dataset.qualityValue === quality;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderFpsPresets() {
  const wrap = $("#ctlFpsPresets");
  if (!wrap) return;
  const current = $("#ctlFps").value;
  wrap.innerHTML = FPS_OPTIONS.map(({ value, label, risky }) => `
    <button
      class="fps-preset${risky ? " risky" : ""}${value === current ? " active" : ""}"
      data-fps="${value}"
      type="button"
      aria-pressed="${value === current ? "true" : "false"}"
    >${label}</button>
  `).join("");
}

function setBadge(mode, text, { revealControls = true } = {}) {
  const b = $("#streamBadge");
  if (mode === "hidden") { b.hidden = true; return; }
  b.hidden = false;
  b.className = "stream-badge " + mode;
  b.textContent = text;
  if (revealControls) showFullscreenOverlays({ withProgress: false });
}

function clearStreamTimers() {
  clearTimeout(streamWarnTimer);
  clearTimeout(streamFailTimer);
  clearTimeout(restreamTimer);
  streamWarnTimer = null;
  streamFailTimer = null;
  restreamTimer = null;
}

function clearStreamNotice() {
  const n = $("#streamNotice");
  n.hidden = true;
  n.className = "stream-notice";
  $("#streamNoticeTitle").textContent = "";
  $("#streamNoticeDetail").textContent = "";
}

function showStreamNotice(kind, title, detail) {
  const n = $("#streamNotice");
  n.hidden = false;
  n.className = "stream-notice " + kind;
  $("#streamNoticeTitle").textContent = title;
  $("#streamNoticeDetail").textContent = detail;
  showFullscreenOverlays();
}

function currentAttempt(attempt) {
  return attempt === streamAttempt;
}

function cancelSlowBufferSuggestionSchedule() {
  clearTimeout(slowBufferSuggestTimer);
  slowBufferSuggestTimer = null;
}

function hideSlowBufferSuggestion() {
  cancelSlowBufferSuggestionSchedule();
  clearInterval(slowBufferCountdownTimer);
  clearTimeout(slowBufferAutoHideTimer);
  slowBufferCountdownTimer = null;
  slowBufferAutoHideTimer = null;
  const popup = $("#slowBufferSuggestion");
  if (!popup) return;
  popup.classList.remove("is-counting");
  popup.hidden = true;
}

function slowBufferContentKey(streamUrl = "") {
  try {
    const parsed = new URL(String(streamUrl || ""), window.location.origin);
    for (const key of ["timestamp", "height", "fps", "quality", "_", "buffered"]) parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    return `${parsed.pathname}?${parsed.searchParams.toString()}`;
  } catch {
    return String(streamUrl || "").replace(/([?&])(timestamp|height|fps|quality|_|buffered)=[^&]*/gi, "$1");
  }
}

function setSlowBufferSuggestionScope(streamUrl = "") {
  const key = slowBufferContentKey(streamUrl);
  if (!key || key === slowBufferSuggestionScope.key) return;
  hideSlowBufferSuggestion();
  slowBufferSuggestionScope = { key, count: 0, stopped: false };
  slowBufferSuggestionShownAttempt = -1;
}

function slowBufferSuggestionAllowed() {
  return !slowBufferSuggestionScope.stopped
    && slowBufferSuggestionScope.count < SLOW_BUFFER_SUGGESTION_MAX_PER_VIDEO;
}

function stopSlowBufferSuggestions() {
  const stats = activeCompat?.bufferedPlayer?.getStats?.();
  slowBufferSuggestionScope.stopped = true;
  hideSlowBufferSuggestion();
  reportPlaybackEvent("slow_buffer_suggestions_stopped", {
    streamUrl: activeCompat?.mjpegUrl || "",
    reason: "user",
    message: `${slowBufferSuggestionScope.count}/${SLOW_BUFFER_SUGGESTION_MAX_PER_VIDEO} shown`,
    stats,
  });
  toast("Buffering suggestions stopped for this video");
}

function slowBufferProfileWouldHelp() {
  const height = Number.parseInt($("#ctlHeight")?.value || "0", 10);
  const fps = Number.parseInt($("#ctlFps")?.value || "0", 10);
  if (height > 0 && height <= 360 && fps > 0 && fps <= 15) return false;
  return Boolean(replayFn);
}

function showSlowBufferSuggestion(attempt, { reason = "buffering", label = "", streamUrl = "", stats = null } = {}) {
  if (!currentAttempt(attempt) || slowBufferSuggestionShownAttempt === attempt || !slowBufferSuggestionAllowed() || !slowBufferProfileWouldHelp()) return;
  const diagnosis = bufferedSlowdownDiagnosis(stats, reason);
  if (diagnosis.kind === "audio") return;
  const popup = $("#slowBufferSuggestion");
  if (!popup) return;
  slowBufferSuggestionShownAttempt = attempt;
  slowBufferSuggestionScope.count += 1;
  cancelSlowBufferSuggestionSchedule();
  clearInterval(slowBufferCountdownTimer);
  clearTimeout(slowBufferAutoHideTimer);
  popup.hidden = false;
  const title = $("#slowBufferTitle");
  const detail = $("#slowBufferDetail");
  if (title) title.textContent = diagnosis.title;
  if (detail) detail.textContent = diagnosis.detail;
  popup.classList.remove("is-counting");
  void popup.offsetWidth;
  popup.classList.add("is-counting");
  const startedAt = performance.now();
  const updateCountdown = () => {
    const remainingMs = Math.max(0, SLOW_BUFFER_SUGGESTION_VISIBLE_MS - (performance.now() - startedAt));
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const text = $("#slowBufferCountdownText");
    if (text) text.textContent = String(seconds);
    $("#slowBufferCountdown")?.setAttribute("aria-label", `Closes in ${seconds} second${seconds === 1 ? "" : "s"}`);
  };
  updateCountdown();
  slowBufferCountdownTimer = setInterval(updateCountdown, 200);
  slowBufferAutoHideTimer = setTimeout(() => hideSlowBufferSuggestion(), SLOW_BUFFER_SUGGESTION_VISIBLE_MS);
  reportPlaybackEvent("slow_buffer_suggestion", {
    label,
    streamUrl,
    reason,
    diagnosis: diagnosis.kind,
    message: `${slowBufferSuggestionScope.count}/${SLOW_BUFFER_SUGGESTION_MAX_PER_VIDEO}`,
    stats,
  });
  if (slowBufferSuggestionScope.count >= SLOW_BUFFER_SUGGESTION_MAX_PER_VIDEO) {
    reportPlaybackEvent("slow_buffer_suggestion_limit_reached", {
      label,
      streamUrl,
      reason: "max-per-video",
      message: String(SLOW_BUFFER_SUGGESTION_MAX_PER_VIDEO),
      stats,
    });
  }
}

function scheduleSlowBufferSuggestion(attempt, { reason = "startup", label = "", streamUrl = "", stats = null } = {}) {
  if (!currentAttempt(attempt) || slowBufferSuggestionShownAttempt === attempt || !slowBufferSuggestionAllowed() || slowBufferSuggestTimer || !slowBufferProfileWouldHelp()) return;
  if (reason === "audio") return;
  const rebufferCount = Number(stats?.rebufferCount || 0);
  const delay = reason === "startup"
    ? SLOW_BUFFER_STARTUP_SUGGEST_MS
    : ((reason === "syncing" || reason === "renderer")
      ? SLOW_BUFFER_SYNC_SUGGEST_MS
      : (rebufferCount >= 2 ? SLOW_BUFFER_REPEAT_REBUFFER_SUGGEST_MS : SLOW_BUFFER_REBUFFER_SUGGEST_MS));
  slowBufferSuggestTimer = setTimeout(() => {
    slowBufferSuggestTimer = null;
    if (!currentAttempt(attempt) || slowBufferSuggestionShownAttempt === attempt || !slowBufferSuggestionAllowed() || !slowBufferProfileWouldHelp()) return;
    const latest = activeCompat?.bufferedPlayer?.getStats?.();
    const latestDiagnosis = latest ? bufferedSlowdownDiagnosis(latest, reason) : null;
    const stillSlow = latest && (
      latest.state === "buffering"
      || (reason === "syncing" && latest.state === "syncing")
      || (reason === "renderer" && latestDiagnosis?.kind === "renderer")
    );
    if (!stillSlow) return;
    showSlowBufferSuggestion(attempt, { reason, label, streamUrl, stats: latest });
  }, delay);
}

function applySlowBufferSuggestion() {
  if (!replayFn) return hideSlowBufferSuggestion();
  const resumeAt = streamSeek.seekable ? streamReplayTime() : undefined;
  const attempt = streamAttempt;
  const stats = activeCompat?.bufferedPlayer?.getStats?.();
  $("#ctlHeight").value = SLOW_BUFFER_PROFILE.height;
  $("#ctlFps").value = SLOW_BUFFER_PROFILE.fps;
  $("#ctlQuality").value = SLOW_BUFFER_PROFILE.quality;
  renderFpsPresets();
  renderQuickQuality();
  renderSettingOptions();
  updateBwHint();
  hideSlowBufferSuggestion();
  reportPlaybackEvent("slow_buffer_suggestion_applied", {
    streamUrl: activeCompat?.mjpegUrl || "",
    reason: "360p/15fps/q5",
    stats,
  });
  toast("Switching to 360p · 15fps · Q5");
  replayFn(resumeAt);
  slowBufferSuggestionShownAttempt = attempt;
}

function streamErrorDetail(reason) {
  const s = String(reason || "");
  if (/403|forbidden|denied|access/i.test(s)) return "The source denied the request. VPN/geo blocking or a missing referer/user-agent is likely.";
  if (/404|not found/i.test(s)) return "The stream URL was not found. The channel may have moved or gone offline.";
  if (/429|too many/i.test(s)) return "Too many streams are active. Stop the current stream and retry.";
  if (/network|timeout|timed out|stalled/i.test(s)) return "The app could not get video data from the source fast enough. Try Retry, Lower quality, or another channel.";
  return s || "The app did not receive playable video. Try Retry, Lower quality, or another channel.";
}

function formatMpegtsError(type, detail, info) {
  const parts = [type, detail, info?.msg, info?.code, info?.reason].filter(Boolean).map(String);
  return streamErrorDetail(parts.join(" "));
}

function isAutoplayRejection(error) {
  return error?.name === "NotAllowedError" || /autoplay|user gesture|user interaction/i.test(String(error?.message || ""));
}

function handleVideoPlayRejection(attempt, error) {
  if (!currentAttempt(attempt)) return;
  if (isAutoplayRejection(error)) {
    setBadge("reconnecting", "▶ Tap to play");
    showStreamNotice("warning", "Playback needs a tap", "The browser blocked autoplay. Tap the video or Resume to start playback.");
    return;
  }
  failStreamAttempt(attempt, "Playback could not start", error?.message || "The browser could not start video playback.");
}

function maybeRestorePlaybackAfterQualitySwitch(attempt) {
  const pending = pendingQualityRestore;
  if (!pending
      || pending.generation !== qualitySwitchGeneration
      || attempt < pending.minAttempt
      || !currentAttempt(attempt)) return;
  pendingQualityRestore = null;
  if (!pending.pause) return;
  requestAnimationFrame(() => {
    if (currentAttempt(attempt) && !playbackPaused) pausePlayback();
  });
}

function markStreamLive(attempt) {
  if (!currentAttempt(attempt)) return;
  clearStreamTimers();
  clearStreamNotice();
  $("#screen").classList.remove("loading");
  setBadge("live", "● LIVE · " + currentSettingsLabel());
  if (streamSeek.seekable) {
    streamSeek.liveAtMs = Date.now();
    startStreamSeekTimer();
  }
  maybeRestorePlaybackAfterQualitySwitch(attempt);
}

function clampStreamSeekTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, streamSeek.duration ? Math.min(n, streamSeek.duration) : n);
}

function isStreamAtEnd(value = getStreamCurrentTime()) {
  if (!streamSeek.seekable || !streamSeek.duration) return false;
  const current = clampStreamSeekTime(value);
  return current >= Math.max(0, streamSeek.duration - STREAM_END_GUARD_SECONDS);
}

function streamReplayTime(value = getStreamCurrentTime()) {
  const current = clampStreamSeekTime(value);
  return isStreamAtEnd(current) ? 0 : current;
}

function streamSeekTarget(value) {
  const target = clampStreamSeekTime(value);
  if (!streamSeek.seekable || !streamSeek.duration) return target;
  return Math.min(target, Math.max(0, streamSeek.duration - STREAM_END_GUARD_SECONDS));
}

function getStreamCurrentTime() {
  if (!streamSeek.seekable) return 0;
  const bufferedTime = activeCompat?.bufferedPlayer?.currentTime?.();
  if (Number.isFinite(bufferedTime)) return clampStreamSeekTime(streamSeek.startAt + bufferedTime);
  const videoTime = $("#video").currentTime || 0;
  const audioTime = $("#audio").currentTime || 0;
  if (legacy.playing && audioTime > 0) return clampStreamSeekTime(audioTime);
  const mediaTime = Math.max(videoTime, audioTime);
  if (mediaTime > 0) return clampStreamSeekTime(streamSeek.startAt + mediaTime);
  if (streamSeek.liveAtMs) {
    return clampStreamSeekTime(streamSeek.startAt + ((Date.now() - streamSeek.liveAtMs) / 1000));
  }
  return clampStreamSeekTime(streamSeek.startAt);
}

function updateStreamSeekUi(current = getStreamCurrentTime()) {
  const panel = $("#streamSeek");
  const unavailable = $("#liveSeekStatus");
  if (!panel) return;
  panel.hidden = !streamSeek.seekable;
  if (unavailable) {
    unavailable.hidden = streamSeek.seekable || !streamSeek.showUnavailable;
    $("#liveSeekLabel").textContent = streamSeek.isLive ? "LIVE" : "VIDEO";
    $("#liveSeekDetail").textContent = streamSeek.isLive ? "Seeking unavailable" : "This video cannot be seeked";
  }
  if (!streamSeek.seekable) return;
  const duration = streamSeek.duration || 0;
  const pct = duration ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  $("#streamSeekFill").style.width = `${pct}%`;
  $("#streamSeekThumb").style.left = `${pct}%`;
  $("#streamSeekTrack").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("#streamSeekTime").textContent = `${clock(current)} / ${clock(duration)}`;
  $("#streamBackBtn").disabled = current <= 0;
  $("#streamForwardBtn").disabled = duration ? current >= duration - 1 : false;
  if (duration && current >= duration - 0.75) handleAutoplayEnd();
}

function canAutoHideScreenOverlays() {
  const screen = $("#screen");
  const noticeVisible = !$("#streamNotice")?.hidden;
  return Boolean(screen
    && screen.classList.contains("playing")
    && !screen.classList.contains("loading")
    && !screen.classList.contains("controls-interacting")
    && !playbackPaused
    && !noticeVisible);
}

function clearFullscreenOverlayHide() {
  clearTimeout(fullscreenOverlayHideTimer);
  fullscreenOverlayHideTimer = null;
  document.body.classList.remove("fullscreen-controls-idle");
}

function scheduleFullscreenOverlayHide() {
  clearTimeout(fullscreenOverlayHideTimer);
  if (!canAutoHideScreenOverlays()) {
    document.body.classList.remove("fullscreen-controls-idle");
    return;
  }
  fullscreenOverlayHideTimer = setTimeout(() => {
    fullscreenOverlayHideTimer = null;
    if (canAutoHideScreenOverlays()) document.body.classList.add("fullscreen-controls-idle");
  }, FULLSCREEN_OVERLAY_HIDE_MS);
}

function showFullscreenOverlays({ withProgress = true } = {}) {
  document.body.classList.remove("fullscreen-controls-idle");
  if (withProgress) updateStreamSeekUi();
  if (canAutoHideScreenOverlays()) scheduleFullscreenOverlayHide();
  else clearFullscreenOverlayHide();
}

function beginScreenControlInteraction() {
  $("#screen")?.classList.add("controls-interacting");
  clearFullscreenOverlayHide();
}

function endScreenControlInteraction() {
  $("#screen")?.classList.remove("controls-interacting");
  showFullscreenOverlays();
}

function renderAutoplayButton() {
  const btn = $("#autoplayBtn");
  if (!btn) return;
  btn.textContent = autoplayEnabled ? "Autoplay On" : "Autoplay Off";
  btn.setAttribute("aria-pressed", autoplayEnabled ? "true" : "false");
  btn.classList.toggle("secondary", autoplayEnabled);
  btn.classList.toggle("ghost", !autoplayEnabled);
}

function setAutoplayEnabled(enabled) {
  autoplayEnabled = Boolean(enabled);
  localStorage.setItem(AUTOPLAY_KEY, String(autoplayEnabled));
  renderAutoplayButton();
  toast(`Autoplay ${autoplayEnabled ? "on" : "off"}`);
}

function setAutoplayContext(kind = null, itemId = null, queue = []) {
  autoplayContext = kind && itemId
    ? { kind, itemId: String(itemId), queue: [...queue] }
    : null;
  autoplayAdvancing = false;
}

async function handleAutoplayEnd() {
  if (!autoplayEnabled || autoplayAdvancing || !autoplayContext) return;
  const context = autoplayContext;
  const currentIndex = context.queue.findIndex((item) => String(item.id) === context.itemId);
  const next = currentIndex >= 0 ? context.queue[currentIndex + 1] : null;
  autoplayContext = null;
  if (!next) {
    toast("Autoplay reached the end");
    return;
  }

  autoplayAdvancing = true;
  toast(`Up next: ${next.title || "Video"}`);
  try {
    if (context.kind === "recommendations") await streamRecommendation(next, context.queue);
    else if (context.kind === "youtube-search") await streamYoutubeSearchResult(next, context.queue);
    else if (context.kind === "library") playLegacyItem(next, null, 0, context.queue);
    else if (context.kind === "library-playlist") await streamLegacyPlaylistVideo(next, context.queue);
  } catch (e) {
    autoplayAdvancing = false;
    toast(e.message || "Could not autoplay next video", true);
  }
}

function stopStreamSeekTimer(reset = false) {
  clearInterval(streamSeek.timer);
  streamSeek.timer = null;
  streamSeek.liveAtMs = 0;
  if (reset) {
    streamSeek.seekable = false;
    streamSeek.isLive = false;
    streamSeek.showUnavailable = false;
    streamSeek.duration = 0;
    streamSeek.startAt = 0;
    updateStreamSeekUi(0);
  }
}

function startStreamSeekTimer() {
  clearInterval(streamSeek.timer);
  updateStreamSeekUi();
  streamSeek.timer = setInterval(updateStreamSeekUi, 500);
}

function configureStreamSeek(meta = {}, startAt = 0) {
  stopStreamSeekTimer(false);
  const duration = Number(meta.duration || 0);
  streamSeek.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  streamSeek.seekable = Boolean(meta.seekable && streamSeek.duration);
  streamSeek.isLive = Boolean(meta.isLive || meta.live);
  streamSeek.showUnavailable = Boolean(!streamSeek.seekable && (streamSeek.isLive || meta.seekable === false));
  streamSeek.startAt = clampStreamSeekTime(startAt);
  updateStreamSeekUi(streamSeek.startAt);
}

function seekStreamTo(time) {
  if (!streamSeek.seekable || !replayFn) return;
  const target = streamSeekTarget(time);
  streamSeek.startAt = target;
  streamSeek.liveAtMs = 0;
  updateStreamSeekUi(target);
  toast("Seeking to " + clock(target));
  replayFn(target);
}

function failStreamAttempt(attempt, title, detail) {
  if (!currentAttempt(attempt)) return;
  try { activeCompat?.bufferedPlayer?.destroy?.(); } catch {}
  streamAttempt++;
  clearStreamTimers();
  stopStreamSeekTimer(false);
  destroyPlayer();
  const screen = $("#screen"), video = $("#video"), img = $("#mjpeg"), canvas = $("#mjpegCanvas"), audio = $("#audio");
  screen.classList.remove("loading", "mjpeg-buffered-mode", "startup-preview");
  setBadge("error", "Stream failed");
  showStreamNotice("error", title, detail);
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  try { video.load(); } catch {}
  img.removeAttribute("src");
  if (canvas) {
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }
  try { audio.pause(); } catch {}
  audio.removeAttribute("src");
  try { audio.load(); } catch {}
  activeCompat = null;
  updateBufferedMjpegDebug(null);
  resetPauseControl(true);
  toast(title, true);
}

function setPauseButtonState(text, pressed) {
  const btn = $("#pauseBtn");
  if (!btn) return;
  btn.textContent = text;
  btn.setAttribute("aria-pressed", pressed ? "true" : "false");
  btn.setAttribute("aria-label", pressed ? "Resume playback" : "Pause playback");
}

function renderMuteButton() {
  const btn = $("#muteBtn");
  if (!btn) return;
  btn.textContent = soundOn ? "🔊 Sound" : "🔇 Muted";
  btn.setAttribute("aria-label", soundOn ? "Mute sound" : "Turn sound on");
  btn.setAttribute("aria-pressed", soundOn ? "false" : "true");
}

function resetPauseControl(disabled = false) {
  playbackPaused = false;
  pausedResumeAt = 0;
  const btn = $("#pauseBtn");
  const frame = $("#pauseFrame");
  $("#screen")?.classList.remove("playback-paused");
  if (frame) {
    frame.hidden = true;
    const context = frame.getContext("2d");
    context?.clearRect(0, 0, frame.width, frame.height);
  }
  if (btn) {
    btn.disabled = disabled;
  }
  setPauseButtonState("Ⅱ Pause", false);
}

function freezeMjpegFrame() {
  const img = $("#mjpeg");
  const frame = $("#pauseFrame");
  if (!img || !frame) return;
  const width = img.naturalWidth || img.clientWidth || 1280;
  const height = img.naturalHeight || img.clientHeight || 720;
  frame.width = width;
  frame.height = height;
  try { frame.getContext("2d")?.drawImage(img, 0, 0, width, height); } catch {}
  frame.hidden = false;
}

function pausePlayback() {
  if (playbackPaused || $("#pauseBtn")?.disabled) return;
  const screen = $("#screen");
  const video = $("#video");
  const img = $("#mjpeg");
  const audio = $("#audio");
  const bufferedPauseActive = screen.classList.contains("mjpeg-buffered-mode") && activeCompat?.bufferedPlayer;
  const restartableMjpegPause = screen.classList.contains("mjpeg-mode") && !bufferedPauseActive;
  pausedResumeAt = legacy.playing ? (audio.currentTime || 0) : getStreamCurrentTime();
  playbackPaused = true;
  try { video.pause(); } catch {}
  try { audio.pause(); } catch {}
  if (restartableMjpegPause && activeCompat?.browserPcm) destroyBrowserPcmAudio();
  else try { browserPcmAudio?.ctx?.suspend?.(); } catch {}
  if (realChromeActive && browserSessionId) void setRealChromeMediaPlayback("pause");
  if (bufferedPauseActive) {
    activeCompat.bufferedPlayer.pauseUser();
  } else if (restartableMjpegPause) {
    freezeMjpegFrame();
    streamAttempt++;
    clearStreamTimers();
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
  }
  clearInterval(streamSeek.timer);
  streamSeek.timer = null;
  if (streamSeek.seekable) {
    // A buffered pause keeps the same live player and its original timeline base.
    // Rebasing startAt here double-counts the paused position after Resume.
    if (restartableMjpegPause) streamSeek.startAt = pausedResumeAt;
    streamSeek.liveAtMs = 0;
    updateStreamSeekUi(pausedResumeAt);
  }
  screen.classList.add("playback-paused");
  setPauseButtonState("▶ Resume", true);
  const buffered = Number(activeCompat?.bufferedPlayer?.getStats?.().queueSeconds || 0);
  setBadge("paused", buffered > 0 ? "Ⅱ PAUSED · " + buffered.toFixed(1) + "s buf" : "Ⅱ PAUSED");
  showFullscreenOverlays();
}

async function resumePlayback() {
  if (!playbackPaused) return;
  const screen = $("#screen");
  const wasBufferedMjpeg = screen.classList.contains("mjpeg-buffered-mode") && activeCompat?.bufferedPlayer;
  const wasMjpeg = screen.classList.contains("mjpeg-mode");
  const resumeAt = streamReplayTime(pausedResumeAt);
  playbackPaused = false;
  screen.classList.remove("playback-paused");
  $("#pauseFrame").hidden = true;
  setPauseButtonState("Ⅱ Pause", false);
  showFullscreenOverlays();
  if (wasBufferedMjpeg) {
    activeCompat.bufferedPlayer.resumeUser();
    return;
  }
  if (wasMjpeg && replayFn) {
    if (realChromeActive && browserSessionId) await setRealChromeMediaPlayback("play");
    const result = replayFn(streamSeek.seekable || legacy.playing ? resumeAt : undefined);
    if (result?.catch) result.catch((e) => toast(e.message, true));
    return;
  }
  const video = $("#video");
  const audio = $("#audio");
  const attempt = streamAttempt;
  video.play().catch((error) => handleVideoPlayRejection(attempt, error));
  if (soundOn && activeCompat?.browserPcm) startBrowserPcmAudio(activeCompat.audioUrl, true);
  if (soundOn && audio.src) audio.play().catch(() => toast("Tap sound to resume audio"));
  markStreamLive(attempt);
}

function togglePlaybackPause() {
  if (playbackPaused) void resumePlayback();
  else pausePlayback();
}

function startStreamWatchdog(attempt, mode, { warnMs = STREAM_WARN_MS, failMs = STREAM_FAIL_MS } = {}) {
  clearStreamTimers();
  streamWarnTimer = setTimeout(() => {
    if (!currentAttempt(attempt)) return;
    setBadge("reconnecting", "Still connecting...");
    showStreamNotice(
      "warning",
      "Still connecting",
      `${mode} has not delivered a video frame yet. Waiting a bit longer before marking it failed.`
    );
  }, warnMs);
  streamFailTimer = setTimeout(() => {
    failStreamAttempt(
      attempt,
      "No video frames received",
      `The stream connection stayed open, but no playable video arrived after ${Math.round(failMs / 1000)} seconds. Try Retry, Lower quality, another channel, or check VPN/geo restrictions.`
    );
  }, failMs);
}

// Lazy-load mpegts.js: local copy first, CDN fallback.
let _mpegtsLoading = null;
let _hlsLoading = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("load failed: " + src));
    document.head.appendChild(s);
  });
}
async function ensureMpegts() {
  if (window.mpegts) return;
  if (_mpegtsLoading) return _mpegtsLoading;
  _mpegtsLoading = (async () => {
    for (const u of ["/vendor/mpegts.js", "https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js"]) {
      try { await loadScript(u); if (window.mpegts) return; } catch {}
    }
    throw new Error("Could not load the mpegts.js player");
  })();
  return _mpegtsLoading;
}

async function ensureHls() {
  if (window.Hls) return;
  if (_hlsLoading) return _hlsLoading;
  _hlsLoading = (async () => {
    for (const u of ["/vendor/hls.min.js", "https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js"]) {
      try { await loadScript(u); if (window.Hls) return; } catch {}
    }
    throw new Error("Could not load the HLS audio player");
  })();
  return _hlsLoading;
}

function destroyPlayer() {
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch {} mpegtsPlayer = null; }
}

function destroyAudioHlsPlayer() {
  if (hlsAudioPlayer) { try { hlsAudioPlayer.destroy(); } catch {} hlsAudioPlayer = null; }
}

function destroyBrowserPcmAudio() {
  const session = browserPcmAudio;
  browserPcmAudio = null;
  if (!session) return;
  session.closed = true;
  try { session.controller?.abort(); } catch {}
  try { session.processor?.disconnect(); } catch {}
  try { session.gain?.disconnect(); } catch {}
  try { session.ctx?.close?.(); } catch {}
}

function setBrowserPcmOutputHeld(held) {
  const session = browserPcmAudio;
  if (!session || session.closed) return;
  session.outputHeld = Boolean(held);
  if (session.gain) {
    const now = session.ctx?.currentTime || 0;
    try {
      session.gain.gain.cancelScheduledValues(now);
      session.gain.gain.setValueAtTime(session.outputHeld ? 0 : 1, now);
    } catch {
      session.gain.gain.value = session.outputHeld ? 0 : 1;
    }
  }
}

function releaseBrowserPcmOutput() {
  setBrowserPcmOutputHeld(false);
}

function browserPcmReady(session, timeoutMs = 1400) {
  if (!session || session.closed || session.ready) return Promise.resolve(Boolean(session?.ready));
  return Promise.race([
    session.readyPromise,
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function setRealChromeMediaPlayback(action) {
  if (!realChromeActive || !browserSessionId) return null;
  try {
    return await api.post(`/api/real-chrome/${encodeURIComponent(browserSessionId)}/media`, { action });
  } catch (error) {
    console.warn(`[real-chrome-media] ${action} failed:`, error.message);
    return null;
  }
}

function canTryMpegts() {
  return Boolean(window.MediaSource || window.ManagedMediaSource || window.mpegts);
}

function cleanupMedia() {
  const screen = $("#screen"), video = $("#video"), img = $("#mjpeg"), canvas = $("#mjpegCanvas"), audio = $("#audio");
  clearFullscreenOverlayHide();
  setDesktopStreamActive(false);
  setBrowserStreamActive(false);
  try { activeCompat?.bufferedPlayer?.destroy?.(); } catch {}
  screen.classList.remove("browser-mode", "browser-input-active", "browser-keyboard-active", "mjpeg-buffered-mode", "startup-preview");
  streamAttempt++;
  clearStreamTimers();
  clearStreamNotice();
  hideSlowBufferSuggestion();
  stopStreamSeekTimer(false);
  destroyPlayer();
  destroyAudioHlsPlayer();
  destroyBrowserPcmAudio();
  clearBrowserAudioRetry();
  clearEmbedFrame();
  try { video.pause(); } catch {}
  video.onplaying = null;
  video.onerror = null;
  video.onstalled = null;
  video.onwaiting = null;
  video.onended = null;
  video.removeAttribute("src");
  try { video.load(); } catch {}
  img.onload = null;
  img.onerror = null;
  img.removeAttribute("src");
  img.style.visibility = "";
  if (canvas) {
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }
  try { audio.pause(); } catch {}
  audio.onloadedmetadata = null;
  audio.onloadeddata = null;
  audio.oncanplay = null;
  audio.oncanplaythrough = null;
  audio.onerror = null;
  audio.onplaying = null;
  audio.onended = null;
  audio.removeAttribute("src");
  try { audio.load(); } catch {}
  activeCompat = null;
  updateBufferedMjpegDebug(null);
  audioPrompted = false;
}

function clearEmbedFrame(resetSize = true) {
  const screen = $("#screen");
  const frame = $("#embedFrame");
  if (!frame) return;
  frame.hidden = true;
  frame.removeAttribute("src");
  frame.removeAttribute("allow");
  frame.removeAttribute("width");
  frame.removeAttribute("height");
  frame.removeAttribute("frameborder");
  frame.removeAttribute("marginheight");
  frame.removeAttribute("marginwidth");
  frame.removeAttribute("scrolling");
  frame.removeAttribute("referrerpolicy");
  frame.removeAttribute("name");
  frame.allowFullscreen = false;
  frame.title = "Embedded player";
  screen.classList.remove("embed-mode");
  if (resetSize) {
    screen.style.height = "";
    screen.style.aspectRatio = "";
  }
}

function parseEmbedIframe(code) {
  const doc = new DOMParser().parseFromString(code, "text/html");
  const source = doc.querySelector("iframe");
  if (!source) throw new Error("Paste iframe embed code first");
  const src = (source.getAttribute("src") || "").trim();
  if (!/^https?:\/\//i.test(src)) throw new Error("Iframe src must start with http or https");
  return source;
}

function normalizedEmbedHeight(value) {
  const raw = String(value || "").trim();
  if (!raw) return "70vh";
  if (/^\d+$/.test(raw)) return `${raw}px`;
  if (/^\d+(?:\.\d+)?(px|vh|vw|vmin|vmax|rem|em|%)$/i.test(raw)) return raw;
  return "70vh";
}

function copyEmbedIframeAttributes(source, frame) {
  const allowed = ["title", "src", "scrolling", "allow", "width", "height", "frameborder", "marginheight", "marginwidth", "referrerpolicy", "name"];
  for (const attr of allowed) {
    const value = source.getAttribute(attr);
    if (value != null) frame.setAttribute(attr, value);
  }
  const fullscreenValue = source.getAttribute("allowfullscreen");
  frame.allowFullscreen = source.hasAttribute("allowfullscreen") && fullscreenValue !== "false";
  if (frame.allowFullscreen) frame.setAttribute("allowfullscreen", fullscreenValue || "true");
  frame.title = source.getAttribute("title") || "Embedded player";
}

function requestEmbedAutoplay(source) {
  const src = source.getAttribute("src");
  if (!src) return;
  const url = new URL(src);
  if (!url.searchParams.has("autoplay")) url.searchParams.set("autoplay", "1");
  if (!url.searchParams.has("muted")) url.searchParams.set("muted", "1");
  if (!url.searchParams.has("mute")) url.searchParams.set("mute", "1");
  if (!url.searchParams.has("playsinline")) url.searchParams.set("playsinline", "1");
  source.setAttribute("src", url.toString());
  const permissions = new Set((source.getAttribute("allow") || "").split(";").map((value) => value.trim()).filter(Boolean));
  permissions.add("autoplay");
  source.setAttribute("allow", [...permissions].join("; "));
}

function renderEmbedCode(code, heightValue) {
  const source = parseEmbedIframe(code);
  requestEmbedAutoplay(source);
  stopDesktopHlsSession();
  stopDesktopAudioHlsSession();
  cleanupMedia();
  resetPauseControl(true);
  stopStreamSeekTimer(true);
  setDesktopStreamActive(false);
  desktopInputActive = false;
  desktopInputPointerId = null;
  resetDesktopZoom();
  renderDesktopInputUi();

  const screen = $("#screen");
  const frame = $("#embedFrame");
  copyEmbedIframeAttributes(source, frame);
  frame.hidden = false;
  screen.style.height = normalizedEmbedHeight(heightValue || $("#embedHeight")?.value);
  screen.style.aspectRatio = "auto";
  screen.classList.remove("loading", "video-mode", "mjpeg-mode", "mjpeg-buffered-mode", "browser-mode", "browser-input-active");
  screen.classList.add("playing", "embed-mode");
  activeEmbedCode = code;
  activeEmbedHeight = heightValue || $("#embedHeight")?.value || "";
  replayFn = () => renderEmbedCode(activeEmbedCode, activeEmbedHeight);
  $("#nowPlaying").textContent = frame.title || "Embed Player";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  setBadge("live", "EMBED");
  $("#embedStatus").textContent = "Loaded · autoplay requested";
  if (isMobileMode()) setPlayerDropdownOpen(true);
}

function loadEmbedFromInput() {
  const input = $("#embedCodeInput");
  const code = input.value.trim();
  if (!code) {
    toast("Paste iframe embed code first", true);
    input.focus();
    return;
  }
  try {
    renderEmbedCode(code, $("#embedHeight").value);
  } catch (e) {
    $("#embedStatus").textContent = e.message;
    toast(e.message, true);
  }
}

function getLocalSavedEmbeds() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_EMBEDS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.code === "string") : [];
  } catch {
    return [];
  }
}

async function loadSavedEmbeds() {
  const local = getLocalSavedEmbeds();
  if (local.length) {
    await Promise.all(local.map((item) => api.post("/api/saved-embeds", item)));
    localStorage.removeItem(SAVED_EMBEDS_KEY);
  }
  state.savedEmbeds = await api.get("/api/saved-embeds");
  state.savedEmbedsLoaded = true;
  renderSavedEmbeds();
}

function formatEmbedSavedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved date unavailable";
  return `Saved ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function renderSavedEmbeds() {
  const list = $("#embedSavedList");
  if (!list) return;
  const saved = state.savedEmbeds;
  $("#embedSavedCount").textContent = `${saved.length} saved`;
  if (!saved.length) {
    list.innerHTML = '<div class="embed-saved-empty">No saved iframe codes yet.</div>';
    return;
  }
  list.innerHTML = saved.map((item) => `
    <article class="embed-saved-row" data-embed-id="${esc(item.id)}">
      <div class="embed-saved-info">
        <strong>${esc(item.title || "Embedded player")}</strong>
        <span class="embed-saved-src">${esc(item.src || "Iframe code")}</span>
        <time datetime="${esc(item.savedAt || "")}">${esc(formatEmbedSavedDate(item.savedAt))}</time>
      </div>
      <div class="embed-saved-actions">
        <button class="btn small" type="button" data-embed-action="load">Load</button>
        <button class="btn small danger" type="button" data-embed-action="delete">Delete</button>
      </div>
    </article>`).join("");
}

async function saveEmbedFromInput() {
  const code = $("#embedCodeInput").value.trim();
  if (!code) {
    toast("Paste iframe embed code first", true);
    $("#embedCodeInput").focus();
    return;
  }
  try {
    const source = parseEmbedIframe(code);
    const saved = await api.post("/api/saved-embeds", {
      title: source.getAttribute("title") || "Embedded player",
      src: source.getAttribute("src") || "",
      code,
      height: $("#embedHeight").value.trim(),
      savedAt: new Date().toISOString(),
    });
    const existingIndex = state.savedEmbeds.findIndex((item) => item.id === saved.id);
    if (existingIndex >= 0) state.savedEmbeds.splice(existingIndex, 1);
    state.savedEmbeds.unshift(saved);
    renderSavedEmbeds();
    $("#embedStatus").textContent = "Saved";
    toast("Iframe code saved");
  } catch (e) {
    $("#embedStatus").textContent = e.message;
    toast(e.message, true);
  }
}

async function handleSavedEmbedClick(e) {
  const button = e.target.closest("[data-embed-action]");
  const row = button?.closest("[data-embed-id]");
  if (!button || !row) return;
  const saved = state.savedEmbeds;
  const item = saved.find((entry) => entry.id === row.dataset.embedId);
  if (!item) return;
  if (button.dataset.embedAction === "delete") {
    try {
      await api.del(`/api/saved-embeds/${encodeURIComponent(item.id)}`);
    } catch (error) {
      toast(error.message, true);
      return;
    }
    state.savedEmbeds = saved.filter((entry) => entry.id !== item.id);
    renderSavedEmbeds();
    $("#embedStatus").textContent = "Saved iframe deleted";
    toast("Saved iframe deleted");
    return;
  }
  $("#embedCodeInput").value = item.code;
  $("#embedHeight").value = item.height || "70vh";
  try {
    renderEmbedCode(item.code, item.height);
  } catch (error) {
    $("#embedStatus").textContent = error.message;
    toast(error.message, true);
  }
}

function openEmbed() {
  if (!EMBED_FEATURE_VISIBLE) {
    setMode("watch");
    return;
  }
  setMode("embed");
  renderSavedEmbeds();
  loadSavedEmbeds().catch((error) => {
    $("#embedStatus").textContent = error.message;
    toast(error.message, true);
  });
  const input = $("#embedCodeInput");
  if (input && !input.value.trim()) input.value = DEFAULT_EMBED_CODE;
  requestAnimationFrame(() => {
    input?.focus();
    input?.select();
  });
}

function startCompatAudio(notify = false) {
  if (activeCompat?.browserPcm) return startBrowserPcmAudio(activeCompat.audioUrl, notify);
  const audio = $("#audio");
  if (!activeCompat?.audioUrl || !soundOn) return null;
  if (!audio.src && !hlsAudioPlayer) audio.src = activeCompat.audioUrl;
  audio.muted = false;
  const play = audio.play();
  if (play?.catch) {
    play.catch(() => {
      if (notify && !audioPrompted) {
        audioPrompted = true;
        toast("Tap the sound button to start audio");
      }
    });
  }
  return play || null;
}

function clearBrowserAudioRetry() {
  clearTimeout(browserAudioRetryTimer);
  browserAudioRetryTimer = null;
}

function maybeStartBrowserAudio(notify = false) {
  if (!browserStreamActive || !activeCompat?.browserAudio || !activeCompat.audioUrl || !soundOn || playbackPaused) return null;
  if (activeCompat.browserPcm) {
    if (browserPcmAudio?.outputHeld && !activeCompat.playbackStarted) return browserPcmAudio.readyPromise;
    return startBrowserPcmAudio(activeCompat.audioUrl, notify);
  }
  const audio = $("#audio");
  if (!audio || (!audio.paused && audio.readyState > HTMLMediaElement.HAVE_NOTHING)) return null;
  return startCompatAudio(notify);
}

function scheduleBrowserAudioRetry(attempt, notify = false) {
  clearBrowserAudioRetry();
  browserAudioRetryTimer = setTimeout(() => {
    browserAudioRetryTimer = null;
    if (!currentAttempt(attempt) || !browserStreamActive || !activeCompat?.browserAudio || !soundOn || playbackPaused) return;
    maybeStartBrowserAudio(notify);
    scheduleBrowserAudioRetry(attempt, false);
  }, 1500);
}

function retryBrowserAudioFromGesture() {
  maybeStartBrowserAudio(false);
}

function loadCompatVideo(attempt, mjpegUrl) {
  const img = $("#mjpeg");
  if (!currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl || activeCompat.videoStarted) return;
  activeCompat.videoStarted = true;
  img.src = mjpegUrl;
}

function audioReadyForSync(audio) {
  return audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

function canUseBrowserPcmAudio() {
  return Boolean(window.AudioContext || window.webkitAudioContext);
}

function isBrowserPcmUrl(url) {
  return /\/stream\/browser-pcm(?:[?#]|$)/i.test(String(url || ""));
}

function withUrlParam(url, key, value) {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set(key, String(value));
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function pcmUrlWithRate(url, rate) {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("rate", String(rate));
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function appendPcmChunk(session, value) {
  if (!value?.byteLength || session.closed) return;
  let bytes = value;
  if (session.carry?.byteLength) {
    const merged = new Uint8Array(session.carry.byteLength + value.byteLength);
    merged.set(session.carry, 0);
    merged.set(value, session.carry.byteLength);
    bytes = merged;
    session.carry = null;
  }
  const usable = bytes.byteLength - (bytes.byteLength % 4);
  if (usable !== bytes.byteLength) session.carry = bytes.slice(usable);
  if (usable < 4) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  const frames = usable / 4;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0, frame = 0; i < usable; i += 4, frame += 1) {
    left[frame] = view.getInt16(i, true) / 32768;
    right[frame] = view.getInt16(i + 2, true) / 32768;
  }
  session.chunks.push({ left, right, offset: 0, frames });
  session.queuedFrames += frames;
  if (!session.ready && session.queuedFrames >= session.targetFrames) {
    session.ready = true;
    session.readyAt = performance.now();
    session.readyResolve?.(true);
    session.readyResolve = null;
  }
  while (session.queuedFrames > session.maxFrames && session.chunks.length > 1) {
    const dropped = session.chunks.shift();
    session.queuedFrames -= (dropped.frames - dropped.offset);
    session.discontinuity = true;
  }
}

function fillPcmSilence(session, leftOut, rightOut, start = 0) {
  const fadeFrames = Math.min(session.fadeFrames, leftOut.length - start);
  const needsFade = Math.abs(session.lastLeft || 0) > 0.0001 || Math.abs(session.lastRight || 0) > 0.0001;
  let index = start;
  if (needsFade && fadeFrames > 0) {
    for (let i = 0; i < fadeFrames; i += 1) {
      const gain = 1 - ((i + 1) / fadeFrames);
      leftOut[index] = (session.lastLeft || 0) * gain;
      if (rightOut !== leftOut) rightOut[index] = (session.lastRight || 0) * gain;
      index += 1;
    }
  }
  leftOut.fill(0, index);
  if (rightOut !== leftOut) rightOut.fill(0, index);
  session.lastLeft = 0;
  session.lastRight = 0;
  session.starved = true;
}

function copyPcmFrames(session, chunk, leftOut, rightOut, start, count) {
  let offset = chunk.offset;
  let written = 0;
  if (session.discontinuity || session.fadeInRemaining > 0) {
    if (!session.fadeInRemaining) {
      session.fadeInRemaining = session.fadeFrames;
      session.fadeStartLeft = session.lastLeft || 0;
      session.fadeStartRight = session.lastRight || 0;
      session.discontinuity = false;
    }
    const fadeCount = Math.min(count, session.fadeInRemaining);
    for (let i = 0; i < fadeCount; i += 1) {
      const t = (session.fadeFrames - session.fadeInRemaining + i + 1) / session.fadeFrames;
      const left = chunk.left[offset + i];
      const right = chunk.right[offset + i];
      leftOut[start + i] = session.fadeStartLeft + ((left - session.fadeStartLeft) * t);
      if (rightOut !== leftOut) rightOut[start + i] = session.fadeStartRight + ((right - session.fadeStartRight) * t);
      session.fadeInRemaining -= 1;
    }
    written = fadeCount;
    offset += fadeCount;
  }
  if (written < count) {
    leftOut.set(chunk.left.subarray(offset, offset + count - written), start + written);
    if (rightOut !== leftOut) rightOut.set(chunk.right.subarray(offset, offset + count - written), start + written);
  }
  const lastIndex = chunk.offset + count - 1;
  session.lastLeft = chunk.left[lastIndex] || 0;
  session.lastRight = chunk.right[lastIndex] || 0;
}

function renderPcmAudio(session, event) {
  const leftOut = event.outputBuffer.getChannelData(0);
  const rightOut = event.outputBuffer.numberOfChannels > 1 ? event.outputBuffer.getChannelData(1) : leftOut;
  if (session.starved && session.queuedFrames < session.targetFrames) {
    fillPcmSilence(session, leftOut, rightOut);
    return;
  }
  if (session.starved) {
    session.starved = false;
    session.discontinuity = true;
  }
  if (session.queuedFrames > session.maxFrames) {
    while (session.queuedFrames > session.targetFrames && session.chunks.length > 1) {
      const dropped = session.chunks.shift();
      session.queuedFrames -= (dropped.frames - dropped.offset);
      session.discontinuity = true;
    }
  }
  let written = 0;
  while (written < leftOut.length) {
    const chunk = session.chunks[0];
    if (!chunk) {
      fillPcmSilence(session, leftOut, rightOut, written);
      break;
    }
    const available = chunk.frames - chunk.offset;
    const count = Math.min(available, leftOut.length - written);
    copyPcmFrames(session, chunk, leftOut, rightOut, written, count);
    chunk.offset += count;
    session.queuedFrames -= count;
    written += count;
    if (chunk.offset >= chunk.frames) session.chunks.shift();
  }
}

async function startBrowserPcmAudio(audioUrl, notify = false, { holdOutput = false } = {}) {
  if (!audioUrl || !soundOn) return null;
  if (!canUseBrowserPcmAudio()) {
    if (notify && !audioPrompted) {
      audioPrompted = true;
      toast("Low-latency audio is not supported here");
    }
    return null;
  }
  if (browserPcmAudio && browserPcmAudio.url === audioUrl && !browserPcmAudio.closed) {
    setBrowserPcmOutputHeld(holdOutput);
    const resumed = browserPcmAudio.ctx?.resume?.();
    if (resumed?.catch) resumed.catch(() => {});
    await browserPcmReady(browserPcmAudio);
    return resumed || null;
  }
  destroyBrowserPcmAudio();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new AudioCtx({ sampleRate: 48000 });
  } catch {
    ctx = new AudioCtx();
  }
  const processor = ctx.createScriptProcessor(1024, 0, 2);
  let readyResolve = null;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  const gain = ctx.createGain();
  gain.gain.value = holdOutput ? 0 : 1;
  const session = {
    url: audioUrl,
    ctx,
    processor,
    gain,
    controller: new AbortController(),
    chunks: [],
    queuedFrames: 0,
    targetFrames: Math.round(ctx.sampleRate * 0.05),
    maxFrames: Math.round(ctx.sampleRate * 0.12),
    ready: false,
    readyAt: 0,
    readyPromise,
    readyResolve,
    outputHeld: Boolean(holdOutput),
    fadeFrames: Math.max(64, Math.round(ctx.sampleRate * 0.003)),
    fadeInRemaining: 0,
    fadeStartLeft: 0,
    fadeStartRight: 0,
    lastLeft: 0,
    lastRight: 0,
    starved: true,
    discontinuity: false,
    carry: null,
    closed: false,
  };
  browserPcmAudio = session;
  processor.onaudioprocess = (event) => renderPcmAudio(session, event);
  processor.connect(gain);
  gain.connect(ctx.destination);
  const resume = ctx.resume();
  if (resume?.catch) {
    resume.catch(() => {
      if (notify && !audioPrompted) {
        audioPrompted = true;
        toast("Tap the player to start audio");
      }
    });
  }
  const streamUrl = pcmUrlWithRate(audioUrl, Math.round(ctx.sampleRate || 48000));
  fetch(streamUrl, { cache: "no-store", signal: session.controller.signal }).then(async (response) => {
    if (!response.ok || !response.body) {
      let detail = "";
      try {
        const raw = await response.text();
        try { detail = JSON.parse(raw)?.error || raw; } catch { detail = raw; }
      } catch {}
      throw new Error(detail || `PCM audio failed: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    while (!session.closed) {
      const { value, done } = await reader.read();
      if (done) break;
      appendPcmChunk(session, value);
    }
  }).catch((error) => {
    if (!session.closed && error.name !== "AbortError") {
      console.warn("[browser-pcm-audio] stream failed:", error.message);
      if (notify) toast(error.message, true);
    }
  });
  await browserPcmReady(session);
  return resume || null;
}

function measuredAudioStartupDelayMs(startedAt) {
  if (!startedAt) return 0;
  return Math.max(0, Math.min(5000, Math.round(performance.now() - startedAt)));
}

function bufferedMjpegSupported() {
  const canvas = $("#mjpegCanvas");
  return Boolean(window.BufferedMjpeg?.BufferedMjpegPlayer
    && window.BufferedMjpeg?.supportsBufferedMjpeg?.(canvas));
}

function updateBufferedMjpegDebug(stats = null) {
  window.__YT_STREAMER_BUFFER_STATS__ = stats ? { ...stats, updatedAt: Date.now() } : null;
}

function markBufferedStreamPlaying(attempt, stats = null, { revealControls = true } = {}) {
  if (!currentAttempt(attempt)) return;
  clearStreamTimers();
  clearStreamNotice();
  $("#screen").classList.remove("loading");
  const buffered = Number(stats?.queueSeconds || 0);
  const suffix = buffered > 0 ? " · " + buffered.toFixed(1) + "s buf" : "";
  setBadge("live", "▶ " + currentSettingsLabel() + suffix, { revealControls });
  if (streamSeek.seekable) {
    if (!streamSeek.timer) startStreamSeekTimer();
  }
  maybeRestorePlaybackAfterQualitySwitch(attempt);
}

function finishBufferedStream(attempt) {
  if (!currentAttempt(attempt)) return;
  clearStreamTimers();
  stopStreamSeekTimer(false);
  if (streamSeek.duration) {
    streamSeek.startAt = streamSeek.duration;
    updateStreamSeekUi(streamSeek.duration);
  } else {
    updateStreamSeekUi();
  }
  $("#screen").classList.remove("loading");
  setBadge("paused", "■ ENDED");
  resetPauseControl(true);
  void handleAutoplayEnd();
}

function retryBufferedAudioFromGesture() {
  return Boolean(activeCompat?.bufferedPlayer?.retryFromGesture?.());
}

function playBufferedMjpegStream({ mjpegUrl, audioUrl }, label, meta = {}) {
  if (!bufferedMjpegSupported()) {
    playCompatStream({ mjpegUrl, audioUrl }, label, meta);
    showStreamNotice(
      "warning",
      "Buffered playback unavailable",
      "This browser cannot use streaming fetch + canvas playback, so YT Streamer is using the legacy MJPEG player."
    );
    return;
  }

  if (legacy.playing && !meta.keepLegacyState) {
    state.legacyPlayingId = null;
    legacy.playing = null;
    legacy.resolution = null;
    renderLegacyLibrary();
  }

  const screen = $("#screen");
  const canvas = $("#mjpegCanvas");
  const audio = $("#audio");
  cleanupMedia();
  resetPauseControl(false);
  if (meta.autoplayContext) {
    setAutoplayContext(meta.autoplayContext.kind, meta.autoplayContext.itemId, meta.autoplayContext.queue);
  } else {
    setAutoplayContext();
  }
  configureStreamSeek(meta, meta.startAt || 0);

  const attempt = streamAttempt;
  const startupTrace = meta.startupTrace || null;
  if (startupTrace && !Number.isFinite(startupTrace.playerStartedAt)) startupTrace.playerStartedAt = performance.now();
  const bufferedUrl = withUrlParam(mjpegUrl, "buffered", "1");
  setSlowBufferSuggestionScope(bufferedUrl);
  let audioFailed = false;
  const parsed = new URL(bufferedUrl, window.location.origin);
  const requestedFps = Math.max(1, Number(parsed.searchParams.get("fps") || $("#ctlFps").value || 24));
  const bufferPolicy = adaptiveBufferPolicy();
  window.__YT_STREAMER_BUFFER_POLICY__ = { ...bufferPolicy, selectedAt: Date.now() };
  let adaptiveBufferLearned = false;
  reportPlaybackEvent("buffered_start", {
    label,
    streamUrl: bufferedUrl,
    reason: `fps=${requestedFps};buffer=${bufferPolicy.id}:${bufferPolicy.startupSeconds}/${bufferPolicy.maxQueueSeconds}/${bufferPolicy.rebufferSeconds}`,
    timing: playbackStartupTiming(startupTrace),
  });

  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  screen.classList.remove("video-mode", "mjpeg-mode", "startup-preview");
  screen.classList.add("playing", "loading", "mjpeg-buffered-mode");
  setBadge("reconnecting", "Buffering 0.0 / " + bufferPolicy.startupSeconds.toFixed(1) + "s");
  startStreamWatchdog(attempt, "Buffered MJPEG playback", {
    warnMs: COMPAT_STREAM_WARN_MS,
    failMs: COMPAT_STREAM_FAIL_MS,
  });

  activeCompat = {
    mjpegUrl: bufferedUrl,
    audioUrl,
    audioReady: !audioUrl || !soundOn,
    videoReady: false,
    videoStarted: true,
    playbackStarted: false,
    buffered: true,
    bufferedPlayer: null,
    browserAudio: false,
    browserPcm: false,
  };

  let player = null;
  let loggedPlaying = false;
  let loggedRebufferCount = 0;
  player = new window.BufferedMjpeg.BufferedMjpegPlayer({
    url: bufferedUrl,
    canvas,
    audio,
    fps: requestedFps,
    audioClockOffset: meta.audioElementStartAt || 0,
    sessionId: attempt,
    isCurrent: (sessionId) => currentAttempt(sessionId)
      && activeCompat?.bufferedPlayer === player
      && activeCompat?.mjpegUrl === bufferedUrl,
    audioEnabled: () => Boolean(audioUrl && soundOn && !audioFailed),
    startupSeconds: bufferPolicy.startupSeconds,
    rebufferSeconds: bufferPolicy.rebufferSeconds,
    maxQueueSeconds: bufferPolicy.maxQueueSeconds,
    maxQueueBytes: 24 * 1024 * 1024,
    maxFrameBytes: 3 * 1024 * 1024,
    onState: (stateName, detail = {}) => {
      if (!currentAttempt(attempt) || activeCompat?.bufferedPlayer !== player) return;
      const stats = detail.stats || player.getStats();
      updateBufferedMjpegDebug(stats);
      if (stateName === "buffering") {
        screen.classList.add("loading");
        if (detail.reason === "audio" || detail.reason === "resume") cancelSlowBufferSuggestionSchedule();
        else scheduleSlowBufferSuggestion(attempt, { reason: detail.reason || "rebuffer", label, streamUrl: bufferedUrl, stats });
        if (stats.rebufferCount > loggedRebufferCount) {
          loggedRebufferCount = stats.rebufferCount;
          const learned = learnAdaptiveBufferProfile(stats, { force: true });
          if (learned) {
            reportPlaybackEvent("adaptive_buffer_learned", {
              label,
              streamUrl: bufferedUrl,
              reason: learned.grade,
              message: `${learned.previousTier}->${learned.nextTier}`,
              stats,
            });
          }
          reportPlaybackEvent("buffered_rebuffer", { label, streamUrl: bufferedUrl, reason: detail.reason, stats });
        }
        const buffered = Number(detail.bufferedSeconds ?? stats.queueSeconds ?? 0);
        const target = Number(detail.targetSeconds || (stats.renderedFrames ? stats.recoveryTargetSeconds || bufferPolicy.rebufferSeconds : bufferPolicy.startupSeconds));
        if (detail.reason === "audio") {
          setBadge("reconnecting", "Buffering audio · " + buffered.toFixed(1) + "s video ready");
        } else {
          setBadge("reconnecting", "Buffering " + buffered.toFixed(1) + " / " + target.toFixed(1) + "s");
        }
        return;
      }
      if (stateName === "autoplay-blocked") {
        cancelSlowBufferSuggestionSchedule();
        screen.classList.remove("loading");
        setBadge("reconnecting", "▶ Tap to start audio");
        showStreamNotice(
          "warning",
          "Playback needs a tap",
          "Audio is ready, but the browser requires a user gesture. Tap the player or Resume to start synchronized playback."
        );
        return;
      }
      if (stateName === "syncing") {
        screen.classList.remove("loading");
        scheduleSlowBufferSuggestion(attempt, { reason: "syncing", label, streamUrl: bufferedUrl, stats });
        setBadge("reconnecting", "Catching up video…");
        return;
      }
      if (stateName === "playing") {
        cancelSlowBufferSuggestionSchedule();
        screen.classList.remove("startup-preview");
        activeCompat.playbackStarted = true;
        activeCompat.videoReady = true;
        if (!loggedPlaying) {
          loggedPlaying = true;
          reportPlaybackEvent("buffered_playing", {
            label,
            streamUrl: bufferedUrl,
            stats,
            timing: playbackStartupTiming(startupTrace, stats),
            diagnosis: bufferedSlowdownDiagnosis(stats, "playing").kind,
          });
        }
        markBufferedStreamPlaying(attempt, stats);
        return;
      }
      if (stateName === "background") {
        setBadge("paused", "Paused in background");
      }
    },
    onMilestone: (name, detail = {}) => {
      if (!currentAttempt(attempt) || activeCompat?.bufferedPlayer !== player) return;
      const stats = detail.stats || player.getStats();
      if (name === "first-picture") {
        screen.classList.add("startup-preview");
        setBadge("reconnecting", "Preview ready · buffering for smooth playback", { revealControls: false });
      }
      reportPlaybackEvent("buffered_" + String(name).replace(/-/g, "_"), {
        label,
        streamUrl: bufferedUrl,
        stats,
        timing: playbackStartupTiming(startupTrace, stats),
        diagnosis: bufferedSlowdownDiagnosis(stats, stats.state).kind,
      });
    },
    onStats: (stats) => {
      if (!currentAttempt(attempt) || activeCompat?.bufferedPlayer !== player) return;
      updateBufferedMjpegDebug(stats);
      if (stats.state === "buffering") {
        const target = stats.renderedFrames ? Number(stats.recoveryTargetSeconds || bufferPolicy.rebufferSeconds) : bufferPolicy.startupSeconds;
        const prefix = playbackPaused ? "Paused · buffering " : "Buffering ";
        setBadge("reconnecting", prefix + stats.queueSeconds.toFixed(1) + " / " + target.toFixed(1) + "s", { revealControls: false });
      } else if (stats.state === "paused") {
        setBadge("paused", "Ⅱ PAUSED · " + stats.queueSeconds.toFixed(1) + "s buf", { revealControls: false });
      } else if (stats.state === "playing") {
        if (!adaptiveBufferLearned && stats.renderedFrames >= Math.max(1, Math.round(stats.fps * 8))) {
          adaptiveBufferLearned = true;
          const learned = learnAdaptiveBufferProfile(stats);
          if (learned) {
            reportPlaybackEvent("adaptive_buffer_learned", {
              label,
              streamUrl: bufferedUrl,
              reason: learned.grade,
              message: `${learned.previousTier}->${learned.nextTier}`,
              stats,
            });
          }
        }
        const diagnosis = bufferedSlowdownDiagnosis(stats, "renderer");
        if (diagnosis.kind === "renderer" && stats.renderedFrames >= Math.max(1, Math.round(stats.fps * 3))) {
          scheduleSlowBufferSuggestion(attempt, { reason: "renderer", label, streamUrl: bufferedUrl, stats });
        }
        if (stats.renderedFrames % Math.max(1, Math.round(stats.fps)) === 0) {
          // Refresh the live badge text without waking fullscreen controls every second.
          markBufferedStreamPlaying(attempt, stats, { revealControls: false });
        }
      }
    },
    onError: (error) => {
      if (!currentAttempt(attempt)) return;
      reportPlaybackEvent("buffered_error", {
        label,
        streamUrl: bufferedUrl,
        message: error?.message || String(error || ""),
        errorName: error?.name || "Error",
        stats: player?.getStats?.(),
      });
      failStreamAttempt(
        attempt,
        "Buffered MJPEG playback failed",
        streamErrorDetail(error?.message || "The browser could not parse or render the MJPEG stream.")
      );
    },
    onEnded: () => {
      reportPlaybackEvent("buffered_ended", { label, streamUrl: bufferedUrl, stats: player?.getStats?.() });
      finishBufferedStream(attempt);
    },
  });

  activeCompat.bufferedPlayer = player;
  updateBufferedMjpegDebug(player.getStats());
  audio.muted = !soundOn;

  if (audioUrl && soundOn) {
    const markAudioReady = () => {
      if (!currentAttempt(attempt) || activeCompat?.bufferedPlayer !== player) return;
      if (!audioReadyForSync(audio)) return;
      activeCompat.audioReady = true;
      player.setAudioReady(true);
    };
    audio.onloadedmetadata = () => {
      if (meta.audioElementStartAt) {
        try { audio.currentTime = meta.audioElementStartAt; } catch {}
      }
      markAudioReady();
    };
    audio.onloadeddata = markAudioReady;
    audio.oncanplay = markAudioReady;
    audio.oncanplaythrough = markAudioReady;
    audio.onerror = () => {
      if (!currentAttempt(attempt) || activeCompat?.bufferedPlayer !== player) return;
      audioFailed = true;
      activeCompat.audioReady = true;
      toast("Audio failed; continuing with video clock", true);
      player.setAudioReady(true);
    };
    setCompatAudioSource(audio, audioUrl).then(() => {
      markAudioReady();
    }).catch((error) => {
      if (!currentAttempt(attempt) || activeCompat?.bufferedPlayer !== player) return;
      console.warn("[buffered-mjpeg-audio] source failed:", error.message);
      audioFailed = true;
      activeCompat.audioReady = true;
      player.setAudioReady(true);
    });
  } else {
    player.setAudioReady(true);
  }

  void player.start();
}

function playCompatStream({ mjpegUrl, audioUrl }, label, meta = {}) {
  const screen = $("#screen"), img = $("#mjpeg"), audio = $("#audio");
  cleanupMedia();
  resetPauseControl(false);
  if (meta.autoplayContext) {
    setAutoplayContext(meta.autoplayContext.kind, meta.autoplayContext.itemId, meta.autoplayContext.queue);
  } else {
    setAutoplayContext();
  }
  configureStreamSeek(meta, meta.startAt || 0);
  const attempt = streamAttempt;
  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  screen.classList.remove("video-mode");
  screen.classList.add("playing", "loading", "mjpeg-mode");
  setBadge("reconnecting", "↻ Connecting…");
  startStreamWatchdog(attempt, "MJPEG fallback", {
    warnMs: COMPAT_STREAM_WARN_MS,
    failMs: COMPAT_STREAM_FAIL_MS,
  });
  activeCompat = {
    mjpegUrl,
    audioUrl,
    audioReady: false,
    videoReady: false,
    videoStarted: false,
    playbackStarted: false,
    browserAudio: Boolean(meta.browserAudio),
    browserPcm: Boolean(meta.browserPcm),
  };
  audio.onended = handleAutoplayEnd;

  const releaseCompatPlayback = () => {
    if (!currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl || activeCompat.playbackStarted) return;
    if (!activeCompat.videoReady) return;
    if (audioUrl && soundOn && !activeCompat.audioReady && !meta.looseAudioSync) return;
    activeCompat.playbackStarted = true;
    if (audioUrl && soundOn && activeCompat.audioReady && !meta.looseAudioSync && activeCompat.browserPcm) {
      releaseBrowserPcmOutput();
      img.style.visibility = "";
      markStreamLive(attempt);
      return;
    }
    if (audioUrl && soundOn && activeCompat.audioReady && !meta.looseAudioSync) {
      let revealed = false;
      const revealAfterAudioStarts = () => {
        if (revealed || !currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl) return;
        revealed = true;
        audio.onplaying = null;
        img.style.visibility = "";
        markStreamLive(attempt);
      };
      audio.onplaying = revealAfterAudioStarts;
      const play = startCompatAudio(true);
      if (play?.then) {
        play.then(revealAfterAudioStarts).catch(() => {
          setTimeout(revealAfterAudioStarts, 1200);
        });
      } else {
        setTimeout(revealAfterAudioStarts, 100);
      }
      return;
    }
    img.style.visibility = "";
    markStreamLive(attempt);
  };

  img.onload = () => {
    if (activeCompat?.mjpegUrl !== mjpegUrl) return;
    activeCompat.videoReady = true;
    releaseCompatPlayback();
  };
  img.onerror = () => {
    if (activeCompat?.mjpegUrl !== mjpegUrl) return;
    if (activeCompat.videoReady && isStreamAtEnd()) {
      clearStreamTimers();
      stopStreamSeekTimer(false);
      streamSeek.startAt = streamSeek.duration;
      streamSeek.liveAtMs = 0;
      updateStreamSeekUi(streamSeek.duration);
      screen.classList.remove("loading");
      setBadge("paused", "■ ENDED");
      resetPauseControl(true);
      void handleAutoplayEnd();
      return;
    }
    if (meta.browserStream) {
      void stopBrowserSession();
      failStreamAttempt(attempt, "Browser stream failed", "The headless browser session stopped before it produced usable MJPEG frames. Try Reload, lower FPS, or open the site in Desktop mode.");
      return;
    }
    failStreamAttempt(attempt, "Mac could not convert stream", "The source opened, but ffmpeg did not produce MJPEG video frames. Try Lower quality, a lower resolution, or another channel.");
  };

  audio.muted = !soundOn;
  if (audioUrl && soundOn) {
    if (!meta.looseAudioSync) {
      img.style.visibility = "hidden";
      setBadge("reconnecting", "↻ Syncing A/V…");
    }
    const loadVideoIfAudioReady = () => {
      if (!currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl) return;
      if (!audioReadyForSync(audio)) return;
      activeCompat.audioReady = true;
      if (meta.syncVideoToAudio && !activeCompat.videoStarted) {
        const videoDelayMs = measuredAudioStartupDelayMs(activeCompat.audioLoadStartedAt);
        if (videoDelayMs > 0) {
          mjpegUrl = withUrlParam(mjpegUrl, "videoDelay", videoDelayMs);
          activeCompat.mjpegUrl = mjpegUrl;
        }
      }
      if (meta.looseAudioSync && activeCompat.playbackStarted) {
        const play = startCompatAudio(true);
        if (play?.catch) play.catch(() => {});
      } else {
        loadCompatVideo(attempt, mjpegUrl);
        releaseCompatPlayback();
      }
    };
    audio.onloadeddata = loadVideoIfAudioReady;
    audio.oncanplay = loadVideoIfAudioReady;
    audio.oncanplaythrough = loadVideoIfAudioReady;
    audio.onerror = () => {
      if (!currentAttempt(attempt)) return;
      toast("Audio failed, starting video");
      activeCompat.audioReady = true;
      loadCompatVideo(attempt, mjpegUrl);
      releaseCompatPlayback();
    };
    activeCompat.audioLoadStartedAt = performance.now();
    setCompatAudioSource(audio, audioUrl, {
      holdPcmOutput: Boolean(activeCompat.browserPcm && !meta.looseAudioSync),
    }).catch((e) => {
      if (!currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl) return;
      console.warn("[compat-audio] failed to attach audio source:", e.message);
      activeCompat.audioReady = true;
      loadCompatVideo(attempt, mjpegUrl);
      releaseCompatPlayback();
      return false;
    }).then((attached) => {
      if (attached === false || !currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl || !meta.browserAudio) return;
      activeCompat.audioReady = true;
      if (activeCompat.browserPcm && !meta.looseAudioSync) {
        loadCompatVideo(attempt, mjpegUrl);
        releaseCompatPlayback();
      } else {
        maybeStartBrowserAudio(true);
        scheduleBrowserAudioRetry(attempt, true);
      }
    });
    if (meta.looseAudioSync) {
      loadCompatVideo(attempt, mjpegUrl);
    } else {
      loadVideoIfAudioReady();
    }
  } else {
    activeCompat.audioReady = true;
    loadCompatVideo(attempt, mjpegUrl);
  }
}

// Play one synced MPEG-TS stream (H.264+AAC) via mpegts.js / MSE.
async function playStream(sources, label, meta = {}) {
  const { tsUrl, mjpegUrl, audioUrl } = typeof sources === "string" ? { tsUrl: sources } : sources;
  if (meta.bufferedMjpeg && mjpegUrl) return playBufferedMjpegStream({ mjpegUrl, audioUrl }, label, meta);
  const screen = $("#screen"), video = $("#video");
  if (legacy.playing) {
    state.legacyPlayingId = null;
    legacy.playing = null;
    legacy.resolution = null;
    renderLegacyLibrary();
  }
  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  cleanupMedia();
  resetPauseControl(false);
  if (meta.autoplayContext) {
    setAutoplayContext(meta.autoplayContext.kind, meta.autoplayContext.itemId, meta.autoplayContext.queue);
  } else {
    setAutoplayContext();
  }
  configureStreamSeek(meta, meta.startAt || 0);
  const attempt = streamAttempt;
  if (mjpegUrl && !canTryMpegts()) return playCompatStream({ mjpegUrl, audioUrl }, label, meta);
  screen.classList.remove("mjpeg-mode");
  screen.classList.add("playing", "loading", "video-mode");
  setBadge("reconnecting", "↻ Connecting…");
  startStreamWatchdog(attempt, "MPEG-TS playback");
  try { await ensureMpegts(); } catch (e) {
    if (mjpegUrl) return playCompatStream({ mjpegUrl, audioUrl }, label, meta);
    failStreamAttempt(attempt, "Player failed to load", streamErrorDetail(e.message)); return;
  }
  if (!currentAttempt(attempt)) return;
  if (!window.mpegts || !mpegts.isSupported()) {
    if (mjpegUrl) return playCompatStream({ mjpegUrl, audioUrl }, label, meta);
    failStreamAttempt(attempt, "Unsupported browser player", "This browser cannot play MPEG-TS/MSE video for this stream."); return;
  }

  mpegtsPlayer = mpegts.createPlayer({ type: "mpegts", isLive: true, url: tsUrl }, {
    enableWorker: true,
    enableStashBuffer: true,
    liveBufferLatencyChasing: false,
    liveBufferLatencyMaxLatency: 8,
    liveBufferLatencyMinRemain: 2,
    lazyLoad: false,
    stashInitialSize: 384,
  });
  mpegtsPlayer.attachMediaElement(video);
  mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
    if (!currentAttempt(attempt)) return;
    if (mjpegUrl) return playCompatStream({ mjpegUrl, audioUrl }, label, meta);
    failStreamAttempt(attempt, "Stream playback failed", formatMpegtsError(type, detail, info));
  });
  video.onplaying = () => markStreamLive(attempt);
  video.onerror = () => failStreamAttempt(attempt, "Browser video error", streamErrorDetail(video.error?.message || "video element failed"));
  video.onstalled = () => {
    if (currentAttempt(attempt)) setBadge("reconnecting", "Buffering...");
  };
  video.onwaiting = () => {
    if (currentAttempt(attempt)) setBadge("reconnecting", "Buffering...");
  };
  video.onended = handleAutoplayEnd;
  video.muted = !soundOn;
  mpegtsPlayer.load();
  video.play().catch((error) => handleVideoPlayRejection(attempt, error));
}

function playNativeVideoStream({ nativeUrl, fallback }, label, meta = {}) {
  const screen = $("#screen"), video = $("#video");
  cleanupMedia();
  resetPauseControl(false);
  setAutoplayContext();
  configureStreamSeek(meta, meta.startAt || 0);
  const attempt = streamAttempt;
  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  screen.classList.remove("mjpeg-mode");
  screen.classList.add("playing", "loading", "video-mode");
  setBadge("reconnecting", "↻ Connecting…");
  startStreamWatchdog(attempt, "native video playback");
  video.muted = !soundOn;
  video.playsInline = true;
  video.onplaying = () => markStreamLive(attempt);
  video.oncanplay = () => markStreamLive(attempt);
  video.onerror = () => {
    if (!currentAttempt(attempt)) return;
    meta.onNativeFallback?.();
    if (fallback) return playStream(fallback, label, meta);
    failStreamAttempt(attempt, "Browser video error", streamErrorDetail(video.error?.message || "video element failed"));
  };
  video.onstalled = () => {
    if (currentAttempt(attempt)) setBadge("reconnecting", "Buffering...");
  };
  video.onwaiting = () => {
    if (currentAttempt(attempt)) setBadge("reconnecting", "Buffering...");
  };
  video.onended = handleAutoplayEnd;
  video.src = nativeUrl;
  try { video.load(); } catch {}
  video.play().catch((error) => handleVideoPlayRejection(attempt, error));
}

function refreshYoutubeMetadataInBackground(item, trace, { savedItem = false, active = () => true } = {}) {
  const existingDuration = savedItem ? item.meta?.duration : item.duration;
  if (!item?.url || existingDuration || item.isLive || item.isUpcoming) return;
  const startedAt = performance.now();
  void api.get(`/api/youtube/info?url=${encodeURIComponent(item.url)}`).then((info) => {
    if (savedItem) {
      item.meta = { ...(item.meta || {}), duration: info.duration, thumbnail: info.thumbnail || item.meta?.thumbnail };
    } else {
      item.duration = info.duration;
      item.isLive = info.isLive;
      if (!item.thumbnail && info.thumbnail) item.thumbnail = info.thumbnail;
      if (!item.channelTitle && info.uploader) item.channelTitle = info.uploader;
    }
    if (!item.title && info.title) item.title = info.title;
    reportPlaybackEvent("youtube_metadata_ready", {
      label: item.title || "YouTube",
      streamUrl: item.url,
      timing: {
        traceId: trace ? String(trace.id) : "",
        metadataRequestMs: performance.now() - startedAt,
        clickToMetadataMs: trace ? performance.now() - trace.clickAt : performance.now() - startedAt,
      },
    });
    if (active()) applyLateVodDuration(savedItem ? item.meta?.duration : item.duration);
  }).catch((e) => console.warn("youtube info background lookup failed:", e.message));
}

async function playItem(item) {
  const startupTrace = beginPlaybackStartupTrace(item.type === "youtube" ? "saved-youtube" : "saved-item", item);
  if (item.type === "youtube") {
    refreshYoutubeMetadataInBackground(item, startupTrace, {
      savedItem: true,
      active: () => state.playingItemId === item.id,
    });
  }
  state.playingItemId = item.id;
  state.youtubeSearchPlayingId = null;
  state.youtubeHistoryPlayingId = null;
  state.recommendedPlayingId = null;
  renderItems();
  renderYoutubeSearch();
  renderYoutubeHistory();
  renderRecommendations();
  if (isMobileMode()) setPlayerDropdownOpen(true);
  showAttemptedUrl(item.url);
  let initialStartupTrace = startupTrace;
  replayFn = (startAt = 0) => {
    const q = streamQuery(startAt);
    const trace = initialStartupTrace;
    initialStartupTrace = null;
    playStream({
      tsUrl: `/stream/ts/item/${item.id}?${q}`,
      mjpegUrl: `/stream/item/${item.id}?${q}`,
      audioUrl: `/stream/audio/item/${item.id}?${audioQuery(startAt)}`,
    }, item.title, {
      seekable: item.type === "youtube" || item.type === "file",
      isLive: item.type !== "youtube" && item.type !== "file",
      bufferedMjpeg: item.type === "youtube" || item.type === "file",
      duration: item.meta?.duration,
      startAt,
      startupTrace: trace,
    });
  };
  replayFn(0);
  if (item.type === "youtube") void recordWatchHistory(item, "saved");
}

function stopPlayback() {
  stopDesktopHlsSession();
  stopDesktopAudioHlsSession();
  clearBrowserAudioRetry();
  stopBrowserSession({ stopRealChromeOrphans: true }).catch((err) => {
    console.warn("Browser cleanup failed:", err.message);
  });
  cleanupMedia();
  stopStreamSeekTimer(true);
  resetPauseControl(true);
  replayFn = null;
  setAutoplayContext();
  setDesktopStreamActive(false);
  desktopInputActive = false;
  desktopInputPointerId = null;
  setBrowserStreamActive(false);
  browserInputActive = false;
  browserInputPointerId = null;
  resetDesktopZoom();
  resetBrowserZoom();
  renderDesktopInputUi();
  setBadge("hidden");
  $("#screen").classList.remove("playing", "loading", "video-mode", "mjpeg-mode", "mjpeg-buffered-mode", "embed-mode", "browser-mode", "startup-preview");
  $("#screen").style.height = "";
  $("#screen").style.aspectRatio = "";
  $("#nowPlaying").textContent = "Player";
  $("#stopBtn").disabled = true;
  $("#restreamBtn").disabled = true;
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = null;
  state.youtubeSearchPlayingId = null;
  activeEmbedCode = "";
  activeEmbedHeight = "";
  legacy.playing = null;
  legacy.resolution = null;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  renderYoutubeSearch();
}

function restreamPlayback() {
  if (!replayFn) return;
  const replay = replayFn;
  const resumeAt = streamSeek.seekable ? streamReplayTime() : undefined;
  stopDesktopAudioHlsSession();
  clearBrowserAudioRetry();
  cleanupMedia();
  $("#screen").classList.remove("playing", "loading", "video-mode", "mjpeg-mode", "mjpeg-buffered-mode", "embed-mode", "browser-mode");
  setBadge("reconnecting", "↻ Restreaming...");
  toast("Reloading stream");
  clearTimeout(restreamTimer);
  restreamTimer = setTimeout(() => {
    restreamTimer = null;
    if (replayFn === replay) {
      const result = replay(resumeAt);
      if (result?.catch) result.catch((e) => toast(e.message, true));
    }
  }, 150);
}

const RESTART_ACTIONS = {
  stream: {
    title: "Restart current stream?",
    confirmLabel: "Restart stream",
    description: "Video and audio will reconnect at the current position. The app itself will keep running.",
  },
  reload: {
    title: "Reload this screen?",
    confirmLabel: "Reload screen",
    description: "This browser page will refresh. Any video playing on this screen will stop and can be started again afterward.",
  },
  app: {
    title: "Restart YT Streamer app?",
    confirmLabel: "Restart app",
    description: "YT Streamer on the Mac will restart. Streams and browser sessions will disconnect briefly, then this screen will reconnect.",
  },
};

function openRestartChooser() {
  const streamDisabled = !replayFn;
  openModal(`
    <h3>Restart &amp; recovery</h3>
    <p class="restart-dialog-copy">Choose what you want to restart. You will confirm the action on the next screen.</p>
    <div class="restart-options" id="restartOptions">
      <button class="restart-option" type="button" data-restart-action="stream" ${streamDisabled ? "disabled" : ""}>
        <span class="restart-option-icon" aria-hidden="true">↻</span>
        <span><span class="restart-option-title">Restart current stream</span><span class="restart-option-copy">${streamDisabled ? "Start a video first to use this option." : "Reconnect video and audio without restarting the app."}</span></span>
      </button>
      <button class="restart-option" type="button" data-restart-action="reload">
        <span class="restart-option-icon" aria-hidden="true">⟳</span>
        <span><span class="restart-option-title">Reload this screen</span><span class="restart-option-copy">Refresh this browser page; the Mac app keeps running.</span></span>
      </button>
      <button class="restart-option danger" type="button" data-restart-action="app">
        <span class="restart-option-icon" aria-hidden="true">⏻</span>
        <span><span class="restart-option-title">Restart app</span><span class="restart-option-copy">Restart YT Streamer on the Mac and reconnect when it is ready.</span></span>
      </button>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="restartChooserCancel" type="button">Cancel</button></div>
  `);
  $("#restartMenuBtn").setAttribute("aria-expanded", "true");
  $("#restartOptions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-restart-action]");
    if (!button || button.disabled) return;
    openRestartConfirmation(button.dataset.restartAction);
  });
  $("#restartChooserCancel").onclick = closeModal;
}

function openRestartConfirmation(actionName) {
  const action = RESTART_ACTIONS[actionName];
  if (!action) return openRestartChooser();
  const ownerCode = actionName === "app" ? `
    <div class="restart-owner-code">
      <label for="restartOwnerCode">Owner access code</label>
      <input id="restartOwnerCode" form="restartConfirmForm" type="password" inputmode="text" autocomplete="current-password" autocapitalize="none" spellcheck="false" placeholder="Leave blank if this browser is trusted" />
      <div class="note">Use the same private code as the Money dashboard. It is required only once on each browser.</div>
    </div>
  ` : "";
  openModal(`
    <h3>${esc(action.title)}</h3>
    <p class="restart-dialog-copy">${esc(action.description)}</p>
    ${ownerCode}
    <p class="restart-error" id="restartActionError" role="alert" hidden></p>
    <form id="restartConfirmForm">
      <div class="modal-actions">
        <button class="btn ghost" id="restartConfirmBack" type="button">Back</button>
        <button class="btn ${actionName === "app" ? "danger" : "secondary"}" id="restartConfirmBtn" type="submit">${esc(action.confirmLabel)}</button>
      </div>
    </form>
  `);
  $("#restartConfirmBack").onclick = openRestartChooser;
  $("#restartConfirmForm").onsubmit = (event) => {
    event.preventDefault();
    void runRestartAction(actionName);
  };
}

function restartActionError(message) {
  const error = $("#restartActionError");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

async function requestAppRestart(ownerCode) {
  const headers = { "Content-Type": "application/json" };
  if (ownerCode) headers["X-YT-Streamer-Owner-Code"] = ownerCode;
  const response = await fetch("/api/app/restart", {
    method: "POST",
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ confirm: "restart-app" }),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data?.error || `Restart request failed (${response.status})`);
  if (response.status !== 202 || data?.restarting !== true || !String(data?.instanceId || "")) {
    throw new Error("The app did not return a valid restart response.");
  }
  return data;
}

function renderRestartWaiting() {
  openModal(`
    <div class="restart-waiting" role="status" aria-live="polite">
      <div class="restart-spinner" aria-hidden="true"></div>
      <h3>Restarting YT Streamer…</h3>
      <p class="restart-dialog-copy">Waiting for the Mac app to come back online. This screen will reload automatically.</p>
    </div>
  `, { locked: true });
}

async function waitForAppRestart(previousInstanceId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      const response = await fetch(`/api/health?_=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) continue;
      const health = await response.json();
      if (health.instanceId && health.instanceId !== previousInstanceId) return health;
    } catch {}
  }
  throw new Error("YT Streamer is taking longer than expected to restart.");
}

function showRestartTimeout(previousInstanceId, message) {
  openModal(`
    <h3>Still waiting for YT Streamer</h3>
    <p class="restart-dialog-copy">${esc(message)}</p>
    <div class="modal-actions">
      <button class="btn ghost" id="restartWaitClose" type="button">Close</button>
      <button class="btn secondary" id="restartWaitRetry" type="button">Check again</button>
    </div>
  `);
  $("#restartWaitClose").onclick = closeModal;
  $("#restartWaitRetry").onclick = async () => {
    renderRestartWaiting();
    try {
      await waitForAppRestart(previousInstanceId);
      window.location.reload();
    } catch (error) {
      showRestartTimeout(previousInstanceId, error.message);
    }
  };
}

async function runRestartAction(actionName) {
  const button = $("#restartConfirmBtn");
  if (!button || button.disabled) return;
  button.disabled = true;
  restartActionError("");
  if (actionName === "stream") {
    closeModal();
    if (replayFn) restreamPlayback();
    else toast("Start a stream first", true);
    return;
  }
  if (actionName === "reload") {
    button.textContent = "Reloading…";
    window.location.reload();
    return;
  }
  if (actionName !== "app") return;

  modalDismissLocked = true;
  const backButton = $("#restartConfirmBack");
  const codeInput = $("#restartOwnerCode");
  if (backButton) backButton.disabled = true;
  if (codeInput) codeInput.disabled = true;
  button.textContent = "Restarting…";
  const ownerCode = codeInput?.value.trim() || "";
  try {
    const result = await requestAppRestart(ownerCode);
    renderRestartWaiting();
    try {
      await waitForAppRestart(result.instanceId);
      window.location.reload();
    } catch (error) {
      showRestartTimeout(result.instanceId, error.message);
    }
  } catch (error) {
    modalDismissLocked = false;
    button.disabled = false;
    button.textContent = RESTART_ACTIONS.app.confirmLabel;
    if (backButton) backButton.disabled = false;
    if (codeInput) codeInput.disabled = false;
    restartActionError(error.message);
    if (codeInput && /code|required|unauthorized/i.test(error.message)) {
      codeInput.focus();
      codeInput.select();
    }
  }
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isScreenFullscreen() {
  return fullscreenElement() === $("#screen") || syntheticFullscreen;
}

function updateFullscreenButton() {
  const btn = $("#fullscreenBtn");
  const active = isScreenFullscreen();
  document.body.classList.toggle("screen-fullscreen", active);
  if (active) showFullscreenOverlays();
  else {
    clearFullscreenOverlayHide();
    updateStreamSeekUi();
  }
  if (!btn) return;
  btn.classList.toggle("is-exit", active);
  btn.title = active ? "Exit full screen" : "Full screen";
  btn.setAttribute("aria-label", btn.title);
}

function setSyntheticFullscreen(enabled) {
  syntheticFullscreen = enabled;
  $("#screen").classList.toggle("synthetic-fullscreen", enabled);
  updateFullscreenButton();
}

async function enterScreenFullscreen() {
  const screen = $("#screen");
  try {
    if (screen.requestFullscreen) await screen.requestFullscreen();
    else if (screen.webkitRequestFullscreen) screen.webkitRequestFullscreen();
    else setSyntheticFullscreen(true);
  } catch {
    setSyntheticFullscreen(true);
  } finally {
    updateFullscreenButton();
  }
}

async function exitScreenFullscreen() {
  if (syntheticFullscreen) {
    setSyntheticFullscreen(false);
    return;
  }
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch {} finally {
    updateFullscreenButton();
  }
}

function toggleScreenFullscreen() {
  if (isScreenFullscreen()) exitScreenFullscreen();
  else enterScreenFullscreen();
}

function legacyProfileHeightFallback(requestedHeight) {
  if (!legacy.playing) return { height: String(requestedHeight), fallback: false };
  const available = [...new Set((legacy.playing.resolutions || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
  const requested = Number(requestedHeight);
  if (!available.length || available.includes(requested)) {
    return { height: String(requestedHeight), fallback: false };
  }
  const atOrBelow = available.filter((value) => value <= requested);
  const chosen = atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : available[0];
  return {
    height: String(chosen),
    fallback: true,
    requested: String(requestedHeight),
    available,
  };
}

function applyQualityProfileSettings(profileId) {
  const profile = STREAM_QUALITY_PROFILES[profileId];
  if (!profile) return null;
  const heightResult = legacyProfileHeightFallback(profile.height);
  applyStreamSettings({ ...profile, height: heightResult.height });
  if (legacy.playing) legacy.resolution = Number(heightResult.height);
  renderFpsPresets();
  renderQuickQuality();
  renderSettingOptions();
  updateBwHint();
  localStorage.setItem(STREAM_QUALITY_PROFILE_KEY, profile.id);
  return { profile, ...heightResult };
}

function qualitySwitchResumeAt() {
  const pending = pendingQualityRestore;
  if (pending?.generation === qualitySwitchGeneration && Number.isFinite(pending.resumeAt)) return pending.resumeAt;
  if (!streamSeek.seekable) return undefined;
  return streamReplayTime(playbackPaused ? pausedResumeAt : getStreamCurrentTime());
}

function qualitySwitchPauseIntent() {
  return Boolean(playbackPaused || (pendingQualityRestore?.generation === qualitySwitchGeneration && pendingQualityRestore.pause));
}

function performQualityProfileSwitch(transition) {
  qualitySwitchTimer = null;
  if (transition.generation !== qualitySwitchGeneration || replayFn !== transition.replay) return;
  const beforeAttempt = streamAttempt;
  pendingQualityRestore = {
    generation: transition.generation,
    pause: transition.pause,
    resumeAt: transition.resumeAt,
    minAttempt: beforeAttempt + 1,
  };
  const fallback = transition.fallback
    ? " · " + transition.fallback.requested + "p unavailable, using " + transition.fallback.height + "p"
    : "";
  const status = transition.isLive
    ? "Changing quality to " + transition.profile.label + fallback + " · returning to live"
    : "Changing quality to " + transition.profile.label + fallback + "…";
  setBadge("reconnecting", transition.isLive ? "Changing quality… Returning to live" : "Changing quality…");
  toast(status);
  try {
    const result = transition.replay(transition.seekable ? transition.resumeAt : undefined);
    if (result?.catch) {
      result.catch((error) => {
        if (transition.generation === qualitySwitchGeneration) {
          pendingQualityRestore = null;
          toast(error.message, true);
        }
      });
    }
  } catch (error) {
    if (transition.generation === qualitySwitchGeneration) {
      pendingQualityRestore = null;
      toast(error.message, true);
    }
  }
}

function requestQualityProfile(profileId) {
  const profile = STREAM_QUALITY_PROFILES[profileId];
  if (!profile) return;
  const resumeAt = qualitySwitchResumeAt();
  const pause = qualitySwitchPauseIntent();
  const seekable = streamSeek.seekable;
  const isLive = Boolean(streamSeek.isLive && !seekable);
  const replay = replayFn;
  const previousProfile = streamQualityProfileForSettings();
  const generation = ++qualitySwitchGeneration;
  clearTimeout(qualitySwitchTimer);
  qualitySwitchTimer = null;
  pendingQualityRestore = null;

  const applied = applyQualityProfileSettings(profileId);
  if (!applied) return;
  const fallbackText = applied.fallback
    ? " · " + applied.requested + "p unavailable, using " + applied.height + "p"
    : "";

  const unchanged = previousProfile?.id === profile.id && !applied.fallback;
  if (unchanged) {
    toast(profile.label + " already selected · " + applied.height + "p · " + profile.fps + "fps");
    return;
  }

  if (!replay || !qualityProfilesAvailableForCurrentMode()) {
    toast(profile.label + " selected · " + applied.height + "p · " + profile.fps + "fps" + fallbackText);
    return;
  }

  const transition = {
    generation,
    replay,
    profile,
    seekable,
    resumeAt,
    pause,
    isLive,
    fallback: applied.fallback ? { requested: applied.requested, height: applied.height } : null,
  };
  qualitySwitchTimer = setTimeout(() => performQualityProfileSwitch(transition), STREAM_QUALITY_SWITCH_DELAY_MS);
}

// Re-apply controls live: restart whatever is currently playing with new params.
function reapplyControls() {
  renderFpsPresets();
  renderQuickQuality();
  renderSettingOptions();
  syncBrowserAudioControls();
  updateBwHint();
  if (legacy.playing) {
    const requested = parseInt($("#ctlHeight").value, 10);
    if (!legacy.playing.resolutions?.includes(requested)) {
      $("#ctlHeight").value = String(legacy.resolution);
      renderSettingOptions();
      toast("That resolution was not downloaded for this video", true);
      return;
    }
    legacy.resolution = requested;
  }
  if (!replayFn) return;
  toast("Restarting at " + currentSettingsLabel());
  replayFn(streamSeek.seekable ? streamReplayTime() : undefined);
}

function updateBwHint() {
  const h = parseInt($("#ctlHeight").value, 10) || 480;
  const fps = parseInt($("#ctlFps").value, 10);
  const q = parseInt($("#ctlQuality").value, 10);
  // very rough heuristic just to guide the user on 4G
  const est = Math.max(0.5, (h / 480) * (fps / 12) * (12 / q) * 4).toFixed(1);
  const risky = fps > 15;
  $("#ctlFps").classList.toggle("warn", risky);
  $("#bwHint").classList.toggle("warn", risky);
  $("#bwHint").textContent = risky ? `~${est} Mbps est. · risky` : `~${est} Mbps est.`;
}

function lowerPlaybackSettings() {
  const height = $("#ctlHeight");
  const fps = $("#ctlFps");
  const quality = $("#ctlQuality");
  if (parseInt(height.value, 10) > 360 || height.value === "0") height.value = "360";
  if (parseInt(fps.value, 10) > 12) fps.value = "12";
  if (parseInt(quality.value, 10) < 12) quality.value = "12";
  renderFpsPresets();
  renderQuickQuality();
  renderSettingOptions();
  updateBwHint();
}

// ---- Modals ----
function modalNewPlaylist() {
  openModal(`
    <h3>New playlist</h3>
    <label>Name</label>
    <input id="m_name" placeholder="e.g. Road Trip" autofocus />
    <div class="modal-actions">
      <button class="btn ghost" onclick="window.__closeModal()">Cancel</button>
      <button class="btn" id="m_save">Create</button>
    </div>`);
  $("#m_save").onclick = async () => {
    const name = $("#m_name").value.trim();
    if (!name) return toast("Enter a name", true);
    try { await api.post("/api/playlists", { name }); closeModal(); await loadPlaylists(); toast("Playlist created"); }
    catch (e) { toast(e.message, true); }
  };
}

function modalRename(p) {
  openModal(`
    <h3>Rename playlist</h3>
    <label>Name</label>
    <input id="m_name" value="${esc(p.name)}" />
    <div class="modal-actions">
      <button class="btn ghost" onclick="window.__closeModal()">Cancel</button>
      <button class="btn" id="m_save">Save</button>
    </div>`);
  $("#m_save").onclick = async () => {
    const name = $("#m_name").value.trim();
    if (!name) return;
    try { await api.patch(`/api/playlists/${p.id}`, { name }); closeModal(); await loadPlaylists(); }
    catch (e) { toast(e.message, true); }
  };
}

let addType = "m3u8";
function modalAddItem() {
  const p = currentPlaylist();
  if (!p) return;
  addType = "m3u8";
  openModal(`
    <h3>Add to “${esc(p.name)}”</h3>
    <div class="seg" id="m_seg">
      <button data-t="m3u8" class="on">M3U8 / Live</button>
      <button data-t="youtube">YouTube link</button>
      <button data-t="download">Download YT</button>
      <button data-t="ytplaylist">Import YT list</button>
    </div>

    <div id="m_body"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="window.__closeModal()">Cancel</button>
      <button class="btn" id="m_save">Add</button>
    </div>`);

  const seg = $("#m_seg");
  seg.querySelectorAll("button").forEach((b) => b.onclick = () => {
    seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); addType = b.dataset.t; renderAddBody();
  });
  renderAddBody();
  $("#m_save").onclick = saveAddItem;
}

function renderAddBody() {
  const body = $("#m_body");
  const save = $("#m_save");
  if (addType === "m3u8") {
    save.textContent = "Add stream";
    body.innerHTML = `
      <label>Title (optional)</label><input id="m_title" placeholder="My channel" />
      <label>M3U8 / stream URL</label><input id="m_url" inputmode="url" placeholder="https://…/index.m3u8" />
      <div class="note">Saved as a live stream. ffmpeg transcodes it to MJPEG on play.</div>`;
  } else if (addType === "youtube") {
    save.textContent = "Add link";
    body.innerHTML = `
      <label>Title (optional)</label><input id="m_title" placeholder="auto from YouTube" />
      <label>YouTube video URL</label><input id="m_url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" />
      <div class="note">Saved as a reference. On play the stream URL is resolved fresh (nothing stored on disk).</div>`;
  } else if (addType === "download") {
    save.textContent = "Download";
    body.innerHTML = `
      <label>YouTube video URL</label><input id="m_url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" />
      <div class="note">Downloads to your library on the Mac (up to 720p) and adds it to this playlist. Plays offline-fast afterward.</div>
      <div class="progress" id="m_prog" hidden><i></i></div>`;
  } else if (addType === "ytplaylist") {
    save.textContent = "Import all";
    body.innerHTML = `
      <label>YouTube playlist / channel URL</label><input id="m_url" inputmode="url" placeholder="https://www.youtube.com/playlist?list=…" />
      <div class="note">Adds every video as a YouTube reference (no download). Great for big lists.</div>`;
  }
}

async function saveAddItem() {
  const p = currentPlaylist();
  if (!p) return;
  const url = ($("#m_url")?.value || "").trim();
  const title = ($("#m_title")?.value || "").trim();
  const save = $("#m_save");
  if (!url) return toast("Enter a URL", true);

  try {
    save.disabled = true;
    if (addType === "m3u8") {
      await api.post(`/api/playlists/${p.id}/items`, { type: "m3u8", url, title: title || url });
    } else if (addType === "youtube") {
      let t = title;
      if (!t) { try { t = (await api.get(`/api/youtube/info?url=${encodeURIComponent(url)}`)).title; } catch {} }
      await api.post(`/api/playlists/${p.id}/items`, { type: "youtube", url, title: t || url });
    } else if (addType === "ytplaylist") {
      save.textContent = "Importing…";
      const r = await api.post(`/api/playlists/${p.id}/import-youtube`, { url });
      toast(`Imported ${r.added} videos`);
    } else if (addType === "download") {
      save.textContent = "Starting…";
      $("#m_prog").hidden = false;
      const { jobId } = await api.post("/api/download", { url, playlistId: p.id });
      await pollDownload(jobId);
    }
    closeModal();
    await loadPlaylists();
    if (addType !== "download") toast("Added");
  } catch (e) {
    toast(e.message, true);
    save.disabled = false;
    save.textContent = "Retry";
  }
}

function pollDownload(jobId) {
  return new Promise((resolve, reject) => {
    const bar = $("#m_prog")?.querySelector("i");
    const tick = async () => {
      try {
        const j = await api.get(`/api/download/${jobId}`);
        if (bar) bar.style.width = (j.pct || 0) + "%";
        $("#m_save").textContent = `Downloading ${Math.round(j.pct || 0)}%`;
        if (j.status === "done") { toast("Download complete"); return resolve(j); }
        if (j.status === "error") return reject(new Error(j.error || "download failed"));
        setTimeout(tick, 1000);
      } catch (e) { reject(e); }
    };
    tick();
  });
}


// ---- APNE Daily ----
function apneStatusClass(status) {
  return "is-" + String(status || "Checking").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderApneDaily() {
  const list = $("#apneDailyList");
  if (!list) return;
  const shows = state.apneDaily.shows || [];
  if (!shows.length) {
    list.innerHTML = '<article class="apne-show-card is-checking"><div class="apne-show-main"><h3>Anupamaa</h3><div class="apne-status"><span class="apne-status-dot"></span>Checking</div></div></article>';
    return;
  }
  list.innerHTML = shows.map((show) => {
    const status = show.status || "Checking";
    const busy = status === "Checking" || status === "Downloading";
    const saved = status === "Saved";
    const unavailable = status === "Not available yet";
    const episode = show.episode || {};
    const detail = show.detail || episode.dateLabel || "";
    const buttonText = saved ? "Play" : (status === "Failed" ? "Download Today" : "Download Today");
    const disabled = busy || unavailable;
    const action = saved ? "play" : "download";
    return '<article class="apne-show-card ' + apneStatusClass(status) + '" data-show-id="' + esc(show.id) + '">' +
      '<div class="apne-show-main">' +
        '<div class="apne-show-copy"><h3>' + esc(show.name) + '</h3>' +
          '<div class="apne-status"><span class="apne-status-dot"></span>' + esc(status) + '</div>' +
          (detail ? '<div class="apne-episode-detail">' + esc(detail) + '</div>' : '') +
        '</div>' +
        '<button class="btn apne-download-today ' + (saved ? 'secondary' : '') + '" data-act="' + action + '" type="button" ' + (disabled ? 'disabled' : '') + '>' + esc(buttonText) + '</button>' +
      '</div>' +
      (status === "Downloading" ? '<div class="apne-progress"><i></i></div>' : '') +
      ((show.recentEpisodes || []).length ?
        '<div class="apne-recent"><div class="apne-recent-title">Recent episodes</div>' +
          (show.recentEpisodes || []).map((recent) => {
            const recentStatus = recent.status || "Available";
            const recentSaved = recentStatus === "Saved" && recent.itemId;
            const recentBusy = recentStatus === "Checking" || recentStatus === "Downloading";
            const recentAction = recentSaved ? "play-episode" : "download-episode";
            const recentButton = recentSaved ? "Play" : (recentBusy ? "Downloading…" : (recentStatus === "Failed" ? "Retry" : "Download"));
            return '<div class="apne-recent-row" data-date-key="' + esc(recent.dateKey || "") + '">' +
              '<div class="apne-recent-copy"><strong>' + esc(recent.dateLabel || recent.dateKey || "Episode") + '</strong>' +
                (recentBusy ? '<small>' + esc(recent.detail || "Saving to Mac…") + '</small>' : '') +
                (recentStatus === "Failed" ? '<small class="apne-recent-error">' + esc(recent.detail || "Download failed") + '</small>' : '') +
              '</div>' +
              '<button class="btn small ' + (recentSaved ? 'secondary' : '') + ' apne-recent-action" type="button" data-act="' + recentAction + '" data-date-key="' + esc(recent.dateKey || "") + '" data-item-id="' + esc(recent.itemId || "") + '" ' + (recentBusy ? 'disabled' : '') + '>' + esc(recentButton) + '</button>' +
            '</div>';
          }).join("") +
        '</div>' : '') +
    '</article>';
  }).join("");
}

function scheduleApneDailyPoll() {
  if (state.apneDaily.pollTimer) clearTimeout(state.apneDaily.pollTimer);
  state.apneDaily.pollTimer = null;
  if (state.mode !== "apne") return;
  const hasBusyDownload = (state.apneDaily.shows || []).some((show) =>
    show.status === "Checking" || show.status === "Downloading" ||
    (show.recentEpisodes || []).some((episode) => episode.status === "Checking" || episode.status === "Downloading")
  );
  if (!hasBusyDownload) return;
  state.apneDaily.pollTimer = setTimeout(() => loadApneDaily({ quiet: true }), 1600);
}

async function loadApneDaily({ quiet = false } = {}) {
  if (state.apneDaily.loading) return;
  state.apneDaily.loading = true;
  if (!quiet && state.apneDaily.shows.length) {
    state.apneDaily.shows = state.apneDaily.shows.map((show) => (
      show.status === "Downloading" ? show : { ...show, status: "Checking", detail: "Checking APNE TV…" }
    ));
    renderApneDaily();
  }
  try {
    const data = await api.get("/api/apne-daily");
    state.apneDaily.today = data.today || "";
    state.apneDaily.shows = data.shows || [];
    renderApneDaily();
    scheduleApneDailyPoll();
  } catch (error) {
    if (!state.apneDaily.shows.length) {
      state.apneDaily.shows = [{ id: "anupamaa", name: "Anupamaa", status: "Failed", detail: error.message }];
    } else {
      state.apneDaily.shows = state.apneDaily.shows.map((show) => ({ ...show, status: "Failed", detail: error.message }));
    }
    renderApneDaily();
  } finally {
    state.apneDaily.loading = false;
  }
}

async function openApneDaily() {
  setMode("apne");
  if (!state.apneDaily.shows.length) {
    state.apneDaily.shows = [{ id: "anupamaa", name: "Anupamaa", status: "Checking", detail: "Checking APNE TV…" }];
    renderApneDaily();
  }
  await loadApneDaily();
}

async function startApneDailyDownload(showId) {
  const show = state.apneDaily.shows.find((item) => item.id === showId);
  if (!show) return;
  show.status = "Downloading";
  show.detail = "Preparing download on Mac…";
  renderApneDaily();
  try {
    const job = await api.post("/api/apne-daily/shows/" + encodeURIComponent(showId) + "/download", {});
    show.status = job.status || "Downloading";
    show.detail = job.detail || "Preparing download on Mac…";
    if (job.itemId) show.itemId = job.itemId;
    renderApneDaily();
    if (show.status === "Saved") {
      await loadPlaylists().catch(() => {});
      toast("Already saved in Downloaded Videos");
    } else {
      toast("Preparing download on Mac…");
    }
    scheduleApneDailyPoll();
  } catch (error) {
    show.status = "Failed";
    show.detail = error.message;
    renderApneDaily();
    toast(error.message, true);
  }
}

async function startApneEpisodeDownload(showId, dateKey) {
  const show = state.apneDaily.shows.find((item) => item.id === showId);
  const episode = show?.recentEpisodes?.find((item) => item.dateKey === dateKey);
  if (!show || !episode) return;
  episode.status = "Downloading";
  episode.detail = "Resolving APNE stream…";
  renderApneDaily();
  try {
    const job = await api.post(
      "/api/apne-daily/shows/" + encodeURIComponent(showId) + "/episodes/" + encodeURIComponent(dateKey) + "/download",
      {}
    );
    episode.status = job.status || "Downloading";
    episode.detail = job.detail || "Saving to Mac…";
    if (job.itemId) episode.itemId = job.itemId;
    renderApneDaily();
    if (episode.status === "Saved") {
      await loadPlaylists().catch(() => {});
      toast("Episode already saved on Mac");
      await loadApneDaily({ quiet: true });
    } else {
      toast("Downloading episode to Mac…");
      scheduleApneDailyPoll();
    }
  } catch (error) {
    episode.status = "Failed";
    episode.detail = error.message;
    renderApneDaily();
    toast(error.message, true);
  }
}

async function playApneDailyItem(itemId) {
  let item = downloadedLocalItems().find((entry) => entry.id === itemId);
  if (!item) {
    await loadPlaylists().catch(() => {});
    item = downloadedLocalItems().find((entry) => entry.id === itemId);
  }
  if (!item) return toast("Saved episode is not in Downloaded Videos yet", true);
  await playItem(item);
}

function renderApneManageRows() {
  const list = $("#apneManageList");
  if (!list) return;
  const shows = state.apneDaily.shows || [];
  list.innerHTML = shows.map((show) =>
    '<div class="apne-manage-row" data-show-id="' + esc(show.id) + '">' +
      '<div><strong>' + esc(show.name) + '</strong><small>' + esc(show.url || "") + '</small></div>' +
      (show.builtIn ? '<span class="apne-built-in">Built in</span>' : '<button class="btn small ghost" data-act="remove-apne-show" type="button">Remove</button>') +
    '</div>'
  ).join("");
}

function openApneManageShows() {
  openModal(
    '<h3>Manage APNE Daily Shows</h3>' +
    '<div class="apne-manage-list" id="apneManageList"></div>' +
    '<label for="apneShowUrl">APNE show URL</label>' +
    '<input id="apneShowUrl" inputmode="url" placeholder="https://apnetv.xyz/Hindi-Serial/Show-Name" />' +
    '<label for="apneShowName">Name <span class="muted">(optional)</span></label>' +
    '<input id="apneShowName" placeholder="Show name" />' +
    '<div class="modal-actions"><button class="btn ghost" id="apneManageClose" type="button">Close</button><button class="btn" id="apneAddShow" type="button">Add Show</button></div>'
  );
  renderApneManageRows();
  $("#apneManageClose").onclick = closeModal;
  $("#apneAddShow").onclick = async () => {
    const url = $("#apneShowUrl").value.trim();
    const name = $("#apneShowName").value.trim();
    if (!url) return toast("Paste an APNE show URL", true);
    const button = $("#apneAddShow");
    button.disabled = true;
    try {
      await api.post("/api/apne-daily/shows", { url, name });
      closeModal();
      await loadApneDaily();
      openApneManageShows();
      toast("Show added");
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  };
  bindTap($("#apneManageList"), async (event) => {
    const button = event.target.closest('[data-act="remove-apne-show"]');
    if (!button) return;
    const row = button.closest("[data-show-id]");
    if (!row) return;
    button.disabled = true;
    try {
      await api.del("/api/apne-daily/shows/" + encodeURIComponent(row.dataset.showId));
      await loadApneDaily();
      renderApneManageRows();
      toast("Show removed");
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  });
}

// ---- Processed YouTube library ----
const legacy = {
  playing: null,
  resolution: null,
  downloading: false,
};

function clock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(s).padStart(2, "0");
}

function legacyStatus(text, bad = false) {
  const el = $("#legacyStatus");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = bad ? "#ff8a8a" : "";
}

function setLegacyPlaylistSummary(text) {
  const el = $("#legacyPlaylistSummary");
  if (el) el.textContent = text;
}

function selectedLegacyResolutions() {
  return [...document.querySelectorAll("#legacyResolutions input:checked")].map((el) => parseInt(el.value, 10));
}

function setLegacyProgress(pct, hidden = false) {
  const bar = $("#legacyProgress");
  if (!bar) return;
  bar.hidden = hidden;
  bar.querySelector("i").style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
}

async function loadLegacyLibrary() {
  state.legacyItems = await api.get("/api/legacy-library");
  renderLegacyLibrary();
}

async function loadLegacyPlaylists() {
  state.legacyPlaylists = await api.get("/api/legacy-library/playlists");
  if (!state.selectedLegacyPlaylistId && state.legacyPlaylists.length) {
    state.selectedLegacyPlaylistId = state.legacyPlaylists[0].id;
  }
  if (!state.legacyPlaylists.some((playlist) => playlist.id === state.selectedLegacyPlaylistId)) {
    state.selectedLegacyPlaylistId = state.legacyPlaylists[0]?.id || null;
  }
  renderLegacyPlaylists();
  await loadSelectedLegacyPlaylistVideos();
}

function renderLegacyPlaylists() {
  const select = $("#legacyPlaylistSelect");
  if (!select) return;
  if (!state.legacyPlaylists.length) {
    select.innerHTML = `<option>No playlists</option>`;
    select.disabled = true;
    $("#legacyDeletePlaylistBtn").disabled = true;
    setLegacyPlaylistSummary("No playlists");
    return;
  }
  select.disabled = false;
  select.innerHTML = state.legacyPlaylists.map((playlist) => (
    `<option value="${esc(playlist.id)}" ${playlist.id === state.selectedLegacyPlaylistId ? "selected" : ""}>${esc(playlist.name || playlist.url)}</option>`
  )).join("");
  const active = selectedLegacyPlaylist();
  $("#legacyDeletePlaylistBtn").disabled = !active || active.builtin;
  setLegacyPlaylistSummary(active ? (active.name || active.url || "Selected playlist") : `${state.legacyPlaylists.length} playlist${state.legacyPlaylists.length === 1 ? "" : "s"}`);
}

function selectedLegacyPlaylist() {
  return state.legacyPlaylists.find((playlist) => playlist.id === state.selectedLegacyPlaylistId) || null;
}

async function loadSelectedLegacyPlaylistVideos() {
  const container = $("#legacyPlaylistVideos");
  const playlist = selectedLegacyPlaylist();
  if (!container) return;
  if (!playlist) {
    state.legacyPlaylistVideos = [];
    setLegacyPlaylistSummary("No playlist selected");
    container.innerHTML = `<div class="legacy-empty">No playlist selected.</div>`;
    return;
  }
  setLegacyPlaylistSummary("Loading playlist...");
  container.innerHTML = `<div class="legacy-empty">Loading playlist...</div>`;
  try {
    const data = await api.get(`/api/legacy-library/playlists/${encodeURIComponent(playlist.id)}/videos`);
    state.legacyPlaylistVideos = data.videos || [];
    renderLegacyPlaylistVideos();
  } catch (e) {
    state.legacyPlaylistVideos = [];
    setLegacyPlaylistSummary("Could not load playlist");
    container.innerHTML = `<div class="legacy-empty">Could not load playlist: ${esc(e.message)}</div>`;
  }
}

function legacyVideoProcessed(video) {
  const id = String(video.id || "");
  return state.legacyItems.some((item) => (
    item.originalYoutubeId === id ||
    String(item.originalUrl || "").includes(id)
  ));
}

function renderLegacyPlaylistVideos() {
  const container = $("#legacyPlaylistVideos");
  if (!container) return;
  const playlist = selectedLegacyPlaylist();
  const playlistName = playlist?.name || playlist?.url || "Playlist";
  setLegacyPlaylistSummary(`${playlistName} · ${state.legacyPlaylistVideos.length} video${state.legacyPlaylistVideos.length === 1 ? "" : "s"}`);
  if (!state.legacyPlaylistVideos.length) {
    container.innerHTML = `<div class="legacy-empty">Playlist is empty or could not be loaded.</div>`;
    return;
  }
  container.innerHTML = state.legacyPlaylistVideos.map((video) => {
    const processed = legacyVideoProcessed(video);
    return `<div class="legacy-playlist-row" data-video-id="${esc(video.id)}">
      <div class="meta">
        <div class="title">${esc(video.title)}</div>
        <div class="sub">${fmtDur(video.duration)}${video.duration ? " · " : ""}${esc(video.url)}</div>
      </div>
      <div class="actions">
        <button class="btn small ${processed ? "ghost" : "secondary"}" data-act="download-video" type="button" ${processed ? "disabled" : ""}>${processed ? "Processed" : "Download"}</button>
        <button class="btn small ghost" data-act="stream-video" type="button">Stream</button>
      </div>
    </div>`;
  }).join("");
}

function renderLegacyLibrary() {
  const list = $("#legacyList");
  if (!list) return;
  const localItems = downloadedLocalItems();
  if (!state.legacyItems.length && !localItems.length) {
    list.innerHTML = `<div class="legacy-empty">No downloaded videos yet.</div>`;
    return;
  }
  const localHtml = localItems.map((item) => `
    <div class="legacy-item ${item.id === state.playingItemId ? "active" : ""}" data-local-id="${esc(item.id)}">
      <div class="meta">
        <div class="title">${esc(item.title)}</div>
        <div class="sub">Local MP4 · synced video + audio</div>
      </div>
      <div class="actions">
        <button class="btn small secondary" data-act="play-local" type="button">Play</button>
      </div>
    </div>`).join("");
  const processedHtml = state.legacyItems.map((item) => `
    <div class="legacy-item ${item.id === state.legacyPlayingId ? "active" : ""}" data-id="${esc(item.id)}">
      <div class="meta">
        <div class="title">${esc(item.title)}</div>
        <div class="sub">${fmtDur(item.duration)}${item.duration ? " · " : ""}${esc((item.resolutions || []).join("p, "))}p</div>
      </div>
      <div class="actions">
        <button class="btn small secondary" data-act="play" type="button">Play</button>
        <button class="btn small ghost" data-act="delete" type="button">Delete</button>
      </div>
    </div>`).join("");
  list.innerHTML = localHtml + processedHtml;
}

async function probeLegacyFormats() {
  const url = $("#legacyUrl").value.trim();
  if (!url) return toast("Paste a YouTube URL first", true);
  const btn = $("#legacyProbeBtn");
  btn.disabled = true;
  btn.textContent = "Checking...";
  legacyStatus("Checking available qualities...");
  try {
    const info = await api.get(`/api/legacy-library/formats?url=${encodeURIComponent(url)}`);
    const available = info.availableResolutions || [];
    document.querySelectorAll("#legacyResolutions label").forEach((label) => {
      const input = label.querySelector("input");
      const value = parseInt(input.value, 10);
      const ok = available.some((height) => height <= value && height >= 240);
      input.disabled = !ok;
      if (!ok) input.checked = false;
      label.classList.toggle("disabled", !ok);
    });
    legacyStatus(`${info.title || "Video"} · available: ${available.join("p, ")}p`);
  } catch (e) {
    legacyStatus(e.message, true);
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Check";
  }
}

async function startLegacyDownload() {
  const url = $("#legacyUrl").value.trim();
  return startLegacyDownloadForUrl(url, { clearInput: true });
}

async function startLegacyDownloadForUrl(url, { clearInput = false } = {}) {
  if (!url) return toast("Paste a YouTube URL first", true);
  const resolutions = selectedLegacyResolutions();
  if (!resolutions.length) return toast("Select at least one quality", true);
  const btn = $("#legacyDownloadBtn");
  btn.disabled = true;
  legacy.downloading = true;
  setLegacyProgress(0, false);
  legacyStatus("Starting download...");
  try {
    const { jobId } = await api.post("/api/legacy-library/download", { url, resolutions });
    await pollLegacyDownload(jobId);
    if (clearInput) $("#legacyUrl").value = "";
    await loadLegacyLibrary();
    renderLegacyPlaylistVideos();
    toast("Processed video ready");
  } catch (e) {
    legacyStatus(e.message, true);
    toast(e.message, true);
  } finally {
    legacy.downloading = false;
    btn.disabled = false;
  }
}

function pollLegacyDownload(jobId) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const job = await api.get(`/api/legacy-library/jobs/${jobId}`);
        setLegacyProgress(job.pct || 0, false);
        legacyStatus(`${job.message || job.status || "Processing"} · ${Math.round(job.pct || 0)}%`);
        if (job.status === "done") return resolve(job);
        if (job.status === "error") return reject(new Error(job.error || "download failed"));
        setTimeout(tick, 1000);
      } catch (e) {
        reject(e);
      }
    };
    tick();
  });
}

async function streamLegacyPlaylistVideo(video, autoplayQueue = null) {
  const url = video.url;
  if (!video.duration) {
    try {
      const info = await api.get(`/api/youtube/info?url=${encodeURIComponent(url)}`);
      video.duration = info.duration;
      video.isLive = info.isLive;
      if (!video.title && info.title) video.title = info.title;
    } catch (e) {
      console.warn("youtube info failed for streamed playlist video:", e.message);
    }
  }
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = null;
  state.youtubeSearchPlayingId = null;
  state.youtubeHistoryPlayingId = null;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  renderYoutubeSearch();
  renderYoutubeHistory();
  if (isMobileMode()) setPlayerDropdownOpen(true);
  showAttemptedUrl(url);
  replayFn = (startAt = 0) => {
    const q = streamQuery(startAt);
    const u = encodeURIComponent(url);
    playStream({
      tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
      mjpegUrl: `/stream/youtube?url=${u}&${q}`,
      audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
    }, video.title || "YouTube", {
      seekable: !video.isLive,
      isLive: Boolean(video.isLive),
      bufferedMjpeg: !video.isLive,
      duration: video.duration,
      startAt,
      autoplayContext: !video.isLive ? {
        kind: "library-playlist",
        itemId: video.id,
        queue: autoplayQueue || state.legacyPlaylistVideos.filter((item) => !item.isLive),
      } : null,
    });
  };
  replayFn(0).catch((e) => toast(e.message, true));
  void recordWatchHistory(video, "library-playlist");
}

function legacyStreamUrl(startAt = 0) {
  const item = legacy.playing;
  const resolution = legacy.resolution || item?.resolutions?.[0];
  const params = new URLSearchParams({
    height: resolution,
    fps: $("#ctlFps").value,
    quality: $("#ctlQuality").value,
    timestamp: Math.max(0, Math.floor((startAt || 0) * 1000) / 1000),
    _: Date.now(),
  });
  return `/stream/legacy/${encodeURIComponent(item.id)}/${resolution}?${params}`;
}

function playLegacyItem(item, resolution = null, startAt = 0, autoplayQueue = null, options = {}) {
  cleanupMedia();
  stopStreamSeekTimer(true);
  state.playingItemId = null;
  state.legacyPlayingId = item.id;
  state.recommendedPlayingId = null;
  state.youtubeSearchPlayingId = null;
  state.youtubeHistoryPlayingId = null;
  legacy.playing = item;
  legacy.resolution = resolution || item.resolutions?.[0];
  $("#ctlHeight").value = String(legacy.resolution);
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  renderYoutubeSearch();
  renderYoutubeHistory();
  setDownloadsDrawerOpen(false);
  if (isMobileMode()) setPlayerDropdownOpen(true);

  replayFn = (resumeAt = getStreamCurrentTime() || startAt || 0) =>
    playLegacyItem(item, legacy.resolution, resumeAt, autoplayQueue, { skipHistory: true });

  playBufferedMjpegStream({
    mjpegUrl: legacyStreamUrl(startAt),
    audioUrl: `/stream/legacy-audio/${encodeURIComponent(item.id)}?_=${Date.now()}`,
  }, item.title || "Processed video", {
    seekable: true,
    bufferedMjpeg: true,
    duration: item.duration,
    startAt,
    keepLegacyState: true,
    audioElementStartAt: startAt,
    autoplayContext: {
      kind: "library",
      itemId: item.id,
      queue: autoplayQueue || state.legacyItems,
    },
  });

  if (!options.skipHistory && (item.originalUrl || item.originalYoutubeId)) {
    void recordWatchHistory(item, "library");
  }
}

window.__closeModal = closeModal;

// ---- Recommended YouTube tab (OAuth-backed, isolated from other modes) ----
function publishedLabel(value) {
  const ts = Date.parse(value || "");
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function youtubeSearchMeta(item) {
  const parts = [item.channelTitle];
  if (item.isLive) parts.push("Live");
  else if (item.isUpcoming) parts.push("Upcoming");
  else if (item.duration) parts.push(fmtDur(item.duration));
  const published = publishedLabel(item.publishedAt);
  if (published) parts.push(published);
  const views = compactNumber(item.viewCount);
  if (views) parts.push(`${views} views`);
  return parts.filter(Boolean).join(" · ");
}

function setYoutubeSearchStatus(text, bad = false) {
  const el = $("#ytSearchStatus");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", bad);
}

function setYoutubeHistoryStatus(text, bad = false) {
  const el = $("#ytHistoryStatus");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", bad);
}

function setBrowseYoutubePanel(panel) {
  state.browseYoutubePanel = panel === "history" ? "history" : "search";
  const showHistory = state.browseYoutubePanel === "history";
  $("#ytSearchPanel").hidden = showHistory;
  $("#ytHistoryPanel").hidden = !showHistory;
  $("#ytSearchTab").classList.toggle("active", !showHistory);
  $("#ytHistoryTab").classList.toggle("active", showHistory);
  $("#ytSearchTab").setAttribute("aria-selected", showHistory ? "false" : "true");
  $("#ytHistoryTab").setAttribute("aria-selected", showHistory ? "true" : "false");
  if (showHistory && !state.youtubeHistoryLoaded && !state.youtubeHistoryLoading) void loadYoutubeHistory();
}

function historyPlayedLabel(item) {
  const ts = Number(item.lastPlayedAt) || Date.parse(item.lastPlayedAt || "");
  let label = "";
  if (ts) {
    const diff = Math.max(0, Date.now() - ts);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < hour) label = `${Math.max(1, Math.round(diff / minute))}m ago`;
    else if (diff < day) label = `${Math.round(diff / hour)}h ago`;
    else if (diff < 30 * day) label = `${Math.round(diff / day)}d ago`;
    else label = new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const count = item.playCount > 1 ? `${item.playCount} plays` : "1 play";
  return [label ? `Played ${label}` : "Played", count].filter(Boolean).join(" · ");
}

function youtubeIdFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.hostname.includes("youtu.be")) return u.pathname.split("/").filter(Boolean)[0] || "";
    const fromQuery = u.searchParams.get("v");
    if (fromQuery) return fromQuery;
    const parts = u.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
    if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
  } catch {}
  return "";
}

function historyVideoPayload(item, source = "webapp") {
  const url = item.url || item.originalUrl || "";
  const youtubeId = item.youtubeId || item.originalYoutubeId || youtubeIdFromUrl(url) || (/^[A-Za-z0-9_-]{11}$/.test(String(item.id || "")) ? item.id : "");
  return {
    id: youtubeId,
    youtubeId,
    url: url || (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : ""),
    title: item.title,
    thumbnail: item.thumbnail || item.meta?.thumbnail,
    channelTitle: item.channelTitle || item.uploader,
    duration: item.duration || item.meta?.duration,
    isLive: Boolean(item.isLive || item.isUpcoming),
    source,
  };
}

async function recordWatchHistory(item, source = "webapp") {
  const payload = historyVideoPayload(item, source);
  if (!payload.url && !payload.youtubeId) return;
  try {
    const saved = await api.post("/api/watch-history", payload);
    if (state.youtubeHistoryLoaded) {
      state.youtubeHistory = [saved, ...state.youtubeHistory.filter((entry) => entry.id !== saved.id && entry.youtubeId !== saved.youtubeId)]
        .slice(0, WATCH_HISTORY_LIMIT);
      renderYoutubeHistory();
    }
  } catch (e) {
    console.warn("watch history record failed:", e.message);
  }
}

function renderYoutubeSearch() {
  const list = $("#ytSearchResults");
  if (!list) return;
  if (state.youtubeSearchLoading) {
    list.innerHTML = `<div class="yt-search-empty">Searching...</div>`;
    setYoutubeSearchStatus("Searching");
    return;
  }
  if (!state.youtubeSearchQuery) {
    list.innerHTML = `<div class="yt-search-empty">Enter a search term.</div>`;
    setYoutubeSearchStatus("");
    return;
  }
  if (state.youtubeSearchError) {
    list.innerHTML = `<div class="yt-search-empty">${esc(state.youtubeSearchError)}</div>`;
    setYoutubeSearchStatus(state.youtubeSearchError, true);
    return;
  }
  if (!state.youtubeSearchResults.length) {
    list.innerHTML = `<div class="yt-search-empty">No videos found.</div>`;
    setYoutubeSearchStatus("0 results");
    return;
  }
  setYoutubeSearchStatus(`${state.youtubeSearchResults.length} results`);
  list.innerHTML = state.youtubeSearchResults.map((item) => {
    const download = state.youtubeSearchDownloads[item.id] || null;
    const downloadLabel = download?.status === "done"
      ? "Downloaded"
      : download?.status === "error"
        ? "Retry"
        : download?.status === "running"
          ? `${Math.round(download.pct || 0)}%`
          : "Download";
    const thumb = item.thumbnail
      ? `<div class="yt-search-thumb"><img src="${esc(item.thumbnail)}" alt="" loading="lazy" /></div>`
      : `<div class="yt-search-thumb placeholder">▶</div>`;
    return `<div class="yt-search-row${item.id === state.youtubeSearchPlayingId ? " active" : ""}" data-video-id="${esc(item.id)}">
      ${thumb}
      <div class="yt-search-info">
        <div class="yt-search-title">${esc(item.title)}</div>
        <div class="yt-search-meta">${esc(youtubeSearchMeta(item))}</div>
      </div>
      <div class="yt-search-actions">
        <button class="btn small secondary" data-act="stream-search" type="button">Stream</button>
        <button class="btn small ghost" data-act="download-search" type="button" ${download?.status === "running" || download?.status === "done" ? "disabled" : ""}>${esc(downloadLabel)}</button>
      </div>
    </div>`;
  }).join("");
}

function renderYoutubeHistory() {
  const list = $("#ytHistoryResults");
  if (!list) return;
  if (state.youtubeHistoryLoading) {
    list.innerHTML = `<div class="yt-search-empty">Loading history...</div>`;
    setYoutubeHistoryStatus("Loading");
    return;
  }
  if (state.youtubeHistoryError) {
    list.innerHTML = `<div class="yt-search-empty">${esc(state.youtubeHistoryError)}</div>`;
    setYoutubeHistoryStatus(state.youtubeHistoryError, true);
    return;
  }
  if (!state.youtubeHistory.length) {
    list.innerHTML = `<div class="yt-search-empty">No app history yet.</div>`;
    setYoutubeHistoryStatus("0 videos");
    return;
  }
  setYoutubeHistoryStatus(`${state.youtubeHistory.length} video${state.youtubeHistory.length === 1 ? "" : "s"}`);
  list.innerHTML = state.youtubeHistory.map((item) => {
    const download = state.youtubeSearchDownloads[item.id] || null;
    const downloadLabel = download?.status === "done"
      ? "Downloaded"
      : download?.status === "error"
        ? "Retry"
        : download?.status === "running"
          ? `${Math.round(download.pct || 0)}%`
          : "Download";
    const thumb = item.thumbnail
      ? `<div class="yt-search-thumb"><img src="${esc(item.thumbnail)}" alt="" loading="lazy" /></div>`
      : `<div class="yt-search-thumb placeholder">▶</div>`;
    const meta = [item.channelTitle, item.duration ? fmtDur(item.duration) : "", historyPlayedLabel(item)].filter(Boolean).join(" · ");
    return `<div class="yt-search-row${item.id === state.youtubeHistoryPlayingId ? " active" : ""}" data-video-id="${esc(item.id)}">
      ${thumb}
      <div class="yt-search-info">
        <div class="yt-search-title">${esc(item.title)}</div>
        <div class="yt-search-meta">${esc(meta)}</div>
      </div>
      <div class="yt-search-actions">
        <button class="btn small secondary" data-act="stream-history" type="button">Stream</button>
        <button class="btn small ghost" data-act="download-history" type="button" ${download?.status === "running" || download?.status === "done" ? "disabled" : ""}>${esc(downloadLabel)}</button>
        <button class="btn small ghost" data-act="remove-history" type="button">Remove</button>
      </div>
    </div>`;
  }).join("");
}

async function loadYoutubeHistory() {
  state.youtubeHistoryLoading = true;
  state.youtubeHistoryError = "";
  renderYoutubeHistory();
  try {
    state.youtubeHistory = await api.get(`/api/watch-history?_=${Date.now()}`);
    state.youtubeHistoryLoaded = true;
  } catch (e) {
    state.youtubeHistory = [];
    state.youtubeHistoryError = e.message;
    toast(e.message, true);
  } finally {
    state.youtubeHistoryLoading = false;
    renderYoutubeHistory();
  }
}

async function performYoutubeSearch() {
  const input = $("#ytSearchInput");
  const query = input.value.trim();
  if (!query) {
    input.focus();
    return toast("Enter a YouTube search", true);
  }
  const btn = $("#ytSearchBtn");
  state.youtubeSearchQuery = query;
  state.youtubeSearchLoading = true;
  state.youtubeSearchPlayingId = null;
  state.youtubeSearchError = "";
  renderYoutubeSearch();
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const data = await api.get(`/api/youtube/search?q=${encodeURIComponent(query)}&limit=20`);
    if (state.youtubeSearchQuery !== query) return;
    state.youtubeSearchResults = data.items || [];
    renderYoutubeSearch();
  } catch (e) {
    state.youtubeSearchResults = [];
    state.youtubeSearchError = e.message;
    toast(e.message, true);
  } finally {
    if (state.youtubeSearchQuery === query) state.youtubeSearchLoading = false;
    btn.disabled = false;
    btn.textContent = "Search";
    renderYoutubeSearch();
  }
}

async function streamYoutubeSearchResult(item, autoplayQueue = null) {
  if (!item) return;
  const startupTrace = beginPlaybackStartupTrace("youtube-search", item);
  refreshYoutubeMetadataInBackground(item, startupTrace, {
    active: () => state.youtubeSearchPlayingId === item.id,
  });
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = null;
  state.youtubeSearchPlayingId = item.id;
  state.youtubeHistoryPlayingId = null;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  renderYoutubeSearch();
  renderYoutubeHistory();
  showAttemptedUrl(item.url);
  if (isMobileMode()) setPlayerDropdownOpen(true);
  let initialStartupTrace = startupTrace;
  replayFn = (startAt = 0) => {
    const q = streamQuery(startAt);
    const u = encodeURIComponent(item.url);
    const trace = initialStartupTrace;
    initialStartupTrace = null;
    playStream({
      tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
      mjpegUrl: `/stream/youtube?url=${u}&${q}`,
      audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
    }, item.title || "YouTube", {
      seekable: !item.isLive && !item.isUpcoming,
      isLive: Boolean(item.isLive || item.isUpcoming),
      bufferedMjpeg: !item.isLive && !item.isUpcoming,
      duration: item.duration,
      startAt,
      startupTrace: trace,
      autoplayContext: !item.isLive && !item.isUpcoming ? {
        kind: "youtube-search",
        itemId: item.id,
        queue: autoplayQueue || state.youtubeSearchResults.filter((entry) => !entry.isLive && !entry.isUpcoming),
      } : null,
    });
  };
  replayFn(0);
  void recordWatchHistory(item, "search");
}

async function streamYoutubeHistoryItem(item) {
  if (!item) return;
  const startupTrace = beginPlaybackStartupTrace("youtube-history", item);
  refreshYoutubeMetadataInBackground(item, startupTrace, {
    active: () => state.youtubeHistoryPlayingId === item.id,
  });
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = null;
  state.youtubeSearchPlayingId = null;
  state.youtubeHistoryPlayingId = item.id;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  renderYoutubeSearch();
  renderYoutubeHistory();
  showAttemptedUrl(item.url);
  if (isMobileMode()) setPlayerDropdownOpen(true);
  let initialStartupTrace = startupTrace;
  replayFn = (startAt = 0) => {
    const q = streamQuery(startAt);
    const u = encodeURIComponent(item.url);
    const trace = initialStartupTrace;
    initialStartupTrace = null;
    playStream({
      tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
      mjpegUrl: `/stream/youtube?url=${u}&${q}`,
      audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
    }, item.title || "YouTube", {
      seekable: !item.isLive,
      isLive: Boolean(item.isLive),
      bufferedMjpeg: !item.isLive,
      duration: item.duration,
      startAt,
      startupTrace: trace,
    });
  };
  replayFn(0);
  void recordWatchHistory(item, "history");
}

function recommendationMeta(item) {
  const parts = [item.channelTitle];
  if (item.categoryTitle) parts.push(item.categoryTitle);
  if (item.isLive) parts.push("Live");
  else if (item.isUpcoming) parts.push("Upcoming");
  else if (item.duration) parts.push(fmtDur(item.duration));
  const published = publishedLabel(item.publishedAt);
  if (published) parts.push(published);
  return parts.filter(Boolean).join(" · ");
}

function setRecommendationStatus(text, bad = false) {
  const el = $("#ytStatusLine");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", bad);
}

function recommendationMatchesFilter(item) {
  return state.recommendationCategory === "all" || item.categoryId === state.recommendationCategory;
}

function filteredRecommendations() {
  return state.recommendations.filter(recommendationMatchesFilter);
}

function renderRecommendationCategories() {
  const btn = $("#ytCategoryBtn");
  const panel = $("#ytCategoryPanel");
  if (!btn || !panel) return;
  const categories = new Map();
  state.recommendations.forEach((item) => {
    const id = String(item.categoryId || "other");
    const current = categories.get(id) || { title: item.categoryTitle || "Other", count: 0 };
    current.count += 1;
    categories.set(id, current);
  });
  const options = [...categories.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title));
  if (state.recommendationCategory !== "all" && !categories.has(state.recommendationCategory)) {
    state.recommendationCategory = "all";
  }
  const allSelected = state.recommendationCategory === "all";
  panel.innerHTML = `<button class="ch-menu-option ${allSelected ? "active" : ""}" type="button" role="option" data-value="all" aria-selected="${allSelected ? "true" : "false"}">All videos (${state.recommendations.length})</button>${options.map(([id, value]) => {
    const selected = id === state.recommendationCategory;
    return `<button class="ch-menu-option ${selected ? "active" : ""}" type="button" role="option" data-value="${esc(id)}" aria-selected="${selected ? "true" : "false"}">${esc(value.title)} (${value.count})</button>`;
  }).join("")}`;
  const selectedCategory = categories.get(state.recommendationCategory);
  btn.textContent = selectedCategory
    ? `${selectedCategory.title} (${selectedCategory.count})`
    : `All videos (${state.recommendations.length})`;
  btn.disabled = !state.recommendations.length;
  if (btn.disabled) closeRecommendationCategoryMenu();
}

function toggleRecommendationCategoryMenu() {
  const btn = $("#ytCategoryBtn");
  const panel = $("#ytCategoryPanel");
  if (!btn || !panel || btn.disabled) return;
  const nextOpen = panel.hidden;
  panel.hidden = !nextOpen;
  btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
}

function closeRecommendationCategoryMenu() {
  const btn = $("#ytCategoryBtn");
  const panel = $("#ytCategoryPanel");
  if (!btn || !panel) return;
  panel.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

function selectRecommendationCategory(category) {
  state.recommendationCategory = category || "all";
  state.recommendationVisibleCount = RECOMMENDATION_PAGE_SIZE;
  closeRecommendationCategoryMenu();
  renderRecommendations();
}

function renderYoutubeAuth() {
  const auth = state.youtubeAuth;
  const pairingOpen = youtubePairingIsVisible();
  if (!auth) {
    $("#ytConnectBtn").hidden = false;
    $("#ytConnectBtn").disabled = true;
    $("#ytDisconnectBtn").hidden = true;
    $("#ytRefreshBtn").disabled = true;
    setYoutubePairingVisible(false);
    setRecommendationStatus("Checking YouTube connection...");
    return;
  }
  const configured = Boolean(auth?.configured);
  const connected = Boolean(auth?.connected);
  const renewalRequired = Boolean(auth?.renewalRequired);
  if (!configured || connected) setYoutubePairingVisible(false);
  $("#ytConnectBtn").hidden = !configured;
  $("#ytConnectBtn").disabled = !configured;
  $("#ytConnectBtn").textContent = connected || renewalRequired ? "Renew" : "Connect";
  $("#ytDisconnectBtn").hidden = !auth?.hasCredentials;
  $("#ytRefreshBtn").disabled = !connected;

  if (!configured) {
    setRecommendationStatus(`Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET. Redirect: ${auth?.redirectUri || "/api/youtube-auth/callback"}`, true);
  } else if (pairingOpen && !connected) {
    setRecommendationStatus("Open the authorization link on your phone or Mac. Waiting for Google sign-in to finish...");
  } else if (renewalRequired) {
    setRecommendationStatus("YouTube authorization expired or was revoked. Tap Renew.", true);
  } else if (!connected) {
    setRecommendationStatus("YouTube not connected.");
  } else if (state.recommendationsLoadedAt) {
    setRecommendationStatus(`Updated ${new Date(state.recommendationsLoadedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  } else {
    setRecommendationStatus("Connected.");
  }
}

function renderRecommendations() {
  renderYoutubeAuth();
  renderRecommendationCategories();
  const list = $("#ytRecommendationList");
  const more = $("#ytMoreRecommendations");
  if (!list) return;
  if (more) more.hidden = true;
  if (!state.youtubeAuth) {
    list.innerHTML = `<div class="recommendation-empty">Loading...</div>`;
    return;
  }
  if (!state.youtubeAuth?.configured) {
    list.innerHTML = `<div class="recommendation-empty">OAuth credentials are missing on the Mac.</div>`;
    return;
  }
  if (!state.youtubeAuth?.connected) {
    const action = state.youtubeAuth?.renewalRequired ? "Renew YouTube authorization to refresh recommendations." : "Connect YouTube to load this tab.";
    list.innerHTML = `<div class="recommendation-empty">${esc(action)}</div>`;
    return;
  }
  if (!state.recommendations.length) {
    list.innerHTML = `<div class="recommendation-empty">No videos loaded. Tap Refresh.</div>`;
    return;
  }
  const filteredItems = filteredRecommendations();
  if (!filteredItems.length) {
    list.innerHTML = `<div class="recommendation-empty">No videos match these filters.</div>`;
    return;
  }
  const items = filteredItems.slice(0, state.recommendationVisibleCount);
  if (more && items.length < filteredItems.length) {
    const remaining = filteredItems.length - items.length;
    more.hidden = false;
    more.textContent = `Load more (${Math.min(RECOMMENDATION_PAGE_SIZE, remaining)} of ${remaining})`;
  }
  list.innerHTML = items.map((item) => {
    const download = state.recommendationDownloads[item.id] || null;
    const prepared = state.recommendationPrepared[item.id] || null;
    const preparedMark = prepared?.status === "ready"
      ? `<span class="prepared-check" title="Prepared for offline-fast playback" aria-label="Prepared">✓</span>`
      : "";
    const thumb = item.thumbnail
      ? `<div class="recommendation-thumb"><img src="${esc(item.thumbnail)}" alt="" loading="lazy" />${preparedMark}</div>`
      : `<div class="recommendation-thumb placeholder">▶${preparedMark}</div>`;
    const downloadLabel = download?.status === "done"
      ? "Downloaded"
      : download?.status === "error"
        ? "Retry"
        : download?.status === "running"
          ? `${Math.round(download.pct || 0)}%`
          : "Download";
    return `<div class="recommendation-row${item.id === state.recommendedPlayingId ? " active" : ""}" data-video-id="${esc(item.id)}">
      ${thumb}
      <div class="recommendation-info">
        <div class="recommendation-title">${esc(item.title)}</div>
        <div class="recommendation-meta">${esc(recommendationMeta(item))}</div>
        <div class="recommendation-actions">
          <button class="btn small secondary" data-act="stream-rec" type="button">Stream</button>
          <button class="btn small ghost" data-act="download-rec" type="button" ${download?.status === "running" || download?.status === "done" ? "disabled" : ""}>${esc(downloadLabel)}</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

async function loadYoutubeAuthStatus() {
  state.youtubeAuth = await api.get("/api/youtube-auth/status");
  renderRecommendations();
  return state.youtubeAuth;
}

async function loadRecommendations() {
  const btn = $("#ytRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";
  setRecommendationStatus("Refreshing...");
  try {
    const data = await api.get(`/api/youtube/recommendations?_=${Date.now()}`);
    state.recommendations = data.items || [];
    state.recommendationsLoadedAt = data.generatedAt || Date.now();
    state.recommendationVisibleCount = RECOMMENDATION_PAGE_SIZE;
    if (state.recommendations.length && !state.recommendations.some(recommendationMatchesFilter)) {
      state.recommendationCategory = "all";
    }
    renderRecommendations();
    void refreshPreparedRecommendationStatuses();
  } catch (e) {
    setRecommendationStatus(e.message, true);
    if (/not connected|authorization|expired|revoked|token/i.test(e.message)) await loadYoutubeAuthStatus().catch(() => {});
    toast(e.message, true);
  } finally {
    btn.disabled = !state.youtubeAuth?.connected;
    btn.textContent = "Refresh";
  }
}

async function openRecommendations() {
  setMode("recommended");
  renderRecommendations();
  try {
    const auth = await loadYoutubeAuthStatus();
    if (auth.connected && !state.recommendations.length) await loadRecommendations();
  } catch (e) {
    setRecommendationStatus(e.message, true);
  }
}

function youtubeAuthStartUrl() {
  return new URL("/api/youtube-auth/start", location.href).href;
}

function youtubePairingElements() {
  return [
    { panel: $("#ytPairingPanel"), input: $("#ytPairingUrl") },
  ].filter((item) => item.panel && item.input);
}

function youtubePairingIsVisible() {
  return youtubePairingElements().some((item) => !item.panel.hidden);
}

function stopYoutubePairingPoll() {
  clearInterval(youtubeAuthPairingTimer);
  youtubeAuthPairingTimer = null;
}

function setYoutubePairingVisible(visible) {
  const url = youtubeAuthStartUrl();
  for (const { panel, input } of youtubePairingElements()) {
    panel.hidden = !visible;
    if (visible) input.value = url;
  }
  if (visible) {
    requestAnimationFrame(() => {
      const visibleInput = youtubePairingElements().find((item) => !item.panel.hidden)?.input;
      try { visibleInput?.select(); } catch {}
    });
  }
}

function startYoutubePairingPoll() {
  stopYoutubePairingPoll();
  let tries = 0;
  youtubeAuthPairingTimer = setInterval(async () => {
    tries += 1;
    try {
      const auth = await loadYoutubeAuthStatus();
      if (auth.connected) {
        stopYoutubePairingPoll();
        setYoutubePairingVisible(false);
        toast("YouTube connected");
        await loadRecommendations();
      }
    } catch {}
    if (tries > 150) {
      stopYoutubePairingPoll();
      renderYoutubeAuth();
    }
  }, 2000);
}

function connectYoutube() {
  if (!state.youtubeAuth?.configured) {
    renderYoutubeAuth();
    return;
  }
  $("#ytConnectBtn").disabled = false;
  setYoutubePairingVisible(true);
  setRecommendationStatus("Open the authorization link on your phone or Mac. Waiting for Google sign-in to finish...");
  startYoutubePairingPoll();
}

async function disconnectYoutube() {
  if (!confirm("Disconnect YouTube from this Mac?")) return;
  try {
    stopYoutubePairingPoll();
    setYoutubePairingVisible(false);
    await api.post("/api/youtube-auth/logout");
    state.youtubeAuth = null;
    state.recommendations = [];
    state.recommendationsLoadedAt = null;
    await loadYoutubeAuthStatus();
    toast("YouTube disconnected");
  } catch (e) {
    toast(e.message, true);
  }
}

async function streamRecommendation(item, autoplayQueue = null) {
  if (!item) return;
  const startupTrace = beginPlaybackStartupTrace("recommendation", item);
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = item.id;
  state.youtubeSearchPlayingId = null;
  state.youtubeHistoryPlayingId = null;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  renderYoutubeSearch();
  renderYoutubeHistory();
  showAttemptedUrl(item.url);
  if (isMobileMode()) setPlayerDropdownOpen(true);

  // Lock this viewing session to the source that was available when playback began.
  // Background preparation may finish later, but seek/restream/quality changes must not
  // silently switch an active YouTube session over to the prepared local file.
  const preparedForSession = state.recommendationPrepared[item.id]?.status === "ready";
  const sessionSource = preparedForSession ? "prepared" : "youtube";
  reportPlaybackEvent("recommendation_source_locked", {
    label: item.title || "YouTube",
    youtubeId: item.id || null,
    reason: sessionSource,
  });

  let initialStartupTrace = startupTrace;
  replayFn = (startAt = 0) => {
    const q = streamQuery(startAt);
    const prepared = preparedForSession;
    const trace = initialStartupTrace;
    initialStartupTrace = null;
    const u = encodeURIComponent(item.url);
    playStream({
      tsUrl: prepared ? `/stream/ts/prepared/${encodeURIComponent(item.id)}?${q}` : `/stream/ts/youtube?url=${u}&${q}`,
      mjpegUrl: prepared ? `/stream/prepared/${encodeURIComponent(item.id)}?${q}` : `/stream/youtube?url=${u}&${q}`,
      audioUrl: prepared ? `/stream/audio/prepared/${encodeURIComponent(item.id)}?${audioQuery(startAt)}` : `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
    }, item.title || "YouTube", {
      seekable: !item.isLive && !item.isUpcoming,
      isLive: Boolean(item.isLive || item.isUpcoming),
      bufferedMjpeg: !item.isLive && !item.isUpcoming,
      duration: item.duration,
      startAt,
      startupTrace: trace,
      autoplayContext: !item.isLive && !item.isUpcoming ? {
        kind: "recommendations",
        itemId: item.id,
        queue: autoplayQueue || filteredRecommendations()
          .slice(0, state.recommendationVisibleCount)
          .filter((entry) => !entry.isLive && !entry.isUpcoming),
      } : null,
    });
  };
  replayFn(0);
  void recordWatchHistory(item, "recommended");
  if (!item.isLive && !item.isUpcoming) void prepareRecommendationInBackground(item);
}

async function refreshPreparedRecommendationStatuses() {
  const ids = state.recommendations
    .filter((item) => !item.isLive && !item.isUpcoming)
    .map((item) => item.id)
    .filter(Boolean);
  if (!ids.length) return;
  try {
    const data = await api.post("/api/prepared/status", { ids });
    state.recommendationPrepared = data.items || {};
    renderRecommendations();
  } catch (e) {
    console.warn("prepared status failed:", e.message);
  }
}

async function pollPreparedRecommendation(id) {
  try {
    const data = await api.post("/api/prepared/status", { ids: [id] });
    const status = data.items?.[id] || null;
    if (status) state.recommendationPrepared[id] = status;
    else delete state.recommendationPrepared[id];
    renderRecommendations();
    if (status?.status === "preparing") setTimeout(() => pollPreparedRecommendation(id), 3000);
  } catch (e) {
    console.warn("prepared polling failed:", e.message);
  }
}

async function prepareRecommendationInBackground(item) {
  const current = state.recommendationPrepared[item.id];
  if (!item?.id || !item.url || current?.status === "ready" || current?.status === "preparing") return;
  state.recommendationPrepared[item.id] = { status: "preparing", pct: 0 };
  renderRecommendations();
  try {
    const status = await api.post("/api/prepared", {
      id: item.id,
      url: item.url,
      title: item.title,
      duration: item.duration,
      thumbnail: item.thumbnail,
    });
    state.recommendationPrepared[item.id] = status;
    renderRecommendations();
    if (status.status === "preparing") setTimeout(() => pollPreparedRecommendation(item.id), 3000);
  } catch (e) {
    state.recommendationPrepared[item.id] = { status: "error" };
    renderRecommendations();
    console.warn("background preparation failed:", e.message);
  }
}

async function getOrCreateRecommendedDownloadsPlaylist() {
  await loadPlaylists().catch(() => {});
  let playlist = state.playlists.find((p) => p.meta?.kind === "youtube-recommended-downloads");
  if (!playlist) playlist = state.playlists.find((p) => p.name.toLowerCase() === "recommended downloads");
  if (playlist && playlist.meta?.kind !== "youtube-recommended-downloads") {
    playlist = await api.patch(`/api/playlists/${playlist.id}`, { meta: { kind: "youtube-recommended-downloads" } });
  }
  if (!playlist) {
    playlist = await api.post("/api/playlists", {
      name: "Recommended Downloads",
      meta: { kind: "youtube-recommended-downloads" },
    });
  }
  return playlist;
}

async function getOrCreateYoutubeSearchDownloadsPlaylist() {
  await loadPlaylists().catch(() => {});
  let playlist = state.playlists.find((p) => p.meta?.kind === "youtube-search-downloads");
  if (!playlist) playlist = state.playlists.find((p) => p.name.toLowerCase() === "youtube search downloads");
  if (playlist && playlist.meta?.kind !== "youtube-search-downloads") {
    playlist = await api.patch(`/api/playlists/${playlist.id}`, { meta: { kind: "youtube-search-downloads" } });
  }
  if (!playlist) {
    playlist = await api.post("/api/playlists", {
      name: "YouTube Search Downloads",
      meta: { kind: "youtube-search-downloads" },
    });
  }
  return playlist;
}

async function downloadRecommendation(item) {
  if (!item || state.recommendationDownloads[item.id]?.status === "running") return;
  state.recommendationDownloads[item.id] = { status: "running", pct: 0 };
  renderRecommendations();
  try {
    const playlist = await getOrCreateRecommendedDownloadsPlaylist();
    const { jobId } = await api.post("/api/download", { url: item.url, playlistId: playlist.id });
    await new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const job = await api.get(`/api/download/${jobId}`);
          state.recommendationDownloads[item.id] = { status: job.status, pct: job.pct || 0 };
          renderRecommendations();
          if (job.status === "done") return resolve(job);
          if (job.status === "error") return reject(new Error(job.error || "download failed"));
          setTimeout(tick, 1000);
        } catch (e) {
          reject(e);
        }
      };
      tick();
    });
    state.recommendationDownloads[item.id] = { status: "done", pct: 100 };
    await loadPlaylists().catch(() => {});
    renderRecommendations();
    toast("Download complete");
  } catch (e) {
    state.recommendationDownloads[item.id] = { status: "error", pct: 0 };
    renderRecommendations();
    toast(e.message, true);
  }
}

async function downloadYoutubeSearchResult(item) {
  if (!item || state.youtubeSearchDownloads[item.id]?.status === "running") return;
  state.youtubeSearchDownloads[item.id] = { status: "running", pct: 0 };
  renderYoutubeSearch();
  renderYoutubeHistory();
  try {
    const playlist = await getOrCreateYoutubeSearchDownloadsPlaylist();
    const { jobId } = await api.post("/api/download", { url: item.url, playlistId: playlist.id });
    await new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const job = await api.get(`/api/download/${jobId}`);
          state.youtubeSearchDownloads[item.id] = { status: job.status, pct: job.pct || 0 };
          renderYoutubeSearch();
          renderYoutubeHistory();
          if (job.status === "done") return resolve(job);
          if (job.status === "error") return reject(new Error(job.error || "download failed"));
          setTimeout(tick, 1000);
        } catch (e) {
          reject(e);
        }
      };
      tick();
    });
    state.youtubeSearchDownloads[item.id] = { status: "done", pct: 100 };
    await loadPlaylists().catch(() => {});
    renderYoutubeSearch();
    renderYoutubeHistory();
    toast("Download complete");
  } catch (e) {
    state.youtubeSearchDownloads[item.id] = { status: "error", pct: 0 };
    renderYoutubeSearch();
    renderYoutubeHistory();
    toast(e.message, true);
  }
}

async function removeYoutubeHistoryItem(item) {
  if (!item) return;
  try {
    await api.del(`/api/watch-history/${encodeURIComponent(item.id)}`);
    state.youtubeHistory = state.youtubeHistory.filter((entry) => entry.id !== item.id);
    if (state.youtubeHistoryPlayingId === item.id) state.youtubeHistoryPlayingId = null;
    renderYoutubeHistory();
    toast("Removed from history");
  } catch (e) {
    toast(e.message, true);
  }
}

async function clearYoutubeHistory() {
  if (!state.youtubeHistory.length) return;
  if (!confirm("Clear app playback history?")) return;
  try {
    await api.del("/api/watch-history");
    state.youtubeHistory = [];
    state.youtubeHistoryPlayingId = null;
    renderYoutubeHistory();
    toast("History cleared");
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Channels browser (built-in IPTV catalog) ----
const CHANNEL_SOURCE_KEY = "ytStreamerChannelSource";

function initialChannelSource() {
  const saved = localStorage.getItem(CHANNEL_SOURCE_KEY);
  if (/^[a-z]{2}$/i.test(saved || "")) return `country:${saved.toLowerCase()}`;
  if (saved && saved !== "all") return saved;
  return "country:us";
}

const ch = {
  sourcesLoaded: false,
  sources: [],
  groups: [],
  src: initialChannelSource(),
  q: "",
  group: "",
  offset: 0,
  limit: 200,
  total: 0,
  loading: false,
  pendingReset: false,
};

function revealChannels() {
  const view = $("#channelsView");
  setMode("browse");
  setBrowseYoutubePanel(state.browseYoutubePanel);
  view.scrollTop = 0;
}
function openChannels() { revealChannels(); if (!ch.sourcesLoaded) loadChannelSources(true); else loadChannels(true); }
function closeChannels() { closeChannelMenus(); if (state.mode === "browse") setMode("watch"); }

async function openLegacyLibrary() {
  setMode("library");
  try {
    await loadPlaylists();
    await loadLegacyLibrary();
    await loadLegacyPlaylists();
  }
  catch (e) { toast(e.message, true); }
}

async function openDesktop() {
  if (!DESKTOP_FEATURE_VISIBLE) {
    setMode("watch");
    toast("Desktop is hidden");
    return;
  }
  setMode("desktop");
  await loadDesktopSources().catch((e) => renderDesktopStatus({ error: e.message }));
  await loadDesktopInputStatus().catch((e) => {
    desktopInputStatus = {
      enabled: true,
      supported: false,
      available: false,
      trusted: false,
      error: e.message || "Desktop input status failed.",
    };
    renderDesktopInputUi();
  });
}

async function loadDesktopSources() {
  renderDesktopStatus({ loading: true });
  const sources = await api.get("/api/desktop/sources");
  state.desktopSources = sources;
  renderDesktopStatus(sources);
  renderDesktopAudioOptions(sources);
  renderBrowserAudioOptions(sources);
}

async function loadBrowserAudioSources() {
  const sources = await api.get("/api/browser/audio-sources");
  state.desktopSources = sources;
  renderBrowserAudioOptions(sources);
  return sources;
}

async function ensureBrowserAudioSourcesReady() {
  if (state.desktopSources?.audio?.length) {
    renderBrowserAudioOptions(state.desktopSources);
    return state.desktopSources;
  }
  try {
    return await loadBrowserAudioSources();
  } catch (e) {
    renderBrowserAudioOptions({ audio: [] });
    console.warn("browser audio probe failed:", e.message);
    return null;
  }
}

async function stopDesktopHlsSession() {
  const id = desktopHlsSessionId;
  desktopHlsSessionId = null;
  if (!id) return;
  await api.post(`/api/desktop/hls/${encodeURIComponent(id)}/stop`).catch(() => {});
}

async function stopDesktopAudioHlsSession() {
  const id = desktopAudioHlsSessionId;
  const stopBase = desktopAudioHlsStopBase;
  desktopAudioHlsSessionId = null;
  desktopAudioHlsStopBase = "/api/desktop/audio-hls";
  if (!id) return;
  await api.post(`${stopBase}/${encodeURIComponent(id)}/stop`).catch(() => {});
}

function stopDesktopAudioHlsSessionOnUnload() {
  const id = desktopAudioHlsSessionId;
  const stopBase = desktopAudioHlsStopBase;
  desktopAudioHlsSessionId = null;
  desktopAudioHlsStopBase = "/api/desktop/audio-hls";
  if (!id) return;
  const url = `${stopBase}/${encodeURIComponent(id)}/stop`;
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([], { type: "text/plain" }));
      return;
    }
  } catch {}
  fetch(url, { method: "POST", keepalive: true }).catch(() => {});
}

function stopDesktopHlsSessionOnUnload() {
  const id = desktopHlsSessionId;
  desktopHlsSessionId = null;
  if (!id) return;
  const url = `/api/desktop/hls/${encodeURIComponent(id)}/stop`;
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([], { type: "text/plain" }));
      return;
    }
  } catch {}
  fetch(url, { method: "POST", keepalive: true }).catch(() => {});
}

function supportsNativeAudioHls() {
  const audio = $("#audio");
  if (!audio?.canPlayType) return false;
  return Boolean(
    audio.canPlayType("application/vnd.apple.mpegurl") ||
    audio.canPlayType("application/x-mpegURL") ||
    audio.canPlayType("audio/mpegurl")
  );
}

function canTryAudioHlsJs() {
  return Boolean(window.MediaSource || window.ManagedMediaSource || window.Hls);
}

function isHlsUrl(url) {
  return /\.m3u8(?:[?#]|$)/i.test(String(url || ""));
}

function validBrowserAudioCapture(value) {
  const raw = String(value || "");
  return BROWSER_AUDIO_CAPTURE_MODES.includes(raw) ? raw : DEFAULT_BROWSER_AUDIO_CAPTURE;
}

function browserAudioCaptureValue() {
  const saved = localStorage.getItem(BROWSER_AUDIO_CAPTURE_KEY);
  const selected = $("#browserAudioCapture")?.value || $("#browserPlayerAudioCapture")?.value;
  return validBrowserAudioCapture(saved || selected);
}

function setBrowserAudioCapture(value, { persist = true } = {}) {
  const mode = validBrowserAudioCapture(value);
  const main = $("#browserAudioCapture");
  const player = $("#browserPlayerAudioCapture");
  const mainAudio = $("#browserAudio");
  const playerAudio = $("#browserPlayerAudio");
  if (main) main.value = mode;
  if (player) player.value = mode;
  const manual = mode === "manual";
  if (mainAudio) {
    mainAudio.disabled = !manual;
    mainAudio.title = manual ? "Choose the AVFoundation capture device" : "The selected capture backend chooses its own source";
  }
  if (playerAudio) {
    playerAudio.disabled = !manual;
    playerAudio.title = manual ? "Choose the AVFoundation capture device" : "The selected capture backend chooses its own source";
  }
  if (persist) localStorage.setItem(BROWSER_AUDIO_CAPTURE_KEY, mode);
  return mode;
}

function validBrowserAudioFormat(value) {
  return BROWSER_AUDIO_FORMATS.includes(String(value)) ? String(value) : DEFAULT_BROWSER_AUDIO_FORMAT;
}

function validBrowserAudioBitrate(value) {
  return BROWSER_AUDIO_BITRATES.includes(String(value)) ? String(value) : "128";
}

function storedBrowserAudioFormat() {
  const storedFormat = localStorage.getItem(BROWSER_AUDIO_FORMAT_KEY);
  const migrated = localStorage.getItem(BROWSER_AUDIO_DEFAULT_KEY) === "1";
  if (!migrated && (!storedFormat || storedFormat === "auto")) {
    localStorage.setItem(BROWSER_AUDIO_FORMAT_KEY, DEFAULT_BROWSER_AUDIO_FORMAT);
    localStorage.setItem(BROWSER_AUDIO_DEFAULT_KEY, "1");
    return DEFAULT_BROWSER_AUDIO_FORMAT;
  }
  return storedFormat;
}

function browserAudioFormatValue() {
  const active = $("#browserAudioFormat [data-browser-audio-format].active")
    || $("#browserPlayerAudioFormat [data-browser-audio-format].active");
  return validBrowserAudioFormat(storedBrowserAudioFormat() || active?.dataset.browserAudioFormat);
}

function browserAudioBitrateValue() {
  const active = $("#browserAudioQuality [data-browser-audio-bitrate].active")
    || $("#browserPlayerAudioQuality [data-browser-audio-bitrate].active");
  return validBrowserAudioBitrate(active?.dataset.browserAudioBitrate || localStorage.getItem(BROWSER_AUDIO_BITRATE_KEY));
}

function setBrowserAudioFormat(format, { persist = true } = {}) {
  const value = validBrowserAudioFormat(format);
  document.querySelectorAll("[data-browser-audio-format]").forEach((btn) => {
    const active = btn.dataset.browserAudioFormat === value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (persist) localStorage.setItem(BROWSER_AUDIO_FORMAT_KEY, value);
  return value;
}

function setBrowserAudioBitrate(bitrate, { persist = true } = {}) {
  const value = validBrowserAudioBitrate(bitrate);
  document.querySelectorAll("[data-browser-audio-bitrate]").forEach((btn) => {
    const active = btn.dataset.browserAudioBitrate === value;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (persist) localStorage.setItem(BROWSER_AUDIO_BITRATE_KEY, value);
  return value;
}

function syncBrowserAudioControls() {
  setBrowserAudioCapture(browserAudioCaptureValue());
  setBrowserAudioFormat(storedBrowserAudioFormat() || browserAudioFormatValue());
  setBrowserAudioBitrate(localStorage.getItem(BROWSER_AUDIO_BITRATE_KEY) || browserAudioBitrateValue());
}

async function canUseAudioHls() {
  if (supportsNativeAudioHls()) return true;
  if (!canTryAudioHlsJs()) return false;
  try {
    await ensureHls();
    return Boolean(window.Hls?.isSupported?.());
  } catch {
    return false;
  }
}

async function setCompatAudioSource(audio, audioUrl, { holdPcmOutput = false } = {}) {
  destroyAudioHlsPlayer();
  destroyBrowserPcmAudio();
  if (isBrowserPcmUrl(audioUrl)) {
    await startBrowserPcmAudio(audioUrl, true, { holdOutput: holdPcmOutput });
    return;
  }
  if (isHlsUrl(audioUrl) && !supportsNativeAudioHls()) {
    await ensureHls();
    if (!window.Hls?.isSupported?.()) throw new Error("HLS audio is not supported in this browser");
    hlsAudioPlayer = new window.Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      maxBufferLength: 12,
      backBufferLength: 0,
    });
    hlsAudioPlayer.loadSource(audioUrl);
    hlsAudioPlayer.attachMedia(audio);
    return;
  }
  audio.src = audioUrl;
  try { audio.load(); } catch {}
}

async function desktopAudioUrl(audio) {
  await stopDesktopAudioHlsSession();
  if (!audio) return "";
  return `/stream/desktop-audio?audio=${encodeURIComponent(audio)}&_=${Date.now()}`;
}

async function browserAudioUrl(audio) {
  await stopDesktopAudioHlsSession();
  const backend = browserAudioCaptureValue();
  if (!audio && backend === "manual") return "";
  if (backend === "core-tap" && !browserSessionId) throw new Error("Core Tap requires an active Real Chrome session");
  const format = browserAudioFormatValue();
  const bitrate = browserAudioBitrateValue();
  const capture = new URLSearchParams({
    backend,
    session: browserSessionId || "",
  });
  if (audio) capture.set("audio", audio);
  capture.set("bitrate", bitrate);
  const query = capture.toString();
  if (backend === "core-tap" && format === "hls") {
    throw new Error("Core Tap currently supports MP3 and Auto/PCM; choose one of those for A/B testing.");
  }
  if (format === "hls" && await canUseAudioHls()) {
    const hls = await api.get(`/api/browser/audio-hls/start?${query}&_=${Date.now()}`);
    if (hls?.id && hls?.url) {
      desktopAudioHlsSessionId = hls.id;
      desktopAudioHlsStopBase = "/api/browser/audio-hls";
      return `${hls.url}?_=${Date.now()}`;
    }
  }
  if (format === "hls") throw new Error("HLS audio is not supported in this browser.");
  if (format === "auto" && canUseBrowserPcmAudio()) {
    return `/stream/browser-pcm?${query}&_=${Date.now()}`;
  }
  return `/stream/browser-audio?${query}&_=${Date.now()}`;
}

function renderDesktopStatus(sources = state.desktopSources) {
  const status = $("#desktopStatus");
  const source = $("#desktopSource");
  const start = $("#desktopStartBtn");
  if (!status || !source || !start) return;
  status.className = "desktop-status";
  start.disabled = false;
  if (!sources || sources.loading) {
    status.textContent = "Checking capture devices...";
    source.textContent = "";
    start.disabled = true;
    return;
  }
  if (sources.error) {
    status.textContent = "Desktop capture probe failed";
    status.classList.add("bad");
    source.textContent = sources.error;
    start.disabled = false;
    return;
  }
  if (sources.enabled === false) {
    status.textContent = "Desktop streaming is disabled";
    status.classList.add("bad");
    source.textContent = "Set DESKTOP_STREAM_ENABLED=1 and restart the webapp to enable it.";
    start.disabled = true;
    return;
  }
  const screen = (sources.video || []).find((d) => /capture screen/i.test(d.name)) || sources.video?.[0];
  status.textContent = screen ? "Desktop capture is ready" : "No screen capture device found";
  status.classList.add(screen ? "ok" : "bad");
  const names = (sources.video || []).map((d) => `${d.index}: ${d.name}`).join(" · ");
  const recommendedAudio = (sources.audio || []).find((d) => String(d.index) === String(sources.recommendedAudio ?? ""));
  source.textContent = [
    `Configured input: ${sources.input || "0:none"}`,
    names ? `Video devices: ${names}` : "Video devices: none reported",
    recommendedAudio ? `Auto audio: ${recommendedAudio.index}: ${recommendedAudio.name}` : "Auto audio: none",
  ].join("\n");
  start.disabled = !screen;
}

function renderDesktopAudioOptions(sources = state.desktopSources) {
  const select = $("#desktopAudio");
  if (!select) return;
  const audio = sources?.audio || [];
  const saved = localStorage.getItem(DESKTOP_AUDIO_KEY);
  const savedName = localStorage.getItem(DESKTOP_AUDIO_NAME_KEY);
  const blackhole = audio.find((d) => /blackhole/i.test(d.name));
  const savedByName = savedName ? audio.find((d) => d.name === savedName) : null;
  const savedByIndex = saved ? audio.find((d) => String(d.index) === saved) : null;
  const recommended = blackhole || savedByName || savedByIndex || audio.find((d) => String(d.index) === String(sources?.recommendedAudio ?? ""));
  select.innerHTML = [
    `<option value="">No audio</option>`,
    ...audio.map((d) => `<option value="${esc(d.index)}">${esc(d.index)}: ${esc(d.name)}</option>`),
  ].join("");
  if (recommended && [...select.options].some((option) => option.value === String(recommended.index))) {
    select.value = String(recommended.index);
    localStorage.setItem(DESKTOP_AUDIO_KEY, String(recommended.index));
    localStorage.setItem(DESKTOP_AUDIO_NAME_KEY, recommended.name);
  }
  else select.value = "";
}

function preferredAudioDevice(audio, savedKey, savedNameKey, sources = state.desktopSources) {
  const saved = localStorage.getItem(savedKey);
  const savedName = localStorage.getItem(savedNameKey);
  const blackhole = audio.find((d) => /blackhole/i.test(d.name));
  const loopback = audio.find((d) => /loopback|soundflower|reincubate|virtual/i.test(d.name));
  const savedByName = savedName ? audio.find((d) => d.name === savedName) : null;
  const savedByIndex = saved ? audio.find((d) => String(d.index) === saved) : null;
  return blackhole || loopback || savedByName || savedByIndex || audio.find((d) => String(d.index) === String(sources?.recommendedAudio ?? ""));
}

function renderBrowserAudioOptions(sources = state.desktopSources) {
  const select = $("#browserAudio");
  if (!select) return;
  const playerSelect = $("#browserPlayerAudio");
  const audio = sources?.audio || [];
  const recommended = preferredAudioDevice(audio, BROWSER_AUDIO_KEY, BROWSER_AUDIO_NAME_KEY, sources);
  const html = [
    `<option value="">No audio</option>`,
    ...audio.map((d) => `<option value="${esc(d.index)}">${esc(d.index)}: ${esc(d.name)}</option>`),
  ].join("");
  select.innerHTML = html;
  if (playerSelect) playerSelect.innerHTML = html;
  if (recommended && [...select.options].some((option) => option.value === String(recommended.index))) {
    select.value = String(recommended.index);
    if (playerSelect) playerSelect.value = String(recommended.index);
    localStorage.setItem(BROWSER_AUDIO_KEY, String(recommended.index));
    localStorage.setItem(BROWSER_AUDIO_NAME_KEY, recommended.name);
  }
  else {
    select.value = "";
    if (playerSelect) playerSelect.value = "";
  }
}

function syncBrowserSettingsControls(source = "main") {
  const mainViewport = $("#browserViewport");
  const playerViewport = $("#browserPlayerViewport");
  const mainFps = $("#browserFps");
  const playerFps = $("#browserPlayerFps");
  const mainQuality = $("#browserQuality");
  const playerQuality = $("#browserPlayerQuality");
  const mainAudio = $("#browserAudio");
  const playerAudio = $("#browserPlayerAudio");
  const mainCapture = $("#browserAudioCapture");
  const playerCapture = $("#browserPlayerAudioCapture");
  const sourceFormat = source === "player"
    ? $("#browserPlayerAudioFormat [data-browser-audio-format].active")?.dataset.browserAudioFormat
    : $("#browserAudioFormat [data-browser-audio-format].active")?.dataset.browserAudioFormat;
  const sourceBitrate = source === "player"
    ? $("#browserPlayerAudioQuality [data-browser-audio-bitrate].active")?.dataset.browserAudioBitrate
    : $("#browserAudioQuality [data-browser-audio-bitrate].active")?.dataset.browserAudioBitrate;
  if (source === "player") {
    if (mainViewport && playerViewport) mainViewport.value = playerViewport.value;
    if (mainFps && playerFps) mainFps.value = playerFps.value;
    if (mainQuality && playerQuality) mainQuality.value = playerQuality.value;
    if (mainAudio && playerAudio) mainAudio.value = playerAudio.value;
    if (mainCapture && playerCapture) mainCapture.value = playerCapture.value;
  } else {
    if (mainViewport && playerViewport) playerViewport.value = mainViewport.value;
    if (mainFps && playerFps) playerFps.value = mainFps.value;
    if (mainQuality && playerQuality) playerQuality.value = mainQuality.value;
    if (mainAudio && playerAudio) playerAudio.value = mainAudio.value;
    if (mainCapture && playerCapture) playerCapture.value = mainCapture.value;
  }
  setBrowserAudioCapture(source === "player" ? playerCapture?.value : mainCapture?.value);
  if (sourceFormat) setBrowserAudioFormat(sourceFormat);
  if (sourceBitrate) setBrowserAudioBitrate(sourceBitrate);
  browserFpsValue();
  browserQualityValue();
}

function desktopInputReady() {
  return Boolean(desktopInputStatus?.enabled && desktopInputStatus?.available && desktopInputStatus?.trusted);
}

function desktopInputCanPrompt() {
  return Boolean(desktopInputStatus?.enabled && desktopInputStatus?.available && !desktopInputStatus?.trusted);
}

function clampDesktopZoomScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DESKTOP_ZOOM_MIN;
  return Math.max(DESKTOP_ZOOM_MIN, Math.min(DESKTOP_ZOOM_MAX, n));
}

function desktopMediaBaseRect() {
  const screen = $("#screen");
  const rect = screen.getBoundingClientRect();
  const media = activeScreenMediaElement();
  const display = desktopInputStatus?.display || {};
  const mediaW = media?.videoWidth || media?.naturalWidth || display.width || 16;
  const mediaH = media?.videoHeight || media?.naturalHeight || display.height || 9;
  const mediaAspect = mediaW > 0 && mediaH > 0 ? mediaW / mediaH : 16 / 9;
  const screenAspect = rect.width / rect.height;
  let left = rect.left;
  let top = rect.top;
  let width = rect.width;
  let height = rect.height;

  if (mediaAspect > screenAspect) {
    height = width / mediaAspect;
    top = rect.top + ((rect.height - height) / 2);
  } else {
    width = height * mediaAspect;
    left = rect.left + ((rect.width - width) / 2);
  }

  return { left, top, width, height, screenRect: rect };
}

function desktopMediaVisualRect() {
  const base = desktopMediaBaseRect();
  const cx = base.screenRect.left + (base.screenRect.width / 2);
  const cy = base.screenRect.top + (base.screenRect.height / 2);
  const scale = desktopZoom.scale;
  return {
    left: cx + desktopZoom.panX + (scale * (base.left - cx)),
    top: cy + desktopZoom.panY + (scale * (base.top - cy)),
    width: base.width * scale,
    height: base.height * scale,
    screenRect: base.screenRect,
  };
}

function clampDesktopPan() {
  if (desktopZoom.scale <= 1) {
    desktopZoom.panX = 0;
    desktopZoom.panY = 0;
    return;
  }
  const rect = $("#screen").getBoundingClientRect();
  const maxX = rect.width * (desktopZoom.scale - 1) / 2;
  const maxY = rect.height * (desktopZoom.scale - 1) / 2;
  desktopZoom.panX = Math.max(-maxX, Math.min(maxX, desktopZoom.panX));
  desktopZoom.panY = Math.max(-maxY, Math.min(maxY, desktopZoom.panY));
}

function renderDesktopZoomUi() {
  if (browserStreamActive) {
    renderBrowserZoomUi();
    return;
  }
  const screen = $("#screen");
  const controls = $("#desktopZoomControls");
  const out = $("#desktopZoomOutBtn");
  const reset = $("#desktopZoomResetBtn");
  const inn = $("#desktopZoomInBtn");
  const active = desktopStreamActive && desktopZoom.scale > 1;

  clampDesktopPan();
  screen.style.setProperty("--desktop-zoom-scale", String(desktopZoom.scale));
  screen.style.setProperty("--desktop-zoom-x", `${Math.round(desktopZoom.panX)}px`);
  screen.style.setProperty("--desktop-zoom-y", `${Math.round(desktopZoom.panY)}px`);
  screen.style.setProperty("--screen-zoom-scale", String(desktopZoom.scale));
  screen.style.setProperty("--screen-zoom-x", `${Math.round(desktopZoom.panX)}px`);
  screen.style.setProperty("--screen-zoom-y", `${Math.round(desktopZoom.panY)}px`);
  screen.classList.toggle("desktop-zoom-active", active);
  if (!controls) return;
  controls.hidden = !desktopStreamActive;
  out.disabled = !desktopStreamActive || desktopZoom.scale <= DESKTOP_ZOOM_MIN;
  inn.disabled = !desktopStreamActive || desktopZoom.scale >= DESKTOP_ZOOM_MAX;
  reset.textContent = desktopZoom.scale <= 1 ? "Fit" : `${Math.round(desktopZoom.scale * 100)}%`;
}

function setDesktopZoom(scale, { anchorX = null, anchorY = null } = {}) {
  const next = clampDesktopZoomScale(scale);
  const previous = desktopZoom.scale;
  if (next === previous) {
    renderDesktopZoomUi();
    return;
  }
  if (anchorX != null && anchorY != null && previous > 0) {
    const rect = $("#screen").getBoundingClientRect();
    const cx = rect.left + (rect.width / 2);
    const cy = rect.top + (rect.height / 2);
    desktopZoom.panX = anchorX - cx - ((next / previous) * (anchorX - cx - desktopZoom.panX));
    desktopZoom.panY = anchorY - cy - ((next / previous) * (anchorY - cy - desktopZoom.panY));
  }
  desktopZoom.scale = next;
  renderDesktopZoomUi();
}

function resetDesktopZoom() {
  desktopZoom.scale = 1;
  desktopZoom.panX = 0;
  desktopZoom.panY = 0;
  desktopZoom.panPointerId = null;
  $("#screen").classList.remove("desktop-panning");
  renderDesktopZoomUi();
}

function panDesktopZoom(dx, dy) {
  if (!desktopStreamActive || desktopZoom.scale <= 1) return;
  desktopZoom.panX += dx;
  desktopZoom.panY += dy;
  renderDesktopZoomUi();
}

function clampBrowserZoomScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return BROWSER_ZOOM_MIN;
  return Math.max(BROWSER_ZOOM_MIN, Math.min(BROWSER_ZOOM_MAX, n));
}

function clampBrowserPan() {
  if (browserZoom.scale <= 1) {
    browserZoom.panX = 0;
    browserZoom.panY = 0;
    return;
  }
  const rect = $("#screen").getBoundingClientRect();
  const maxX = rect.width * (browserZoom.scale - 1) / 2;
  const maxY = rect.height * (browserZoom.scale - 1) / 2;
  browserZoom.panX = Math.max(-maxX, Math.min(maxX, browserZoom.panX));
  browserZoom.panY = Math.max(-maxY, Math.min(maxY, browserZoom.panY));
}

function renderBrowserZoomUi() {
  const screen = $("#screen");
  if (!screen) return;
  const active = browserStreamActive && browserZoom.scale > 1;
  clampBrowserPan();
  if (browserStreamActive) {
    screen.style.setProperty("--screen-zoom-scale", String(browserZoom.scale));
    screen.style.setProperty("--screen-zoom-x", `${Math.round(browserZoom.panX)}px`);
    screen.style.setProperty("--screen-zoom-y", `${Math.round(browserZoom.panY)}px`);
  } else if (!desktopStreamActive) {
    screen.style.setProperty("--screen-zoom-scale", "1");
    screen.style.setProperty("--screen-zoom-x", "0px");
    screen.style.setProperty("--screen-zoom-y", "0px");
  }
  screen.classList.toggle("browser-zoom-active", active);
}

function setBrowserZoom(scale, { anchorX = null, anchorY = null } = {}) {
  const next = clampBrowserZoomScale(scale);
  const previous = browserZoom.scale;
  if (next === previous) {
    renderBrowserZoomUi();
    return;
  }
  if (anchorX != null && anchorY != null && previous > 0) {
    const rect = $("#screen").getBoundingClientRect();
    const cx = rect.left + (rect.width / 2);
    const cy = rect.top + (rect.height / 2);
    browserZoom.panX = anchorX - cx - ((next / previous) * (anchorX - cx - browserZoom.panX));
    browserZoom.panY = anchorY - cy - ((next / previous) * (anchorY - cy - browserZoom.panY));
  }
  browserZoom.scale = next;
  renderBrowserZoomUi();
}

function panBrowserZoom(dx, dy) {
  if (!browserStreamActive || browserZoom.scale <= 1) return;
  browserZoom.panX += dx;
  browserZoom.panY += dy;
  renderBrowserZoomUi();
}

function resetBrowserZoom() {
  browserZoom.scale = 1;
  browserZoom.panX = 0;
  browserZoom.panY = 0;
  browserZoom.pointers.clear();
  browserZoom.pinching = false;
  browserZoom.pinchStartDistance = 0;
  browserZoom.pinchStartScale = 1;
  browserZoom.pinchLastCenterX = 0;
  browserZoom.pinchLastCenterY = 0;
  $("#screen")?.classList.remove("browser-zoom-active");
  renderBrowserZoomUi();
}

function renderDesktopInputUi() {
  const panelBtn = $("#desktopInputToggle");
  const playerBtn = $("#desktopInputBtn");
  const status = $("#desktopInputStatus");
  const screen = $("#screen");
  const ready = desktopInputReady();
  const active = Boolean(desktopInputActive && desktopStreamActive && ready);

  screen.classList.toggle("desktop-input-active", active);
  renderDesktopZoomUi();
  if (playerBtn) {
    playerBtn.hidden = !desktopStreamActive || !ready;
    playerBtn.textContent = active ? "Touch on" : "Touch";
    playerBtn.classList.toggle("secondary", active);
    playerBtn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (!panelBtn || !status) return;

  panelBtn.classList.toggle("secondary", active);
  panelBtn.setAttribute("aria-pressed", active ? "true" : "false");
  status.className = "desktop-input-status";

  if (!desktopInputStatus) {
    panelBtn.disabled = true;
    panelBtn.textContent = "Touch control";
    status.textContent = "Checking input...";
    return;
  }
  if (!desktopInputStatus.enabled) {
    desktopInputActive = false;
    panelBtn.disabled = true;
    panelBtn.textContent = "Touch control";
    status.textContent = "Input disabled";
    return;
  }
  if (!desktopInputStatus.supported || !desktopInputStatus.available) {
    desktopInputActive = false;
    panelBtn.disabled = true;
    panelBtn.textContent = "Touch control";
    status.textContent = desktopInputStatus.error || "Input unavailable";
    status.classList.add("bad");
    return;
  }
  if (!desktopInputStatus.trusted) {
    desktopInputActive = false;
    panelBtn.disabled = false;
    panelBtn.textContent = "Grant input";
    status.textContent = "Accessibility permission needed";
    status.classList.add("bad");
    return;
  }
  panelBtn.disabled = !desktopStreamActive;
  panelBtn.textContent = active ? "Touch on" : "Touch control";
  status.textContent = desktopStreamActive ? (active ? "Touch control active" : "Ready") : "Start stream first";
  if (desktopStreamActive || active) status.classList.add("ok");
}

async function loadDesktopInputStatus({ prompt = false } = {}) {
  const res = await fetch(`/api/desktop/input/status${prompt ? "?prompt=1" : ""}`, {
    headers: prompt ? desktopInputHeaders() : {},
  });
  if (res.status === 401 && prompt && requestDesktopInputToken()) {
    return loadDesktopInputStatus({ prompt: true });
  }
  desktopInputStatus = await api.parse(res);
  renderDesktopInputUi();
  return desktopInputStatus;
}

function desktopInputHeaders() {
  const token = localStorage.getItem(DESKTOP_INPUT_TOKEN_KEY);
  return token ? { "X-Desktop-Input-Token": token } : {};
}

function requestDesktopInputToken() {
  const token = window.prompt("Desktop input code");
  if (!token) return false;
  localStorage.setItem(DESKTOP_INPUT_TOKEN_KEY, token);
  return true;
}

async function postDesktopInput(payload, retried = false) {
  try {
    const res = await fetch("/api/desktop/input", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...desktopInputHeaders() },
      body: JSON.stringify(payload),
    });
    if (res.status === 401 && !retried && requestDesktopInputToken()) {
      return postDesktopInput(payload, true);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(data?.error || res.statusText);
    return data;
  } catch (err) {
    if (Date.now() - desktopInputLastErrorAt > 2500) {
      desktopInputLastErrorAt = Date.now();
      toast(err.message || "Desktop input failed", true);
    }
    if (/permission|disabled|unavailable|token/i.test(err.message || "")) {
      desktopInputActive = false;
      renderDesktopInputUi();
    }
    return null;
  }
}

async function toggleDesktopInput() {
  if (!desktopInputStatus) await loadDesktopInputStatus().catch(() => {});
  if (desktopInputCanPrompt()) {
    await loadDesktopInputStatus({ prompt: true }).catch((e) => toast(e.message, true));
    if (!desktopInputReady()) {
      toast("Grant Accessibility permission, then refresh input status", true);
      return;
    }
  }
  if (!desktopInputReady()) {
    toast(desktopInputStatus?.error || "Desktop input is not ready", true);
    return;
  }
  if (!desktopStreamActive) {
    toast("Start desktop stream first", true);
    return;
  }
  desktopInputActive = !desktopInputActive;
  renderDesktopInputUi();
}

function desktopStreamQuery(videoDelayMs = 0) {
  const params = new URLSearchParams({
    height: $("#desktopHeight").value,
    fps: $("#desktopFps").value,
    quality: $("#desktopQuality").value,
    _: Date.now(),
  });
  if (videoDelayMs > 0) params.set("videoDelay", String(videoDelayMs));
  return params.toString();
}

function selectedDesktopAudio() {
  const select = $("#desktopAudio");
  const audio = select?.value || "";
  if (audio) localStorage.setItem(DESKTOP_AUDIO_KEY, audio);
  else localStorage.removeItem(DESKTOP_AUDIO_KEY);
  const name = select?.selectedOptions?.[0]?.textContent?.replace(/^\d+:\s*/, "") || "";
  if (audio && name) localStorage.setItem(DESKTOP_AUDIO_NAME_KEY, name);
  else localStorage.removeItem(DESKTOP_AUDIO_NAME_KEY);
  return audio;
}

function selectedBrowserAudio() {
  const select = $("#browserAudio");
  const playerSelect = $("#browserPlayerAudio");
  const audio = select?.value || "";
  if (playerSelect && playerSelect.value !== audio) playerSelect.value = audio;
  if (audio) localStorage.setItem(BROWSER_AUDIO_KEY, audio);
  else localStorage.removeItem(BROWSER_AUDIO_KEY);
  const name = select?.selectedOptions?.[0]?.textContent?.replace(/^\d+:\s*/, "") || "";
  if (audio && name) localStorage.setItem(BROWSER_AUDIO_NAME_KEY, name);
  else localStorage.removeItem(BROWSER_AUDIO_NAME_KEY);
  return audio;
}

function reapplyBrowserAudioStream({ restreamVideo = false } = {}) {
  if (!browserStreamActive || !replayFn) return;
  if (restreamVideo) {
    clearBrowserAudioRetry();
    toast("Restarting audio and video");
  }
  const result = replayFn();
  if (result?.catch) result.catch((e) => toast(e.message, true));
}

function handleBrowserAudioFormatClick(event, source = "main") {
  const btn = event.target.closest("[data-browser-audio-format]");
  if (!btn) return;
  setBrowserAudioFormat(btn.dataset.browserAudioFormat);
  syncBrowserSettingsControls(source);
  reapplyBrowserAudioStream({ restreamVideo: true });
}

function handleBrowserAudioQualityClick(event, source = "main") {
  const btn = event.target.closest("[data-browser-audio-bitrate]");
  if (!btn) return;
  setBrowserAudioBitrate(btn.dataset.browserAudioBitrate);
  syncBrowserSettingsControls(source);
  reapplyBrowserAudioStream({ restreamVideo: true });
}

const DESKTOP_PRESETS = {
  smooth: { height: "240", fps: "5", quality: "18" },
  balanced: { height: "360", fps: "5", quality: "12" },
  sharp: { height: "480", fps: "8", quality: "12" },
};

function applyDesktopPreset(name) {
  const preset = DESKTOP_PRESETS[name];
  if (!preset) return;
  $("#desktopHeight").value = preset.height;
  $("#desktopFps").value = preset.fps;
  $("#desktopQuality").value = preset.quality;
  reapplyDesktopControls();
}

function playDesktopStream() {
  state.playingItemId = null;
  renderItems();
  if (isMobileMode()) setPlayerDropdownOpen(true);
  resetDesktopZoom();
  renderDesktopInputUi();
  replayFn = async () => {
    const audio = selectedDesktopAudio();
    const q = desktopStreamQuery();
    stopDesktopHlsSession();
    const audioUrl = await desktopAudioUrl(audio);
    playCompatStream({
      mjpegUrl: `/stream/desktop?${q}`,
      audioUrl,
    }, audio ? "Desktop + Audio" : "Desktop", { live: true, syncVideoToAudio: Boolean(audio) });
    setDesktopStreamActive(true);
    renderDesktopInputUi();
  };
  replayFn().catch((e) => toast(e.message, true));
}

function reapplyDesktopControls() {
  if (!desktopStreamActive || !replayFn) return;
  restreamPlayback();
}

function setBrowserStatus(message, kind = "") {
  const status = $("#browserStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `browser-status${kind ? ` ${kind}` : ""}`;
}

function formatSessionSeconds(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function browserSessionTitle(session) {
  const title = String(session?.title || "").trim();
  if (title && !["real chrome", "chrome", "browser", "about:blank"].includes(title.toLowerCase())) return title;
  try {
    return new URL(session?.url || "").hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return session?.url || "Browser";
  }
}

function renderBrowserSessionManager(snapshot = null) {
  const summary = $("#browserSessionSummary");
  const list = $("#browserSessionList");
  if (!summary || !list) return;
  if (!snapshot) {
    summary.textContent = "Session status unavailable";
    list.innerHTML = "";
    return;
  }
  const sessions = [
    ...(snapshot.realChrome || []),
    ...(snapshot.browser || []),
  ].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const total = sessions.length;
  const audio = snapshot.counts?.audioStreams || 0;
  summary.textContent = total
    ? `${total} browser session${total === 1 ? "" : "s"} running · ${audio} audio stream${audio === 1 ? "" : "s"}`
    : audio
      ? `No browser sessions · ${audio} audio stream${audio === 1 ? "" : "s"}`
      : "No browser sessions running";
  if (!sessions.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = sessions.slice(0, 4).map((session) => {
    const backend = session.backend === "real-chrome" ? "Chrome" : "Private";
    const backendPath = session.backend === "real-chrome" ? "real-chrome" : "browser";
    const clientText = `${session.clients || 0} client${session.clients === 1 ? "" : "s"}`;
    return `
      <div class="browser-session-row" data-browser-session-id="${esc(session.id)}" data-browser-session-backend="${esc(backendPath)}">
        <span>
          <strong>${esc(backend)} · ${esc(browserSessionTitle(session))}</strong>
          <span>${esc(clientText)} · idle ${esc(formatSessionSeconds(session.idleMs))}</span>
        </span>
        <time>${esc(formatSessionSeconds(session.ageMs))}</time>
        <button class="btn small ghost browser-session-close" type="button" data-browser-session-close aria-label="Close ${esc(backend)} session">Close</button>
      </div>`;
  }).join("");
}

function activeBrowserSessionExists(snapshot) {
  if (!browserSessionId || !snapshot) return true;
  const sessions = realChromeActive ? snapshot.realChrome || [] : snapshot.browser || [];
  return sessions.some((session) => session.id === browserSessionId);
}

function clearBrowserLocalPlayback(message = "") {
  const hadBrowserPlayback = browserStreamActive || $("#screen")?.classList.contains("browser-mode");
  browserSessionId = null;
  realChromeActive = false;
  browserInputActive = false;
  browserInputPointerId = null;
  hideBrowserKeyboard();
  resetBrowserZoom();
  setBrowserStreamActive(false);
  if (hadBrowserPlayback) {
    cleanupMedia();
    stopStreamSeekTimer(true);
    resetPauseControl(true);
    replayFn = null;
    setBadge("hidden");
    $("#screen")?.classList.remove("playing", "loading", "video-mode", "mjpeg-mode", "mjpeg-buffered-mode", "browser-mode", "browser-input-active", "browser-keyboard-active");
    $("#nowPlaying").textContent = "Player";
    $("#stopBtn").disabled = true;
    $("#restreamBtn").disabled = true;
  }
  setBrowserStatus(message || "Ready", message ? "bad" : "");
  renderBrowserInputUi();
}

async function refreshSessionManager({ notify = false } = {}) {
  let snapshot = null;
  try {
    snapshot = await api.get(`/api/sessions?_=${Date.now()}`);
    renderBrowserSessionManager(snapshot);
  } catch (err) {
    console.warn("session status failed:", err.message);
    renderBrowserSessionManager(null);
    return null;
  }

  const total = (snapshot.counts?.browserSessions || 0) + (snapshot.counts?.realChromeSessions || 0);
  if (browserSessionId && !activeBrowserSessionExists(snapshot)) {
    clearBrowserLocalPlayback("Browser session closed by server");
    if (notify) toast("Browser session closed to free memory");
  } else if (
    notify &&
    state.mode === "browser" &&
    browserSessionPollLastTotal != null &&
    browserSessionPollLastTotal > total
  ) {
    toast("Idle browser session cleaned up");
  }
  browserSessionPollLastTotal = total;
  return snapshot;
}

async function closeRemoteBrowserSessions() {
  const btn = $("#browserCleanupBtn");
  if (btn) btn.disabled = true;
  setBrowserStatus("Closing browser sessions...", "");
  try {
    await stopDesktopAudioHlsSession();
    const result = await api.post("/api/sessions/cleanup", {});
    clearBrowserLocalPlayback();
    await refreshSessionManager({ notify: false });
    const stopped = Number(result?.stopped || 0);
    if (!stopped) {
      toast("No browser sessions to close");
      return;
    }
    const details = [];
    const browserSessions = Number(result?.stoppedBrowser || 0) + Number(result?.stoppedRealChrome || 0);
    const audioHls = Number(result?.stoppedAudioHls || 0);
    const chromeOrphans = Number(result?.stoppedRealChromeOrphans || 0);
    if (browserSessions) details.push(`${browserSessions} browser session${browserSessions === 1 ? "" : "s"}`);
    if (audioHls) details.push(`${audioHls} audio stream${audioHls === 1 ? "" : "s"}`);
    if (chromeOrphans) details.push(`${chromeOrphans} Chrome orphan${chromeOrphans === 1 ? "" : "s"}`);
    toast(`Closed ${details.join(", ")}`);
  } catch (err) {
    setBrowserStatus(err.message, "bad");
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function closeBrowserSessionFromList(event) {
  const button = event.target.closest("[data-browser-session-close]");
  const row = button?.closest("[data-browser-session-id][data-browser-session-backend]");
  if (!button || !row) return;
  const id = row.dataset.browserSessionId;
  const backend = row.dataset.browserSessionBackend;
  if (!id || !["browser", "real-chrome"].includes(backend)) return;
  button.disabled = true;
  try {
    await api.post(`/api/${backend}/${encodeURIComponent(id)}/stop`);
    if (browserSessionId === id) {
      await stopDesktopAudioHlsSession();
      clearBrowserLocalPlayback("Browser session closed");
    }
    await refreshSessionManager({ notify: false });
    toast("Browser session closed");
  } catch (err) {
    button.disabled = false;
    toast(err.message, true);
  }
}

function parseBrowserViewport() {
  const raw = $("#browserViewport")?.value || "1280x720";
  const match = raw.match(/^(\d+)x(\d+)$/i);
  return {
    width: match ? Number(match[1]) : 1280,
    height: match ? Number(match[2]) : 720,
  };
}

function browserFpsValue() {
  const input = $("#browserFps");
  const n = Math.max(3, Math.min(60, parseInt(input?.value || "6", 10) || 6));
  if (input) input.value = String(n);
  const playerInput = $("#browserPlayerFps");
  if (playerInput) playerInput.value = String(n);
  const out = $("#browserFpsValue");
  if (out) out.textContent = `${n} FPS`;
  const playerOut = $("#browserPlayerFpsValue");
  if (playerOut) playerOut.textContent = `${n} FPS`;
  return String(n);
}

function browserQualityValue() {
  const input = $("#browserQuality");
  const stored = localStorage.getItem(BROWSER_QUALITY_KEY);
  if (input && stored && input.dataset.ready !== "true") input.value = stored;
  const raw = input?.value || stored || "70";
  const n = Math.max(20, Math.min(90, parseInt(raw, 10) || 70));
  if (input) input.value = String(n);
  if (input) input.dataset.ready = "true";
  const playerInput = $("#browserPlayerQuality");
  if (playerInput) playerInput.value = String(n);
  const out = $("#browserQualityValue");
  if (out) out.textContent = `${n}%`;
  const playerOut = $("#browserPlayerQualityValue");
  if (playerOut) playerOut.textContent = `${n}%`;
  localStorage.setItem(BROWSER_QUALITY_KEY, String(n));
  return String(n);
}

function browserHistoryTimeLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function browserHistoryDisplayTitle(item) {
  const title = String(item?.title || "").trim();
  if (title && !["real chrome", "chrome", "browser", "about:blank"].includes(title.toLowerCase())) return title;
  try {
    return new URL(item?.url || "").hostname.replace(/^www\./, "") || item?.url || "Website";
  } catch {
    return item?.url || "Website";
  }
}

function setBrowserHistorySummary(text) {
  document.querySelectorAll("[data-browser-history-summary]").forEach((summary) => { summary.textContent = text; });
  const legacySummary = $("#browserHistorySummary");
  if (legacySummary) legacySummary.textContent = text;
}

function setBrowserHistoryLists(html) {
  document.querySelectorAll("[data-browser-history-list], #browserHistoryList, #browserPlayerHistoryList").forEach((list) => {
    list.innerHTML = html;
  });
}

function setBrowserHistoryClearDisabled(disabled) {
  document.querySelectorAll("[data-browser-history-clear], #browserHistoryClearBtn, #browserPlayerHistoryClearBtn").forEach((button) => {
    button.disabled = disabled;
  });
}

function renderBrowserHistory() {
  const hasList = $("#browserHistoryList") || $("#browserPlayerHistoryList") || document.querySelector("[data-browser-history-list]");
  if (!hasList) return;
  setBrowserHistoryClearDisabled(!state.browserHistory.length || state.browserHistoryLoading);
  if (state.browserHistoryLoading) {
    setBrowserHistorySummary("Loading...");
    setBrowserHistoryLists('<div class="browser-history-empty">Loading...</div>');
    return;
  }
  if (!state.browserHistory.length) {
    setBrowserHistorySummary("No browser history yet");
    setBrowserHistoryLists('<div class="browser-history-empty">No browser history yet.</div>');
    return;
  }
  setBrowserHistorySummary(`${state.browserHistory.length} saved site${state.browserHistory.length === 1 ? "" : "s"}`);
  setBrowserHistoryLists(state.browserHistory.map((item) => `
    <article class="browser-history-row" data-browser-history-id="${esc(item.id)}">
      <div class="browser-history-info">
        <strong>${esc(browserHistoryDisplayTitle(item))}</strong>
        <span>${esc(item.url || "")}</span>
        <time>${esc(browserHistoryTimeLabel(item.lastOpenedAt))}</time>
      </div>
      <div class="browser-history-actions">
        <button class="btn small secondary" type="button" data-browser-history-action="load">Load</button>
        <button class="btn small ghost" type="button" data-browser-history-action="delete">Delete</button>
      </div>
    </article>
  `).join(""));
}

async function loadBrowserHistory() {
  state.browserHistoryLoading = true;
  renderBrowserHistory();
  try {
    state.browserHistory = await api.get(`/api/browser-history?_=${Date.now()}`);
    state.browserHistoryLoaded = true;
  } catch (e) {
    state.browserHistory = [];
    toast(e.message, true);
  } finally {
    state.browserHistoryLoading = false;
    renderBrowserHistory();
  }
}

async function recordBrowserHistory(session) {
  if (!session?.url) return;
  try {
    const saved = await api.post("/api/browser-history", {
      url: session.url,
      title: session.title || session.url,
    });
    const existingIndex = state.browserHistory.findIndex((item) => item.id === saved.id);
    if (existingIndex >= 0) state.browserHistory.splice(existingIndex, 1);
    state.browserHistory.unshift(saved);
    renderBrowserHistory();
  } catch (e) {
    console.warn("browser history failed:", e.message);
  }
}

async function handleBrowserHistoryClick(e) {
  const button = e.target.closest("[data-browser-history-action]");
  const row = button?.closest("[data-browser-history-id]");
  if (!button || !row) return;
  const item = state.browserHistory.find((entry) => entry.id === row.dataset.browserHistoryId);
  if (!item) return;
  if (button.dataset.browserHistoryAction === "delete") {
    try {
      await api.del(`/api/browser-history/${encodeURIComponent(item.id)}`);
      state.browserHistory = state.browserHistory.filter((entry) => entry.id !== item.id);
      renderBrowserHistory();
      toast("Browser history deleted");
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  $("#browserUrl").value = item.url || "";
  await playRealChromeStream().catch((err) => {
    setBrowserStatus(err.message, "bad");
    toast(err.message, true);
  });
}

async function clearBrowserHistory() {
  if (!state.browserHistory.length) return;
  if (!confirm("Clear browser history?")) return;
  try {
    await api.del("/api/browser-history");
    state.browserHistory = [];
    renderBrowserHistory();
    toast("Browser history cleared");
  } catch (e) {
    toast(e.message, true);
  }
}

function browserInputReady() {
  return Boolean(browserStreamActive && browserSessionId);
}

function renderBrowserInputUi() {
  const panelBtn = $("#browserTouchToggle");
  const playerBtn = $("#browserInputBtn");
  const settingsBtn = $("#browserSettingsBtn");
  const settingsPanel = $("#browserPlayerSettings");
  const closePopupBtn = $("#browserClosePopupBtn");
  const screen = $("#screen");
  const ready = browserInputReady();
  const active = Boolean(browserInputActive && ready);
  screen?.classList.toggle("browser-input-active", active);
  if (playerBtn) {
    playerBtn.hidden = !browserStreamActive;
    playerBtn.textContent = active ? "Touch on" : "Touch";
    playerBtn.classList.toggle("secondary", active);
    playerBtn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (panelBtn) {
    panelBtn.disabled = !browserStreamActive;
    panelBtn.textContent = active ? "Touch on" : "Touch control";
    panelBtn.classList.toggle("secondary", active);
    panelBtn.setAttribute("aria-pressed", active ? "true" : "false");
  }
  if (settingsBtn) {
    settingsBtn.hidden = !browserStreamActive;
    settingsBtn.classList.toggle("secondary", browserSettingsOpen && browserStreamActive);
    settingsBtn.setAttribute("aria-expanded", browserSettingsOpen && browserStreamActive ? "true" : "false");
  }
  if (settingsPanel) settingsPanel.hidden = !(browserStreamActive && browserSettingsOpen);
  if (closePopupBtn) closePopupBtn.hidden = !(browserStreamActive && realChromeActive);
  syncBrowserSettingsControls("main");
}

async function closeRealChromePopup() {
  if (!browserSessionId || !realChromeActive) return;
  const button = $("#browserClosePopupBtn");
  if (button) button.disabled = true;
  try {
    const result = await api.post(`/api/real-chrome/${encodeURIComponent(browserSessionId)}/close-tab`, {});
    const session = result?.session;
    if (session?.url) $("#browserUrl").value = session.url;
    if (result?.closed || result?.recovered) {
      setBrowserStatus(
        result?.recovered
          ? "Returned to APNE TV"
          : session?.title || session?.url || "Returned to main tab",
        "ok",
      );
      resetBrowserZoom();
      hideBrowserKeyboard();
    }
  } catch (err) {
    toast(err.message || "Could not close popup tab", true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function stopBrowserSession({ stopRealChromeOrphans = false } = {}) {
  const id = browserSessionId;
  const wasRealChrome = realChromeActive;
  clearBrowserAudioRetry();
  destroyBrowserPcmAudio();
  browserSessionId = null;
  realChromeActive = false;
  browserInputActive = false;
  browserInputPointerId = null;
  hideBrowserKeyboard();
  resetBrowserZoom();
  setBrowserStreamActive(false);
  $("#screen")?.classList.remove("browser-mode", "browser-input-active", "browser-keyboard-active");
  if (id) {
    const base = wasRealChrome ? "real-chrome" : "browser";
    await api.post(`/api/${base}/${encodeURIComponent(id)}/stop`).catch(() => {});
  }
  if (stopRealChromeOrphans) {
    await api.post("/api/real-chrome/stop").catch(() => {});
  }
  setBrowserStatus("Ready");
  refreshSessionManager({ notify: false }).catch(() => {});
}

async function postBrowserInput(payload) {
  if (!browserSessionId) return null;
  try {
    const base = realChromeActive ? "real-chrome" : "browser";
    return await api.post(`/api/${base}/${encodeURIComponent(browserSessionId)}/input`, payload);
  } catch (err) {
    if (Date.now() - browserInputLastErrorAt > 2500) {
      browserInputLastErrorAt = Date.now();
      toast(err.message || "Browser input failed", true);
    }
    return null;
  }
}

function browserKeyboardInputMode(info = {}) {
  const type = String(info.type || "").toLowerCase();
  if (type === "search") return "search";
  if (type === "email") return "email";
  if (type === "url") return "url";
  if (type === "tel") return "tel";
  if (type === "number") return "decimal";
  return "text";
}

function hideBrowserKeyboard({ blur = true } = {}) {
  clearTimeout(browserKeyboardFocusTimer);
  browserKeyboardFocusTimer = null;
  browserKeyboardSyncing = false;
  browserKeyboardLastValue = "";
  const input = $("#browserKeyboardInput");
  if (!input) return;
  input.hidden = true;
  input.value = "";
  $("#screen")?.classList.remove("browser-keyboard-active");
  if (blur) input.blur();
}

function showBrowserKeyboard(info = {}) {
  const input = $("#browserKeyboardInput");
  if (!input || !browserInputActiveForScreen()) return;
  browserKeyboardSyncing = true;
  browserKeyboardLastValue = String(info.value || "");
  input.value = browserKeyboardLastValue;
  input.inputMode = browserKeyboardInputMode(info);
  if (Number.isFinite(info.maxLength) && info.maxLength > 0) input.maxLength = info.maxLength;
  else input.removeAttribute("maxlength");
  input.placeholder = info.placeholder || "Type here";
  input.hidden = false;
  $("#screen")?.classList.add("browser-keyboard-active");
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    try {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } catch {}
    browserKeyboardSyncing = false;
  });
}

async function refreshBrowserKeyboardFocus() {
  if (!browserInputActiveForScreen()) {
    hideBrowserKeyboard();
    return;
  }
  const info = await postBrowserInput({ type: "focus-info" });
  if (info?.editable) showBrowserKeyboard(info);
  else hideBrowserKeyboard();
}

function queueBrowserKeyboardFocus(delay = 120) {
  clearTimeout(browserKeyboardFocusTimer);
  browserKeyboardFocusTimer = setTimeout(() => {
    browserKeyboardFocusTimer = null;
    refreshBrowserKeyboardFocus().catch(() => hideBrowserKeyboard());
  }, delay);
}

function syncBrowserKeyboardText() {
  const input = $("#browserKeyboardInput");
  if (!input || input.hidden || browserKeyboardSyncing) return;
  const value = input.value;
  if (value === browserKeyboardLastValue) return;
  browserKeyboardLastValue = value;
  void postBrowserInput({ type: "replace-text", text: value });
}

function browserStreamUrl(id) {
  return `/stream/browser/${encodeURIComponent(id)}?_=${Date.now()}`;
}

function realChromeStreamUrl(id) {
  return `/stream/real-chrome/${encodeURIComponent(id)}?_=${Date.now()}`;
}

async function applyBrowserSettingsNow() {
  if (!browserSessionId) return;
  const viewport = parseBrowserViewport();
  const fps = browserFpsValue();
  const quality = browserQualityValue();
  browserSettingsInFlight = true;
  try {
    const base = realChromeActive ? "/api/real-chrome" : "/api/browser";
    const session = await api.patch(`${base}/${encodeURIComponent(browserSessionId)}/settings`, {
      ...viewport,
      fps,
      quality,
    });
    browserViewport = { width: session.width || viewport.width, height: session.height || viewport.height };
    setBrowserStatus(session.title || session.url || "Browser running", "ok");
  } catch (err) {
    toast(err.message, true);
  } finally {
    browserSettingsInFlight = false;
    if (browserSettingsPending) {
      browserSettingsPending = false;
      queueBrowserSettingsUpdate();
    }
  }
}

function queueBrowserSettingsUpdate({ immediate = false } = {}) {
  browserFpsValue();
  browserQualityValue();
  if (!browserStreamActive || !browserSessionId) return;
  if (browserSettingsInFlight) {
    browserSettingsPending = true;
    return;
  }
  clearTimeout(browserSettingsTimer);
  browserSettingsTimer = setTimeout(() => {
    browserSettingsTimer = null;
    applyBrowserSettingsNow();
  }, immediate ? 0 : 120);
}

async function playBrowserStream() {
  const url = $("#browserUrl").value.trim();
  if (!url) {
    $("#browserUrl").focus();
    toast("Enter a website URL", true);
    return;
  }
  const viewport = parseBrowserViewport();
  const fps = browserFpsValue();
  const quality = browserQualityValue();
  setBrowserStatus("Starting browser...", "");
  await ensureBrowserAudioSourcesReady();
  await stopBrowserSession();
  resetBrowserZoom();
  const session = await api.post("/api/browser/start", { url, ...viewport, fps, quality });
  browserSessionId = session.id;
  browserViewport = { width: session.width || viewport.width, height: session.height || viewport.height };
  $("#browserUrl").value = session.url || url;
  replayFn = async () => {
    if (!browserSessionId) return;
    const audio = selectedBrowserAudio();
    const audioUrl = await browserAudioUrl(audio);
    playCompatStream({
      mjpegUrl: browserStreamUrl(browserSessionId),
      audioUrl,
    }, `Private browser: ${session.title || session.url || url}`, {
      live: true,
      browserStream: true,
      browserAudio: Boolean(audioUrl),
      browserPcm: isBrowserPcmUrl(audioUrl),
      looseAudioSync: false,
    });
    $("#screen").classList.add("browser-mode");
    setBrowserStreamActive(true);
    browserInputActive = true;
    renderBrowserInputUi();
  };
  if (isMobileMode()) setPlayerDropdownOpen(true);
  await replayFn();
  setBrowserStatus(session.title || session.url || "Browser running", "ok");
  refreshSessionManager({ notify: false }).catch(() => {});
  void recordBrowserHistory(session);
}

async function playRealChromeStream() {
  const viewport = parseBrowserViewport();
  const fps = browserFpsValue();
  const quality = browserQualityValue();
  const rawUrl = $("#browserUrl").value.trim();
  const startUrl = !rawUrl || /^https?:\/\/(www\.)?example\.com\/?$/i.test(rawUrl)
    ? "https://www.google.com/"
    : rawUrl;
  setBrowserStatus("Starting Real Chrome...", "");
  await ensureBrowserAudioSourcesReady();
  await stopBrowserSession({ stopRealChromeOrphans: true });
  resetBrowserZoom();
  const session = await api.post("/api/real-chrome/start", { url: startUrl, ...viewport, fps, quality });
  browserSessionId = session.id;
  realChromeActive = true;
  browserViewport = { width: session.width || viewport.width, height: session.height || viewport.height };
  $("#browserUrl").value = session.url || startUrl;
  replayFn = async () => {
    if (!browserSessionId) return;
    const audio = selectedBrowserAudio();
    const audioUrl = await browserAudioUrl(audio);
    playCompatStream({
      mjpegUrl: realChromeStreamUrl(browserSessionId),
      audioUrl,
    }, `Chrome: ${session.title || session.url || startUrl}`, {
      live: true,
      browserStream: true,
      browserAudio: Boolean(audioUrl),
      browserPcm: isBrowserPcmUrl(audioUrl),
      looseAudioSync: false,
    });
    $("#screen").classList.add("browser-mode");
    setBrowserStreamActive(true);
    browserInputActive = true;
    renderBrowserInputUi();
  };
  if (isMobileMode()) setPlayerDropdownOpen(true);
  await replayFn();
  setBrowserStatus(`Real Chrome running with persistent profile: ${session.profile || "dedicated profile"}`, "ok");
  refreshSessionManager({ notify: false }).catch(() => {});
  void recordBrowserHistory(session);
}

async function reloadBrowserStream() {
  if (!browserSessionId) {
    await playRealChromeStream();
    return;
  }
  if (realChromeActive) {
    const url = $("#browserUrl").value.trim();
    if (!url) return;
    setBrowserStatus("Loading in Real Chrome...", "");
    try {
      const session = await api.post(`/api/real-chrome/${encodeURIComponent(browserSessionId)}/navigate`, { url });
      $("#browserUrl").value = session.url || url;
      if (replayFn) await replayFn();
      setBrowserStatus(session.title || session.url || "Real Chrome running", "ok");
      refreshSessionManager({ notify: false }).catch(() => {});
      void recordBrowserHistory(session);
    } catch (err) {
      setBrowserStatus(err.message, "bad");
      toast(err.message, true);
    }
    return;
  }
  const url = $("#browserUrl").value.trim();
  if (!url) return;
  setBrowserStatus("Loading...", "");
  try {
    const session = await api.post(`/api/browser/${encodeURIComponent(browserSessionId)}/navigate`, { url });
    browserViewport = { width: session.width || browserViewport.width, height: session.height || browserViewport.height };
    $("#browserUrl").value = session.url || url;
    if (replayFn) await replayFn();
    setBrowserStatus(session.title || session.url || "Browser running", "ok");
    refreshSessionManager({ notify: false }).catch(() => {});
    void recordBrowserHistory(session);
  } catch (err) {
    setBrowserStatus(err.message, "bad");
    toast(err.message, true);
  }
}

function toggleBrowserInput() {
  if (!browserStreamActive || !browserSessionId) {
    toast("Start browser stream first", true);
    return;
  }
  browserInputActive = !browserInputActive;
  if (!browserInputActive) hideBrowserKeyboard();
  renderBrowserInputUi();
}

function toggleBrowserPlayerSettings() {
  if (!browserStreamActive || !browserSessionId) {
    toast("Start browser stream first", true);
    return;
  }
  browserSettingsOpen = !browserSettingsOpen;
  renderBrowserInputUi();
}

function openBrowser() {
  setMode("browser");
  renderBrowserInputUi();
  browserFpsValue();
  browserQualityValue();
  syncBrowserAudioControls();
  if (state.desktopSources?.audio?.length) renderBrowserAudioOptions(state.desktopSources);
  else loadBrowserAudioSources().catch((e) => {
    renderBrowserAudioOptions({ audio: [] });
    console.warn("browser audio probe failed:", e.message);
  });
  renderBrowserHistory();
  if (!state.browserHistoryLoaded) loadBrowserHistory().catch((e) => toast(e.message, true));
  refreshSessionManager({ notify: false }).catch(() => {});
  loadYoutubeAuthStatus().catch(() => renderYoutubeAuth());
  if (!$("#browserUrl").value.trim()) $("#browserUrl").value = "https://example.com";
}

function sourceName(id) {
  return ch.sources.find((s) => s.id === id)?.name || (id === "country:us" ? "United States (US)" : "Custom playlist");
}

function selectedSource() {
  return ch.sources.find((s) => s.id === ch.src) || null;
}

function sourceCountryMeta() {
  const src = selectedSource();
  const countryId = String(ch.src || "").match(/^country:([a-z]{2})$/i);
  const code = (src?.countryCode || countryId?.[1] || "").toString().toUpperCase();
  if (!code) return null;
  return {
    countryCode: code,
    countryName: cleanCountryName(src?.countryName || src?.name, code),
  };
}

function channelCategory(c) {
  return c.category || c.group || c.sourceCategory || "Other";
}

function channelCountryMeta(c) {
  const fromSource = sourceCountryMeta();
  if (fromSource) return fromSource;
  const raw = String(c.country || "").split(/[;,]/).map((part) => part.trim()).filter(Boolean)[0] || "";
  if (raw) {
    const code = raw.length <= 3 ? raw.toUpperCase() : "";
    return { countryCode: code || raw, countryName: code ? `Country ${code}` : raw };
  }
  return { countryCode: "CUSTOM", countryName: "Custom" };
}

function canonicalUrl(url) {
  return String(url || "").trim();
}

function canonicalCategory(category) {
  return String(category || "Other").trim().toLowerCase();
}

function displayCategory(category) {
  const parts = String(category || "Other").split(/[;/]/).map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || "Other";
}

function savedChannelKey(c) {
  const country = channelCountryMeta(c);
  return {
    url: canonicalUrl(c.url),
    countryCode: String(country.countryCode || "").toUpperCase(),
    countryName: String(country.countryName || ""),
    category: canonicalCategory(channelCategory(c)),
  };
}

function itemSavedKey(playlist, item) {
  return {
    url: canonicalUrl(item.url),
    countryCode: String(item.meta?.countryCode || playlist.meta?.countryCode || "").toUpperCase(),
    countryName: String(item.meta?.countryName || playlist.meta?.countryName || ""),
    category: canonicalCategory(item.meta?.category || item.meta?.group || "Other"),
  };
}

function findSavedChannel(c) {
  const key = savedChannelKey(c);
  for (const playlist of state.playlists) {
    for (const item of playlist.items || []) {
      const existing = itemSavedKey(playlist, item);
      if (
        existing.url === key.url &&
        existing.category === key.category &&
        (existing.countryCode === key.countryCode || existing.countryName === key.countryName)
      ) {
        return { playlist, item };
      }
    }
  }
  return null;
}

function setChannelSaveState(row, c) {
  const addBtn = row.querySelector("[data-act='add']");
  if (!addBtn) return;
  const saved = findSavedChannel(c);
  row.classList.toggle("saved", Boolean(saved));
  addBtn.disabled = Boolean(saved);
  addBtn.classList.toggle("saved", Boolean(saved));
  addBtn.textContent = saved ? "Saved" : "+";
  addBtn.title = saved ? "Saved" : "Save to playlist";
  addBtn.setAttribute("aria-label", saved ? `Saved ${c.name}` : `Save ${c.name} to playlist`);
}

function refreshChannelSavedStates() {
  document.querySelectorAll("#chList .ch-row").forEach((row) => {
    try {
      const c = JSON.parse(decodeURIComponent(row.dataset.ch));
      setChannelSaveState(row, c);
    } catch {}
  });
}

function showSaveFeedback(playlist, category) {
  state.lastSavedPlaylistId = playlist.id;
  $("#chSaveMessage").textContent = `Saved to ${playlist.name} > ${displayCategory(category)}`;
  $("#chSaveFeedback").hidden = false;
}

function renderSourceMenu() {
  $("#chSourceBtn").textContent = sourceName(ch.src);
  const order = ["Countries", "Categories", "Catalog", "Custom"];
  const byGroup = ch.sources.reduce((acc, src) => {
    const group = src.group || "Catalog";
    if (!acc.has(group)) acc.set(group, []);
    acc.get(group).push(src);
    return acc;
  }, new Map());
  $("#chSourcePanel").innerHTML = order
    .filter((group) => byGroup.has(group))
    .map((group) => (
      `<div class="ch-menu-section">${esc(group)}</div>` +
      byGroup.get(group).map((s) => (
        `<button class="ch-menu-option ${s.id === ch.src ? "active" : ""}" type="button" role="option" data-value="${esc(s.id)}" aria-selected="${s.id === ch.src ? "true" : "false"}">${esc(s.name)}</button>`
      )).join("")
    )).join("");
}

function renderGroupMenu() {
  const label = ch.group || `All groups${ch.total ? ` (${ch.total})` : ""}`;
  $("#chGroupBtn").textContent = label;
  $("#chGroupPanel").innerHTML = `<button class="ch-menu-option ${ch.group ? "" : "active"}" type="button" role="option" data-value="" aria-selected="${ch.group ? "false" : "true"}">All groups${ch.total ? ` (${ch.total})` : ""}</button>` +
    ch.groups.map((g) => `<button class="ch-menu-option ${g === ch.group ? "active" : ""}" type="button" role="option" data-value="${esc(g)}" aria-selected="${g === ch.group ? "true" : "false"}">${esc(g)}</button>`).join("");
}

function toggleChannelMenu(kind) {
  const isSource = kind === "source";
  const btn = isSource ? $("#chSourceBtn") : $("#chGroupBtn");
  const panel = isSource ? $("#chSourcePanel") : $("#chGroupPanel");
  const otherBtn = isSource ? $("#chGroupBtn") : $("#chSourceBtn");
  const otherPanel = isSource ? $("#chGroupPanel") : $("#chSourcePanel");
  const nextOpen = panel.hidden;
  panel.hidden = !nextOpen;
  btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  otherPanel.hidden = true;
  otherBtn.setAttribute("aria-expanded", "false");
}

function closeChannelMenus() {
  $("#chSourcePanel").hidden = true;
  $("#chGroupPanel").hidden = true;
  $("#chSourceBtn").setAttribute("aria-expanded", "false");
  $("#chGroupBtn").setAttribute("aria-expanded", "false");
}

function selectChannelSource(src) {
  if (!src || src === ch.src) { closeChannelMenus(); return; }
  ch.src = src;
  localStorage.setItem(CHANNEL_SOURCE_KEY, ch.src);
  ch.group = "";
  ch.q = "";
  $("#chSearch").value = "";
  renderSourceMenu();
  renderGroupMenu();
  closeChannelMenus();
  loadChannels(true);
}

function selectChannelGroup(group) {
  ch.group = group || "";
  renderGroupMenu();
  closeChannelMenus();
  loadChannels(true);
}

async function loadChannelSources(autoLoad) {
  try {
    const sources = await api.get("/api/catalog");
    if (/^https?:\/\//i.test(ch.src) && !sources.some((s) => s.id === ch.src)) {
      sources.unshift({ id: ch.src, name: "Custom playlist", group: "Custom" });
    }
    if (!sources.some((s) => s.id === ch.src) && !/^https?:\/\//i.test(ch.src)) ch.src = "country:us";
    ch.sources = sources;
    renderSourceMenu();
    ch.sourcesLoaded = true;
    if (autoLoad) await loadChannels(true);
  } catch (e) { toast(e.message, true); }
}

// Open the Channels browser populated with a user-supplied M3U playlist URL.
async function openChannelsWithCustom(url) {
  revealChannels();
  if (!ch.sourcesLoaded) await loadChannelSources(false);
  if (!ch.sources.some((s) => s.id === url)) ch.sources.unshift({ id: url, name: "Custom playlist", group: "Custom" });
  localStorage.setItem(CHANNEL_SOURCE_KEY, url);
  ch.src = url; ch.group = ""; ch.q = ""; $("#chSearch").value = "";
  renderSourceMenu();
  renderGroupMenu();
  await loadChannels(true);
}

async function loadChannels(reset) {
  if (ch.loading) {
    if (reset) ch.pendingReset = true;
    return;
  }
  ch.loading = true;
  if (reset) { ch.offset = 0; $("#chList").innerHTML = `<div class="ch-empty">Loading channels…</div>`; }
  const request = { src: ch.src, q: ch.q, group: ch.group, offset: ch.offset };
  try {
    const qs = new URLSearchParams({ src: request.src, q: request.q, group: request.group, limit: ch.limit, offset: request.offset });
    const data = await api.get(`/api/catalog/channels?${qs}`);
    if (request.src !== ch.src || request.q !== ch.q || request.group !== ch.group) {
      ch.pendingReset = true;
      return;
    }
    ch.total = data.total;
    // populate group filter once per source load
    if (reset) {
      ch.groups = data.groups;
      renderGroupMenu();
    }
    renderChannels(data.channels, !reset);
    $("#chCount").textContent = `${Math.min(ch.offset + ch.limit, ch.total)} / ${ch.total}`;
    $("#chFoot").hidden = ch.offset + ch.limit >= ch.total;
  } catch (e) {
    $("#chList").innerHTML = `<div class="ch-empty">${esc(e.message)}<br><br>Check the Mac's internet connection.</div>`;
  } finally {
    ch.loading = false;
    if (ch.pendingReset) {
      ch.pendingReset = false;
      loadChannels(true);
    }
  }
}

function renderChannels(channels, append) {
  const list = $("#chList");
  if (!append) list.innerHTML = "";
  if (!channels.length && !append) { list.innerHTML = `<div class="ch-empty">No channels match.</div>`; return; }
  const html = channels.map((c) => {
    const saved = findSavedChannel(c);
    const logo = c.logo
      ? `<img class="logo" src="${esc(c.logo)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'logo placeholder',textContent:'📺'}))" />`
      : `<div class="logo placeholder">📺</div>`;
    const payload = encodeURIComponent(JSON.stringify({
      name: c.name,
      url: c.url,
      group: c.group,
      category: c.category || c.group,
      country: c.country,
      sourceCategory: c.sourceCategory,
      logo: c.logo,
      userAgent: c.userAgent,
      referer: c.referer,
    }));
    return `<div class="ch-row${saved ? " saved" : ""}" data-ch="${payload}">
      ${logo}
      <div class="info"><div class="nm">${esc(c.name)}</div><div class="gp">${esc(c.group)}</div></div>
      <div class="acts">
        <button class="play" type="button" data-act="play" title="Play" aria-label="Play ${esc(c.name)}">▶</button>
        <button class="save-channel${saved ? " saved" : ""}" type="button" data-act="add" title="${saved ? "Saved" : "Save to playlist"}" aria-label="${saved ? "Saved" : "Save"} ${esc(c.name)}${saved ? "" : " to playlist"}" ${saved ? "disabled" : ""}>${saved ? "Saved" : "+"}</button>
      </div>
    </div>`;
  }).join("");
  list.insertAdjacentHTML("beforeend", html);
}

function channelStreamSrc(c) {
  const p = new URLSearchParams({ url: c.url, live: "1", height: $("#ctlHeight").value, fps: $("#ctlFps").value, quality: $("#ctlQuality").value });
  if (c.userAgent) p.set("ua", c.userAgent);
  if (c.referer) p.set("referer", c.referer);
  const a = new URLSearchParams({ url: c.url, live: "1", _: Date.now() });
  if (c.userAgent) a.set("ua", c.userAgent);
  if (c.referer) a.set("referer", c.referer);
  return {
    tsUrl: `/stream/ts/url?${p}`,
    mjpegUrl: `/stream/url?${p}`,
    audioUrl: `/stream/audio/url?${a}`,
  };
}

async function getOrCreateCountryChannelsPlaylist(c) {
  const country = channelCountryMeta(c);
  const countryKey = String(country.countryCode || country.countryName).toLowerCase();
  const playlistName = `${country.countryName} Channels`;
  const meta = { kind: "channel-country", countryCode: country.countryCode, countryName: country.countryName };
  let p = state.playlists.find((x) => (
    x.meta?.kind === "channel-country" &&
    String(x.meta?.countryCode || x.meta?.countryName).toLowerCase() === countryKey
  ));
  if (!p) p = state.playlists.find((x) => x.name.toLowerCase() === playlistName.toLowerCase());
  if (p && p.meta?.kind !== "channel-country") p = await api.patch(`/api/playlists/${p.id}`, { meta });
  if (!p) {
    p = await api.post("/api/playlists", {
      name: playlistName,
      meta,
    });
  }
  return { playlist: p, country };
}

// Channels event wiring
$("#chSourceBtn").onclick = () => toggleChannelMenu("source");
$("#chGroupBtn").onclick = () => toggleChannelMenu("group");
$("#chSourcePanel").onclick = (e) => {
  const opt = e.target.closest(".ch-menu-option");
  if (opt) selectChannelSource(opt.dataset.value);
};
$("#chGroupPanel").onclick = (e) => {
  const opt = e.target.closest(".ch-menu-option");
  if (opt) selectChannelGroup(opt.dataset.value);
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ch-menu")) closeChannelMenus();
});
$("#chMore").onclick = () => { ch.offset += ch.limit; loadChannels(false); };
$("#chOpenSaved").onclick = () => openSavedPlaylist(state.lastSavedPlaylistId);
$("#browseSavedBtn").onclick = () => openSavedPlaylist(state.selectedPlaylistId || state.lastSavedPlaylistId);
$("#closeSavedDrawerBtn").onclick = closePlaylistDrawer;
$("#savedDrawerBackdrop").onclick = closePlaylistDrawer;
let chSearchTimer;
$("#chSearch").addEventListener("input", (e) => {
  clearTimeout(chSearchTimer);
  chSearchTimer = setTimeout(() => { ch.q = e.target.value.trim(); loadChannels(true); }, 350);
});
$("#ytSearchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  performYoutubeSearch();
});
$("#chList").addEventListener("click", async (e) => {
  const row = e.target.closest(".ch-row"); if (!row) return;
  const c = JSON.parse(decodeURIComponent(row.dataset.ch));
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "add") {
    const addBtn = e.target.closest("[data-act='add']");
    const existing = findSavedChannel(c);
    if (existing) {
      setChannelSaveState(row, c);
      state.selectedPlaylistId = existing.playlist.id;
      showSaveFeedback(existing.playlist, channelCategory(c));
      return;
    }
    const originalText = addBtn.textContent;
    const originalTitle = addBtn.title;
    try {
      row.classList.remove("saved");
      row.classList.add("saving");
      addBtn.disabled = true;
      addBtn.classList.add("saving");
      addBtn.textContent = "Saving…";
      addBtn.title = "Saving";
      addBtn.setAttribute("aria-label", `Saving ${c.name}`);
      const { playlist: p, country } = await getOrCreateCountryChannelsPlaylist(c);
      const category = channelCategory(c);
      await api.post(`/api/playlists/${p.id}/items`, {
        type: "m3u8",
        url: c.url,
        title: c.name,
        meta: {
          userAgent: c.userAgent,
          referer: c.referer,
          logo: c.logo,
          group: category,
          category,
          countryCode: country.countryCode,
          countryName: country.countryName,
          source: sourceName(ch.src),
        },
      });
      state.selectedPlaylistId = p.id;
      await loadPlaylists();
      row.classList.remove("saving");
      addBtn.classList.remove("saving");
      setChannelSaveState(row, c);
      showSaveFeedback(p, category);
      toast(`Saved to ${p.name} > ${displayCategory(category)}`);
    } catch (err) {
      row.classList.remove("saving");
      addBtn.classList.remove("saving");
      addBtn.disabled = false;
      addBtn.textContent = originalText;
      addBtn.title = originalTitle;
      addBtn.setAttribute("aria-label", `Save ${c.name} to playlist`);
      toast(err.message, true);
    }
    return;
  }
  // default / play
  state.playingItemId = null;
  state.youtubeSearchPlayingId = null;
  renderItems();
  renderYoutubeSearch();
  showAttemptedUrl(c.url);
  replayFn = () => playStream(channelStreamSrc(c), c.name);
  replayFn();
});

// ---- Event wiring ----
document.querySelectorAll('[data-mode="desktop"], #emptyDesktopBtn').forEach((entry) => {
  entry.hidden = !DESKTOP_FEATURE_VISIBLE;
  if (DESKTOP_FEATURE_VISIBLE) {
    entry.removeAttribute("aria-hidden");
    if ("disabled" in entry) entry.disabled = false;
  } else {
    entry.setAttribute("aria-hidden", "true");
    if ("disabled" in entry) entry.disabled = true;
  }
});
document.querySelectorAll('[data-mode="embed"], #emptyEmbedBtn').forEach((entry) => {
  entry.hidden = !EMBED_FEATURE_VISIBLE;
  if (EMBED_FEATURE_VISIBLE) {
    entry.removeAttribute("aria-hidden");
    if ("disabled" in entry) entry.disabled = false;
  } else {
    entry.setAttribute("aria-hidden", "true");
    if ("disabled" in entry) entry.disabled = true;
  }
});

$("#addPlaylistBtn").onclick = modalNewPlaylist;
$("#addItemBtn").onclick = modalAddItem;
$("#manageSavedBtn").onclick = () => setManageSaved(!state.manageSaved);
$("#ytSearchTab").onclick = () => setBrowseYoutubePanel("search");
$("#ytHistoryTab").onclick = () => setBrowseYoutubePanel("history");
$("#ytHistoryRefreshBtn").onclick = () => loadYoutubeHistory();
$("#ytHistoryClearBtn").onclick = () => clearYoutubeHistory();
document.querySelectorAll(".mode-tab").forEach((tab) => {
  tab.onclick = () => {
    if (tab.dataset.mode === "browse") openChannels();
    else if (tab.dataset.mode === "recommended") openRecommendations();
    else if (tab.dataset.mode === "desktop") openDesktop();
    else if (tab.dataset.mode === "browser") openBrowser();
    else if (tab.dataset.mode === "embed") openEmbed();
    else if (tab.dataset.mode === "library") openLegacyLibrary();
    else if (tab.dataset.mode === "apne") openApneDaily();
    else setMode(tab.dataset.mode);
  };
});
$("#menuToggle").onclick = () => setMobileNavOpen(!$("#modeTabs").classList.contains("open"));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".topbar")) setMobileNavOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#modeTabs").classList.contains("open")) {
    setMobileNavOpen(false);
    $("#menuToggle").focus();
  }
});
$("#emptySavedBtn").onclick = () => openSavedPlaylist(state.selectedPlaylistId || state.lastSavedPlaylistId);
$("#emptyBrowseBtn").onclick = openChannels;
$("#emptyRecsBtn").onclick = openRecommendations;
$("#emptyDesktopBtn").onclick = openDesktop;
$("#emptyBrowserBtn").onclick = openBrowser;
$("#emptyEmbedBtn").onclick = openEmbed;
$("#emptyLibraryBtn").onclick = openLegacyLibrary;
$("#apneDailyRefreshBtn").onclick = () => loadApneDaily();
$("#apneManageShowsBtn").onclick = openApneManageShows;
bindTap($("#apneDailyList"), async (event) => {
  const button = event.target.closest("[data-act]");
  const card = event.target.closest("[data-show-id]");
  if (!button || !card) return;
  if (button.dataset.act === "download") await startApneDailyDownload(card.dataset.showId);
  else if (button.dataset.act === "download-episode") await startApneEpisodeDownload(card.dataset.showId, button.dataset.dateKey);
  else if (button.dataset.act === "play-episode") {
    if (button.dataset.itemId) await playApneDailyItem(button.dataset.itemId);
  } else if (button.dataset.act === "play") {
    const show = state.apneDaily.shows.find((item) => item.id === card.dataset.showId);
    if (show?.itemId) await playApneDailyItem(show.itemId);
  }
});
$("#emptyPasteBtn").onclick = () => {
  // Home hides the idle player, including the URL field.
  setMode("browse");
  setPlayerDropdownOpen(true);
  const input = $("#quickUrl");
  input.focus();
  input.select();
};
$("#desktopHomeBtn").onclick = () => setMode("watch");
$("#desktopRefreshBtn").onclick = () => loadDesktopSources().catch((e) => renderDesktopStatus({ error: e.message }));
$("#desktopStartBtn").onclick = playDesktopStream;
$("#desktopStopBtn").onclick = stopPlayback;
$("#desktopInputToggle").onclick = toggleDesktopInput;
$("#browserHomeBtn").onclick = () => setMode("watch");
$("#browserReloadBtn").onclick = reloadBrowserStream;
$("#browserStartBtn").onclick = () => playRealChromeStream().catch((e) => {
  setBrowserStatus(e.message, "bad");
  toast(e.message, true);
});
$("#browserStopBtn").onclick = stopPlayback;
$("#browserCleanupBtn").onclick = closeRemoteBrowserSessions;
$("#browserTouchToggle").onclick = toggleBrowserInput;
$("#browserSettingsBtn").onclick = toggleBrowserPlayerSettings;
$("#browserClosePopupBtn").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeRealChromePopup().catch(() => {});
};
$("#browserFps").addEventListener("input", () => {
  syncBrowserSettingsControls("main");
  queueBrowserSettingsUpdate();
});
$("#browserQuality").addEventListener("input", () => {
  syncBrowserSettingsControls("main");
  queueBrowserSettingsUpdate();
});
$("#browserViewport").addEventListener("change", () => {
  syncBrowserSettingsControls("main");
  queueBrowserSettingsUpdate({ immediate: true });
});
$("#browserAudioCapture").addEventListener("change", () => {
  setBrowserAudioCapture($("#browserAudioCapture").value);
  syncBrowserSettingsControls("main");
  reapplyBrowserAudioStream({ restreamVideo: true });
});
$("#browserAudio").addEventListener("change", () => {
  syncBrowserSettingsControls("main");
  selectedBrowserAudio();
  reapplyBrowserAudioStream({ restreamVideo: true });
});
$("#browserAudioFormat").addEventListener("click", (e) => handleBrowserAudioFormatClick(e, "main"));
$("#browserAudioQuality").addEventListener("click", (e) => handleBrowserAudioQualityClick(e, "main"));
$("#browserPlayerFps").addEventListener("input", () => {
  syncBrowserSettingsControls("player");
  queueBrowserSettingsUpdate();
});
$("#browserPlayerQuality").addEventListener("input", () => {
  syncBrowserSettingsControls("player");
  queueBrowserSettingsUpdate();
});
$("#browserPlayerViewport").addEventListener("change", () => {
  syncBrowserSettingsControls("player");
  queueBrowserSettingsUpdate({ immediate: true });
});
$("#browserPlayerAudioCapture").addEventListener("change", () => {
  setBrowserAudioCapture($("#browserPlayerAudioCapture").value);
  syncBrowserSettingsControls("player");
  reapplyBrowserAudioStream({ restreamVideo: true });
});
$("#browserPlayerAudio").addEventListener("change", () => {
  syncBrowserSettingsControls("player");
  selectedBrowserAudio();
  reapplyBrowserAudioStream({ restreamVideo: true });
});
$("#browserPlayerAudioFormat").addEventListener("click", (e) => handleBrowserAudioFormatClick(e, "player"));
$("#browserPlayerAudioQuality").addEventListener("click", (e) => handleBrowserAudioQualityClick(e, "player"));
$("#browserHistoryList").onclick = handleBrowserHistoryClick;
$("#browserHistoryClearBtn").onclick = clearBrowserHistory;
$("#browserSessionList").onclick = closeBrowserSessionFromList;
$("#browserPlayerHistoryList")?.addEventListener("click", handleBrowserHistoryClick);
$("#browserPlayerHistoryClearBtn")?.addEventListener("click", clearBrowserHistory);
$("#browserUrl").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  playRealChromeStream().catch((err) => {
    setBrowserStatus(err.message, "bad");
    toast(err.message, true);
  });
});
$("#embedHomeBtn").onclick = () => setMode("watch");
$("#embedLoadBtn").onclick = loadEmbedFromInput;
$("#embedSaveBtn").onclick = saveEmbedFromInput;
$("#embedSavedList").onclick = handleSavedEmbedClick;
$("#embedClearBtn").onclick = () => {
  $("#embedCodeInput").value = "";
  $("#embedStatus").textContent = "";
  stopPlayback();
  setMode("embed");
  $("#embedCodeInput").focus();
};
$("#embedCodeInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  loadEmbedFromInput();
});
$("#playerHomeBtn").onclick = () => setMode("watch");
$("#playerDropdownBtn").onclick = () => setPlayerDropdownOpen($(".player")?.classList.contains("player-collapsed"));
$("#desktopInputBtn").onclick = toggleDesktopInput;
$("#browserInputBtn").onclick = toggleBrowserInput;
$("#browserKeyboardInput").addEventListener("input", syncBrowserKeyboardText);
$("#browserKeyboardInput").addEventListener("keydown", (e) => {
  if (!browserInputActiveForScreen()) return;
  if (e.key === "Enter") {
    e.preventDefault();
    syncBrowserKeyboardText();
    void postBrowserInput({ type: "key", key: "Enter" });
    hideBrowserKeyboard({ blur: true });
  } else if (e.key === "Escape") {
    e.preventDefault();
    void postBrowserInput({ type: "key", key: "Escape" });
    hideBrowserKeyboard({ blur: true });
  }
});
$("#browserKeyboardInput").addEventListener("blur", () => {
  if (!browserStreamActive) hideBrowserKeyboard({ blur: false });
});
$("#desktopZoomOutBtn").onclick = () => setDesktopZoom(desktopZoom.scale - DESKTOP_ZOOM_STEP);
$("#desktopZoomResetBtn").onclick = resetDesktopZoom;
$("#desktopZoomInBtn").onclick = () => setDesktopZoom(desktopZoom.scale + DESKTOP_ZOOM_STEP);
document.querySelectorAll("[data-desktop-preset]").forEach((btn) => {
  btn.onclick = () => applyDesktopPreset(btn.dataset.desktopPreset);
});
["#desktopHeight", "#desktopFps", "#desktopQuality", "#desktopAudio"].forEach((sel) => {
  $(sel).addEventListener("change", reapplyDesktopControls);
  $(sel).addEventListener("input", reapplyDesktopControls);
});
$("#streamSettingsBtn").onclick = () => {
  const panel = $("#streamSettingsPanel");
  const nextOpen = panel.hidden;
  panel.hidden = !nextOpen;
  $("#streamSettingsBtn").setAttribute("aria-expanded", nextOpen ? "true" : "false");
};
function handleStreamProfileClick(e) {
  const btn = e.target.closest("[data-stream-profile]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  requestQualityProfile(btn.dataset.streamProfile);
}

$("#qualityQuick").addEventListener("click", handleStreamProfileClick);
$("#playerQualityPresets").addEventListener("click", handleStreamProfileClick);
$("#heightOptions").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-height]");
  if (!btn || $("#ctlHeight").value === btn.dataset.height) return;
  $("#ctlHeight").value = btn.dataset.height;
  reapplyControls();
});
$("#qualityOptions").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-quality-value]");
  if (!btn || $("#ctlQuality").value === btn.dataset.qualityValue) return;
  $("#ctlQuality").value = btn.dataset.qualityValue;
  reapplyControls();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.downloadsDrawerOpen) setDownloadsDrawerOpen(false);
  else if (state.savedDrawerOpen) closePlaylistDrawer();
  else if (state.mode !== "watch") setPlayerDropdownOpen(true);
});
$("#restartMenuBtn").onclick = openRestartChooser;
$("#stopBtn").onclick = stopPlayback;
$("#autoplayBtn").onclick = () => setAutoplayEnabled(!autoplayEnabled);
$("#restreamBtn").onclick = restreamPlayback;
$("#fullscreenBtn").onclick = toggleScreenFullscreen;
$("#streamRetryBtn").onclick = () => {
  if (!replayFn) return;
  toast("Retrying stream");
  replayFn(streamSeek.seekable ? streamReplayTime() : undefined);
};
$("#streamLowerBtn").onclick = () => {
  if (!replayFn) return;
  lowerPlaybackSettings();
  toast("Retrying at " + currentSettingsLabel());
  replayFn(streamSeek.seekable ? streamReplayTime() : undefined);
};
$("#slowBufferApplyBtn").onclick = applySlowBufferSuggestion;
$("#slowBufferDismissBtn").onclick = () => {
  reportPlaybackEvent("slow_buffer_suggestion_dismissed", { streamUrl: activeCompat?.mjpegUrl || "", stats: activeCompat?.bufferedPlayer?.getStats?.() });
  hideSlowBufferSuggestion();
};
$("#slowBufferStopBtn").onclick = stopSlowBufferSuggestions;
$("#legacyRefreshBtn").onclick = async () => {
  try {
    await loadLegacyLibrary();
    await loadLegacyPlaylists();
  } catch (e) {
    toast(e.message, true);
  }
};
$("#openDownloadsDrawerBtn").onclick = async () => {
  try {
    await loadPlaylists();
    await loadLegacyLibrary();
  } catch (e) {
    toast(e.message, true);
  }
  setDownloadsDrawerOpen(true);
};
$("#closeDownloadsDrawerBtn").onclick = () => setDownloadsDrawerOpen(false);
$("#downloadsDrawerBackdrop").onclick = () => setDownloadsDrawerOpen(false);
$("#legacyProbeBtn").onclick = probeLegacyFormats;
$("#legacyDownloadBtn").onclick = startLegacyDownload;
$("#legacyPlaylistSelect").onchange = async (e) => {
  state.selectedLegacyPlaylistId = e.target.value;
  renderLegacyPlaylists();
  await loadSelectedLegacyPlaylistVideos();
};
$("#legacyAddPlaylistBtn").onclick = async () => {
  const url = prompt("YouTube playlist URL:");
  if (!url) return;
  try {
    const playlist = await api.post("/api/legacy-library/playlists", { url });
    state.selectedLegacyPlaylistId = playlist.id;
    await loadLegacyPlaylists();
    toast("Playlist added");
  } catch (e) {
    toast(e.message, true);
  }
};
$("#legacyDeletePlaylistBtn").onclick = async () => {
  const playlist = selectedLegacyPlaylist();
  if (!playlist || playlist.builtin) return;
  if (!confirm(`Delete playlist "${playlist.name || playlist.url}"?`)) return;
  try {
    await api.del(`/api/legacy-library/playlists/${encodeURIComponent(playlist.id)}`);
    state.selectedLegacyPlaylistId = null;
    await loadLegacyPlaylists();
    toast("Playlist deleted");
  } catch (e) {
    toast(e.message, true);
  }
};
$("#ytConnectBtn").onclick = connectYoutube;
async function copyYoutubePairingUrl(inputSelector) {
  const input = $(inputSelector);
  if (!input) return;
  input.value = youtubeAuthStartUrl();
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    toast("Authorization link copied");
  } catch {
    toast("Select and copy the link", true);
  }
}
function openYoutubePairingHere() {
  location.href = youtubeAuthStartUrl();
}
function cancelYoutubePairing() {
  stopYoutubePairingPoll();
  setYoutubePairingVisible(false);
  renderYoutubeAuth();
}
$("#ytCopyPairingBtn").onclick = () => copyYoutubePairingUrl("#ytPairingUrl");
$("#ytOpenPairingBtn").onclick = openYoutubePairingHere;
$("#ytCancelPairingBtn").onclick = cancelYoutubePairing;
$("#ytDisconnectBtn").onclick = disconnectYoutube;
$("#ytRefreshBtn").onclick = loadRecommendations;
$("#ytCategoryBtn").onclick = toggleRecommendationCategoryMenu;
$("#ytCategoryPanel").onclick = (e) => {
  const opt = e.target.closest(".ch-menu-option");
  if (opt) selectRecommendationCategory(opt.dataset.value);
};
document.addEventListener("click", (e) => {
  if (!e.target.closest("#ytCategoryMenu")) closeRecommendationCategoryMenu();
});
$("#ytMoreRecommendations").onclick = () => {
  state.recommendationVisibleCount += RECOMMENDATION_PAGE_SIZE;
  renderRecommendations();
};
window.addEventListener("message", async (event) => {
  if (event.origin !== location.origin || event.data?.type !== "ytstreamer-youtube-connected") return;
  await loadYoutubeAuthStatus().catch(() => {});
  if (state.youtubeAuth?.connected) await loadRecommendations();
});
$("#streamBackBtn").onclick = () => seekStreamTo(getStreamCurrentTime() - 10);
$("#streamForwardBtn").onclick = () => seekStreamTo(getStreamCurrentTime() + 10);
$("#streamSeekTrack").addEventListener("pointerdown", (e) => {
  if (!streamSeek.seekable) return;
  e.preventDefault();
  e.stopPropagation();
  beginScreenControlInteraction();
  clearInterval(streamSeek.timer);
  const seek = (clientX) => {
    const rect = $("#streamSeekTrack").getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    updateStreamSeekUi(pos * streamSeek.duration);
    return pos * streamSeek.duration;
  };
  let target = seek(e.clientX);
  const move = (ev) => { target = seek(ev.clientX); };
  const finish = (commit) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    if (commit) seekStreamTo(target);
    endScreenControlInteraction();
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
});
$("#streamSeekTrack").addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); seekStreamTo(getStreamCurrentTime() - 10); }
  if (e.key === "ArrowRight") { e.preventDefault(); seekStreamTo(getStreamCurrentTime() + 10); }
});
const videoControlsOverlay = $("#videoControlsOverlay");
videoControlsOverlay.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  beginScreenControlInteraction();
});
videoControlsOverlay.addEventListener("pointerup", (e) => {
  if (!e.target.closest(".stream-seek-track")) endScreenControlInteraction();
});
videoControlsOverlay.addEventListener("pointercancel", endScreenControlInteraction);
videoControlsOverlay.addEventListener("focusin", beginScreenControlInteraction);
videoControlsOverlay.addEventListener("focusout", () => {
  requestAnimationFrame(() => {
    if (!videoControlsOverlay.contains(document.activeElement)) endScreenControlInteraction();
  });
});
$("#muteBtn").onclick = () => {
  const a = $("#audio");
  const bufferedPlayer = activeCompat?.bufferedPlayer;
  if (bufferedPlayer) {
    if (!playbackPaused && soundOn && activeCompat?.audioUrl && bufferedPlayer.getStats?.().state === "autoplay-blocked") {
      bufferedPlayer.retryFromGesture();
      return;
    }
    const resumeAt = getStreamCurrentTime();
    const localTime = bufferedPlayer.currentTime();
    soundOn = !soundOn;
    renderMuteButton();
    a.muted = !soundOn;
    if (!soundOn) {
      bufferedPlayer.setAudioDisabled(true, localTime);
      return;
    }
    if (!playbackPaused && replayFn) {
      const result = replayFn(resumeAt);
      if (result?.catch) result.catch((error) => toast(error.message, true));
    }
    return;
  }
  if (!playbackPaused && soundOn && activeCompat?.audioUrl && a.paused) {
    startCompatAudio(true);
    return;
  }
  soundOn = !soundOn;
  renderMuteButton();
  const v = $("#video");
  v.muted = !soundOn;
  a.muted = !soundOn;
  if (!soundOn) {
    try { a.pause(); } catch {}
    destroyBrowserPcmAudio();
    a.removeAttribute("src");
    try { a.load(); } catch {}
  }
  if (soundOn && !playbackPaused) v.play().catch(() => {});
  if (soundOn && !playbackPaused && activeCompat?.audioUrl) startCompatAudio(true);
};
$("#pauseBtn").onclick = togglePlaybackPause;

bindTap($("#playlistList"), async (e) => {
  const li = e.target.closest("li"); if (!li) return;
  const id = li.dataset.id;
  if (!id) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  const p = state.playlists.find((x) => x.id === id);
  if (act === "rename") return modalRename(p);
  if (act === "delPlaylist") {
    if (!confirm(`Delete playlist “${p.name}” and its ${p.items.length} items?`)) return;
    try { await api.del(`/api/playlists/${id}`); if (state.selectedPlaylistId === id) state.selectedPlaylistId = null; await loadPlaylists(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  selectPlaylist(id);
});

bindTap($("#itemList"), async (e) => {
  const li = e.target.closest("li"); if (!li) return;
  const id = li.dataset.id;
  if (!id) return;
  const p = currentPlaylist(); if (!p) return;
  const item = p.items.find((i) => i.id === id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "delItem") {
    try { await api.del(`/api/playlists/${p.id}/items/${id}`); if (state.playingItemId === id) stopPlayback(); await loadPlaylists(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (item) {
    closePlaylistDrawer();
    if (isMobileMode()) setPlayerDropdownOpen(true);
    playItem(item);
  }
});

bindTap($("#legacyList"), async (e) => {
  const row = e.target.closest(".legacy-item");
  if (!row) return;
  const localId = row.dataset.localId;
  if (localId) {
    const item = downloadedLocalItems().find((entry) => entry.id === localId);
    if (!item) return;
    setDownloadsDrawerOpen(false);
    await playItem(item);
    return;
  }
  const item = state.legacyItems.find((x) => x.id === row.dataset.id);
  if (!item) return;
  const act = e.target.closest("[data-act]")?.dataset.act || "play";
  if (act === "delete") {
    if (!confirm(`Delete "${item.title}" from the processed library?`)) return;
    try {
      await api.del(`/api/legacy-library/${encodeURIComponent(item.id)}`);
      if (state.legacyPlayingId === item.id) stopPlayback();
      await loadLegacyLibrary();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  playLegacyItem(item);
});

bindTap($("#legacyPlaylistVideos"), async (e) => {
  const row = e.target.closest(".legacy-playlist-row");
  if (!row) return;
  const video = state.legacyPlaylistVideos.find((entry) => entry.id === row.dataset.videoId);
  if (!video) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "stream-video") {
    await streamLegacyPlaylistVideo(video);
    return;
  }
  if (act === "download-video") {
    await startLegacyDownloadForUrl(video.url);
  }
});

bindTap($("#ytRecommendationList"), async (e) => {
  const row = e.target.closest(".recommendation-row");
  if (!row) return;
  const item = state.recommendations.find((entry) => entry.id === row.dataset.videoId);
  if (!item) return;
  const act = e.target.closest("[data-act]")?.dataset.act || "stream-rec";
  if (act === "download-rec") {
    await downloadRecommendation(item);
    return;
  }
  await streamRecommendation(item);
});

bindTap($("#ytSearchResults"), async (e) => {
  const row = e.target.closest(".yt-search-row");
  if (!row) return;
  const item = state.youtubeSearchResults.find((entry) => entry.id === row.dataset.videoId);
  if (!item) return;
  const act = e.target.closest("[data-act]")?.dataset.act || "stream-search";
  if (act === "download-search") {
    await downloadYoutubeSearchResult(item);
    return;
  }
  await streamYoutubeSearchResult(item);
});

bindTap($("#ytHistoryResults"), async (e) => {
  const row = e.target.closest(".yt-search-row");
  if (!row) return;
  const item = state.youtubeHistory.find((entry) => entry.id === row.dataset.videoId);
  if (!item) return;
  const act = e.target.closest("[data-act]")?.dataset.act || "stream-history";
  if (act === "download-history") {
    await downloadYoutubeSearchResult(item);
    return;
  }
  if (act === "remove-history") {
    await removeYoutubeHistoryItem(item);
    return;
  }
  await streamYoutubeHistoryItem(item);
});

function desktopInputActiveForScreen() {
  return Boolean(desktopStreamActive && desktopInputActive && desktopInputReady());
}

function browserInputActiveForScreen() {
  return Boolean(browserStreamActive && browserInputActive && browserSessionId);
}

function activeScreenMediaElement() {
  const screen = $("#screen");
  if (screen.classList.contains("video-mode")) return $("#video");
  if (screen.classList.contains("mjpeg-mode")) return $("#mjpeg");
  if (screen.classList.contains("mjpeg-buffered-mode")) return $("#mjpegCanvas");
  return null;
}

function desktopInputPointFromClient(clientX, clientY) {
  const { left, top, width, height } = desktopMediaVisualRect();

  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - left) / width)),
    y: Math.max(0, Math.min(1, (clientY - top) / height)),
  };
}

function desktopInputButton(e) {
  return e.button === 2 ? 2 : 1;
}

function sendDesktopPointer(type, e) {
  const point = desktopInputPointFromClient(e.clientX, e.clientY);
  if (!point) return false;
  void postDesktopInput({ type, ...point, button: desktopInputButton(e) });
  return true;
}

function handleDesktopInputPointerDown(e) {
  if (!desktopInputActiveForScreen()) return false;
  if (e.target.closest("button, input, select, textarea, a")) return false;
  if (e.pointerType === "mouse" && typeof e.button === "number" && e.button > 2) return false;
  if (!sendDesktopPointer("down", e)) return false;
  desktopInputPointerId = e.pointerId;
  desktopInputLastMoveAt = 0;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopInputPointerMove(e) {
  if (!desktopInputActiveForScreen() || desktopInputPointerId !== e.pointerId) return false;
  const now = performance.now();
  if (now - desktopInputLastMoveAt < 45) return true;
  desktopInputLastMoveAt = now;
  sendDesktopPointer("drag", e);
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopInputPointerUp(e) {
  if (!desktopInputActiveForScreen() || desktopInputPointerId !== e.pointerId) return false;
  sendDesktopPointer("up", e);
  desktopInputPointerId = null;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopInputWheel(e) {
  if (!desktopInputActiveForScreen()) return false;
  const point = desktopInputPointFromClient(e.clientX, e.clientY);
  if (!point) return false;
  void postDesktopInput({
    type: "scroll",
    ...point,
    dx: Math.max(-600, Math.min(600, -e.deltaX)),
    dy: Math.max(-600, Math.min(600, -e.deltaY)),
  });
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function browserMediaBaseRect() {
  const screen = $("#screen");
  const rect = screen.getBoundingClientRect();
  const media = activeScreenMediaElement();
  const mediaW = media?.naturalWidth || browserViewport.width || 16;
  const mediaH = media?.naturalHeight || browserViewport.height || 9;
  const mediaAspect = mediaW > 0 && mediaH > 0 ? mediaW / mediaH : 16 / 9;
  const screenAspect = rect.width / rect.height;
  let left = rect.left;
  let top = rect.top;
  let width = rect.width;
  let height = rect.height;
  if (mediaAspect > screenAspect) {
    height = width / mediaAspect;
    top = rect.top + ((rect.height - height) / 2);
  } else {
    width = height * mediaAspect;
    left = rect.left + ((rect.width - width) / 2);
  }
  return { left, top, width, height };
}

function browserMediaRect() {
  const base = browserMediaBaseRect();
  const rect = $("#screen").getBoundingClientRect();
  const cx = rect.left + (rect.width / 2);
  const cy = rect.top + (rect.height / 2);
  const scale = browserStreamActive ? browserZoom.scale : 1;
  return {
    left: cx + browserZoom.panX + (scale * (base.left - cx)),
    top: cy + browserZoom.panY + (scale * (base.top - cy)),
    width: base.width * scale,
    height: base.height * scale,
  };
}

function browserInputPointFromClient(clientX, clientY) {
  const { left, top, width, height } = browserMediaRect();
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - left) / width)),
    y: Math.max(0, Math.min(1, (clientY - top) / height)),
  };
}

function browserInputPointOrCenter(clientX, clientY) {
  return browserInputPointFromClient(clientX, clientY) || { x: 0.5, y: 0.5 };
}

function sendBrowserPointer(type, e) {
  const point = browserInputPointFromClient(e.clientX, e.clientY);
  if (!point) return false;
  const result = postBrowserInput({ type, ...point, button: desktopInputButton(e), pointerType: e.pointerType || "" });
  if (type === "tap") {
    result?.then?.((response) => {
      if (response?.download?.submitted) {
        toast("Preparing download on Mac…");
        hideBrowserKeyboard();
        return;
      }
      queueBrowserKeyboardFocus();
    }).catch(() => hideBrowserKeyboard());
  }
  return true;
}

function sendBrowserScrollFromClient(clientX, clientY, dx, dy) {
  void postBrowserInput({
    type: "scroll",
    ...browserInputPointOrCenter(clientX, clientY),
    dx: Math.max(-1200, Math.min(1200, dx)),
    dy: Math.max(-1200, Math.min(1200, dy)),
  });
}

function browserTouchPointers() {
  return Array.from(browserZoom.pointers.values());
}

function browserTouchDistance(points = browserTouchPointers()) {
  if (points.length < 2) return 0;
  return Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY);
}

function browserTouchCenter(points = browserTouchPointers()) {
  if (points.length < 2) return null;
  return {
    x: (points[0].clientX + points[1].clientX) / 2,
    y: (points[0].clientY + points[1].clientY) / 2,
  };
}

function beginBrowserPinch() {
  const points = browserTouchPointers();
  if (points.length < 2) return false;
  const center = browserTouchCenter(points);
  browserZoom.pinching = true;
  browserZoom.pinchStartDistance = Math.max(1, browserTouchDistance(points));
  browserZoom.pinchStartScale = browserZoom.scale;
  browserZoom.pinchLastCenterX = center.x;
  browserZoom.pinchLastCenterY = center.y;
  browserInputPointerId = null;
  browserInputTouchMoved = true;
  return true;
}

function updateBrowserPinch() {
  if (!browserZoom.pinching || browserZoom.pointers.size < 2) return false;
  const points = browserTouchPointers();
  const center = browserTouchCenter(points);
  const distance = Math.max(1, browserTouchDistance(points));
  const nextScale = browserZoom.pinchStartScale * (distance / browserZoom.pinchStartDistance);
  setBrowserZoom(nextScale, { anchorX: center.x, anchorY: center.y });
  panBrowserZoom(center.x - browserZoom.pinchLastCenterX, center.y - browserZoom.pinchLastCenterY);
  browserZoom.pinchLastCenterX = center.x;
  browserZoom.pinchLastCenterY = center.y;
  return true;
}

function handleBrowserInputPointerDown(e) {
  if (!browserInputActiveForScreen()) return false;
  if (e.target.closest("button, input, select, textarea, a")) return false;
  if (e.pointerType === "mouse" && typeof e.button === "number" && e.button > 2) return false;
  if (e.pointerType !== "mouse") {
    if (!browserInputPointFromClient(e.clientX, e.clientY)) return false;
    browserZoom.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (browserZoom.pointers.size >= 2) {
      beginBrowserPinch();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
  }
  if (!browserInputPointFromClient(e.clientX, e.clientY)) return false;
  browserInputPointerId = e.pointerId;
  browserInputLastMoveAt = 0;
  browserInputStartX = e.clientX;
  browserInputStartY = e.clientY;
  browserInputLastX = e.clientX;
  browserInputLastY = e.clientY;
  browserInputTouchScroll = e.pointerType !== "mouse";
  browserInputTouchMoved = false;
  if (!browserInputTouchScroll) sendBrowserPointer("down", e);
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleBrowserInputPointerMove(e) {
  if (!browserInputActiveForScreen()) return false;
  if (browserZoom.pointers.has(e.pointerId)) {
    browserZoom.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
  }
  if (browserZoom.pinching || browserZoom.pointers.size >= 2) {
    updateBrowserPinch();
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if (browserInputPointerId !== e.pointerId) return false;
  const now = performance.now();
  const totalDx = e.clientX - browserInputStartX;
  const totalDy = e.clientY - browserInputStartY;
  if (browserInputTouchScroll && Math.hypot(totalDx, totalDy) > 8) {
    browserInputTouchMoved = true;
    if (now - browserInputLastMoveAt < 35) return true;
    browserInputLastMoveAt = now;
    const dx = browserInputLastX - e.clientX;
    const dy = browserInputLastY - e.clientY;
    browserInputLastX = e.clientX;
    browserInputLastY = e.clientY;
    sendBrowserScrollFromClient(e.clientX, e.clientY, dx * 1.8, dy * 1.8);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if (now - browserInputLastMoveAt < 45) return true;
  browserInputLastMoveAt = now;
  sendBrowserPointer("drag", e);
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleBrowserInputPointerUp(e) {
  if (!browserInputActiveForScreen()) return false;
  const wasPinching = browserZoom.pinching || browserZoom.pointers.size > 1;
  if (browserZoom.pointers.has(e.pointerId)) browserZoom.pointers.delete(e.pointerId);
  if (wasPinching) {
    if (browserZoom.pointers.size < 2) browserZoom.pinching = false;
    browserInputPointerId = null;
    browserInputTouchScroll = false;
    browserInputTouchMoved = true;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if (browserInputPointerId !== e.pointerId) return false;
  if (browserInputTouchScroll) {
    if (!browserInputTouchMoved) sendBrowserPointer("tap", e);
  } else {
    sendBrowserPointer("up", e);
  }
  browserInputPointerId = null;
  browserInputTouchScroll = false;
  browserInputTouchMoved = false;
  browserFullscreenTapAt = 0;
  browserFullscreenTapX = e.clientX;
  browserFullscreenTapY = e.clientY;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleBrowserInputWheel(e) {
  if (!browserInputActiveForScreen()) return false;
  sendBrowserScrollFromClient(e.clientX, e.clientY, e.deltaX, e.deltaY);
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleBrowserZoomWheel(e) {
  if (!browserInputActiveForScreen()) return false;
  if (!e.ctrlKey && !e.metaKey) return false;
  const direction = e.deltaY > 0 ? -1 : 1;
  setBrowserZoom(browserZoom.scale + (direction * BROWSER_ZOOM_STEP), {
    anchorX: e.clientX,
    anchorY: e.clientY,
  });
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopZoomWheel(e) {
  if (!desktopStreamActive || desktopInputActiveForScreen()) return false;
  if (!e.ctrlKey && !e.metaKey) return false;
  const direction = e.deltaY > 0 ? -1 : 1;
  setDesktopZoom(desktopZoom.scale + (direction * DESKTOP_ZOOM_STEP), {
    anchorX: e.clientX,
    anchorY: e.clientY,
  });
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopPanPointerDown(e) {
  if (!desktopStreamActive || desktopInputActiveForScreen() || desktopZoom.scale <= 1) return false;
  if (e.target.closest("button, input, select, textarea, a")) return false;
  if (e.pointerType === "mouse" && typeof e.button === "number" && e.button > 0) return false;
  desktopZoom.panPointerId = e.pointerId;
  desktopZoom.panLastX = e.clientX;
  desktopZoom.panLastY = e.clientY;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  e.currentTarget.classList.add("desktop-panning");
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopPanPointerMove(e) {
  if (desktopZoom.panPointerId !== e.pointerId) return false;
  panDesktopZoom(e.clientX - desktopZoom.panLastX, e.clientY - desktopZoom.panLastY);
  desktopZoom.panLastX = e.clientX;
  desktopZoom.panLastY = e.clientY;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function handleDesktopPanPointerUp(e) {
  if (desktopZoom.panPointerId !== e.pointerId) return false;
  desktopZoom.panPointerId = null;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  e.currentTarget.classList.remove("desktop-panning");
  e.preventDefault();
  e.stopPropagation();
  return true;
}

{
  const screen = $("#screen");
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let singleTapTimer = null;
  let ignoreDblClickUntil = 0;
  let fullscreenTapRevealOnly = false;
  let controlsRevealOnlyUntil = 0;

  function canTogglePlaybackFromTap(target) {
    if (!screen.classList.contains("playing") || screen.classList.contains("embed-mode")) return false;
    if ($("#pauseBtn")?.disabled) return false;
    return !target?.closest("button, input, select, textarea, a, .stream-notice, .video-controls-overlay");
  }

  function handleTap(x, y, target) {
    if (!canTogglePlaybackFromTap(target)) return false;
    const now = Date.now();
    const moved = Math.hypot(x - lastTapX, y - lastTapY) > 40;
    if (now - lastTapAt < 350 && !moved) {
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
      lastTapAt = 0;
      ignoreDblClickUntil = now + 500;
      toggleScreenFullscreen();
      return true;
    }
    lastTapAt = now;
    lastTapX = x;
    lastTapY = y;
    clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(() => {
      singleTapTimer = null;
      lastTapAt = 0;
      if (canTogglePlaybackFromTap(target)) togglePlaybackPause();
    }, 350);
    return false;
  }

  if (window.PointerEvent) {
    screen.addEventListener("pointerdown", (e) => {
      retryBufferedAudioFromGesture();
      fullscreenTapRevealOnly = canAutoHideScreenOverlays()
        && (document.body.classList.contains("fullscreen-controls-idle") || Date.now() < controlsRevealOnlyUntil)
        && !desktopInputActiveForScreen()
        && !browserInputActiveForScreen()
        && !e.target?.closest("button, input, select, textarea, a, .video-controls-overlay");
      if (fullscreenTapRevealOnly) controlsRevealOnlyUntil = 0;
      if (screen.classList.contains("playing") || isScreenFullscreen()) showFullscreenOverlays();
    });
    screen.addEventListener("pointerdown", handleDesktopInputPointerDown);
    screen.addEventListener("pointerdown", handleBrowserInputPointerDown);
    screen.addEventListener("pointerdown", handleDesktopPanPointerDown);
    screen.addEventListener("pointermove", (e) => {
      if (screen.classList.contains("playing") && e.pointerType === "mouse") {
        const controlsWereIdle = document.body.classList.contains("fullscreen-controls-idle");
        showFullscreenOverlays({ withProgress: false });
        if (controlsWereIdle) controlsRevealOnlyUntil = Date.now() + 500;
      }
    });
    screen.addEventListener("pointermove", handleDesktopInputPointerMove);
    screen.addEventListener("pointermove", handleBrowserInputPointerMove);
    screen.addEventListener("pointermove", handleDesktopPanPointerMove);
    screen.addEventListener("pointercancel", (e) => {
      fullscreenTapRevealOnly = false;
      handleDesktopInputPointerUp(e);
      handleBrowserInputPointerUp(e);
    });
    screen.addEventListener("pointercancel", handleDesktopPanPointerUp);
    screen.addEventListener("pointerup", (e) => {
      if (handleDesktopInputPointerUp(e)) return;
      if (handleBrowserInputPointerUp(e)) return;
      if (handleDesktopPanPointerUp(e)) return;
      if (desktopInputActiveForScreen() || browserInputActiveForScreen()) return;
      if (typeof e.button === "number" && e.button > 0) return;
      if (fullscreenTapRevealOnly) {
        fullscreenTapRevealOnly = false;
        e.preventDefault();
        return;
      }
      if (handleTap(e.clientX, e.clientY, e.target)) e.preventDefault();
    });
  } else {
    screen.addEventListener("touchstart", (e) => {
      retryBufferedAudioFromGesture();
      fullscreenTapRevealOnly = canAutoHideScreenOverlays()
        && document.body.classList.contains("fullscreen-controls-idle")
        && !desktopInputActiveForScreen()
        && !browserInputActiveForScreen()
        && !e.target?.closest("button, input, select, textarea, a, .video-controls-overlay");
      if (screen.classList.contains("playing") || isScreenFullscreen()) showFullscreenOverlays();
    }, { passive: true });
    screen.addEventListener("touchend", (e) => {
      if (desktopInputActiveForScreen() || browserInputActiveForScreen()) return;
      if (fullscreenTapRevealOnly) {
        fullscreenTapRevealOnly = false;
        e.preventDefault();
        return;
      }
      const touch = e.changedTouches?.[0];
      if (touch && handleTap(touch.clientX, touch.clientY, e.target)) e.preventDefault();
    }, { passive: false });
  }

  screen.addEventListener("wheel", (e) => {
    if (handleDesktopZoomWheel(e)) return;
    if (handleBrowserZoomWheel(e)) return;
    if (handleBrowserInputWheel(e)) return;
    handleDesktopInputWheel(e);
  }, { passive: false });
  screen.addEventListener("dblclick", (e) => {
    if (desktopInputActiveForScreen() || browserInputActiveForScreen()) return;
    if (e.target.closest(".video-controls-overlay")) return;
    if (Date.now() < ignoreDblClickUntil) return;
    e.preventDefault();
    toggleScreenFullscreen();
  });
  document.addEventListener("fullscreenchange", () => { setSyntheticFullscreen(false); updateFullscreenButton(); renderDesktopZoomUi(); renderBrowserZoomUi(); });
  document.addEventListener("webkitfullscreenchange", () => { setSyntheticFullscreen(false); updateFullscreenButton(); renderDesktopZoomUi(); renderBrowserZoomUi(); });
}

$("#quickPlayBtn").onclick = async () => {
  const url = $("#quickUrl").value.trim();
  if (!url) return toast("Paste a URL first", true);
  showAttemptedUrl(url);

  // YouTube -> play directly.
  if (/youtube\.com|youtu\.be/.test(url)) {
    const ytBtn = $("#quickPlayBtn");
    let info = null;
    ytBtn.disabled = true; ytBtn.textContent = "...";
    try {
      info = await api.get(`/api/youtube/info?url=${encodeURIComponent(url)}`);
    } catch (e) {
      console.warn("youtube info failed, streaming without seek metadata:", e.message);
    } finally {
      ytBtn.disabled = false; ytBtn.textContent = "Go";
    }
    state.playingItemId = null;
    state.legacyPlayingId = null;
    state.recommendedPlayingId = null;
    state.youtubeSearchPlayingId = null;
    state.youtubeHistoryPlayingId = null;
    renderItems();
    renderLegacyLibrary();
    renderRecommendations();
    renderYoutubeSearch();
    renderYoutubeHistory();
    replayFn = (startAt = 0) => {
      const q = streamQuery(startAt);
      const u = encodeURIComponent(url);
      playStream({
        tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
        mjpegUrl: `/stream/youtube?url=${u}&${q}`,
        audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
      }, info?.title || "YouTube", {
        seekable: !info?.isLive,
        isLive: Boolean(info?.isLive),
        bufferedMjpeg: !info?.isLive,
        duration: info?.duration,
        startAt,
      });
    };
    replayFn(0);
    void recordWatchHistory({
      id: info?.id,
      url: info?.webpage_url || url,
      title: info?.title || "YouTube",
      thumbnail: info?.thumbnail,
      channelTitle: info?.uploader,
      duration: info?.duration,
      isLive: info?.isLive,
    }, "pasted-url");
    return;
  }

  if (/\.m3u8(?:[?#]|$)/i.test(url)) {
    state.playingItemId = null; renderItems();
    replayFn = () => {
      const q = streamQuery();
      const u = encodeURIComponent(url);
      playStream({
        tsUrl: `/stream/ts/url?url=${u}&live=1&${q}`,
        mjpegUrl: `/stream/url?url=${u}&live=1&${q}`,
        audioUrl: `/stream/audio/url?url=${u}&live=1&_=${Date.now()}`,
      }, "Live URL", { seekable: false, isLive: true });
    };
    return replayFn();
  }

  // Otherwise inspect: a multi-channel playlist opens the browser; a single stream plays.
  const btn = $("#quickPlayBtn");
  btn.disabled = true; btn.textContent = "…";
  try {
    const info = await api.get(`/api/catalog/inspect?url=${encodeURIComponent(url)}`);
    if (info.type === "channels") {
      toast(`Playlist with ${info.total} channels`);
      await openChannelsWithCustom(url);
      return;
    }
  } catch (e) {
    // If inspection fails (e.g. CORS/host quirk), fall back to treating it as a direct stream.
    console.warn("inspect failed, playing as direct stream:", e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Go";
  }
  state.playingItemId = null; renderItems();
  replayFn = () => {
    const q = streamQuery();
    const u = encodeURIComponent(url);
    playStream({
      tsUrl: `/stream/ts/url?url=${u}&live=1&${q}`,
      mjpegUrl: `/stream/url?url=${u}&live=1&${q}`,
      audioUrl: `/stream/audio/url?url=${u}&live=1&_=${Date.now()}`,
    }, "Live URL", { seekable: false, isLive: true });
  };
  replayFn();
};

["#ctlHeight", "#ctlQuality"].forEach((sel) => {
  $(sel).addEventListener("change", reapplyControls);
  $(sel).addEventListener("input", reapplyControls);
});
["change", "input", "blur"].forEach((eventName) => $("#ctlFps").addEventListener(eventName, reapplyControls));
$("#ctlFpsPresets").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-fps]");
  if (!btn) return;
  const fps = btn.dataset.fps;
  if ($("#ctlFps").value === fps) return;
  $("#ctlFps").value = fps;
  reapplyControls();
});

// ---- Init ----
(async function init() {
  initTheme();
  renderAutoplayButton();
  renderMuteButton();
  $("#themeToggleBtn").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "day" ? "night" : "day");
  };
  setMode("watch");
  resetStreamSettings();
  renderFpsPresets();
  renderQuickQuality();
  renderSettingOptions();
  updateBwHint();
  await pingHealth();
  await refreshSessionManager({ notify: false });
  await loadPlaylists().catch((e) => toast(e.message, true));
  setInterval(pingHealth, 10000);
  setInterval(() => refreshSessionManager({ notify: true }), SESSION_POLL_MS);
  window.addEventListener("resize", () => setMode(state.mode));
  window.addEventListener("pagehide", () => {
    stopDesktopAudioHlsSessionOnUnload();
    stopDesktopHlsSessionOnUnload();
  });
  document.addEventListener("pointerdown", retryBrowserAudioFromGesture, true);
  document.addEventListener("keydown", retryBrowserAudioFromGesture, true);
  document.addEventListener("visibilitychange", () => {
    activeCompat?.bufferedPlayer?.setVisible?.(!document.hidden);
  });
})();
