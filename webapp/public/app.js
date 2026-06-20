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

const state = {
  playlists: [],
  selectedPlaylistId: null,
  playingItemId: null,
  mode: "watch",
  manageSaved: false,
  lastSavedPlaylistId: null,
  legacyItems: [],
  legacyPlayingId: null,
  legacyPlaylists: [],
  selectedLegacyPlaylistId: null,
  legacyPlaylistVideos: [],
  youtubeAuth: null,
  recommendations: [],
  recommendationCategory: "all",
  recommendationVisibleCount: 25,
  recommendationsLoadedAt: null,
  recommendedPlayingId: null,
  recommendationDownloads: {},
  desktopSources: null,
};

const FPS_OPTIONS = [
  { value: "5", label: "5" },
  { value: "8", label: "8" },
  { value: "12", label: "12" },
  { value: "15", label: "15" },
  { value: "20", label: "20", risky: true },
  { value: "24", label: "24", risky: true },
  { value: "30", label: "30", risky: true },
];

const DESKTOP_AUDIO_KEY = "ytStreamerDesktopAudio";
const DESKTOP_AUDIO_NAME_KEY = "ytStreamerDesktopAudioName";
const DESKTOP_INPUT_TOKEN_KEY = "ytStreamerDesktopInputToken";
const RECOMMENDATION_PAGE_SIZE = 25;
const DEFAULT_EMBED_CODE = `<iframe title="Argentina vs Algeria Player" marginheight="0" marginwidth="0" src="https://embed.st/embed/admin/ppv-argentina-vs-algeria/1" scrolling="no" allowfullscreen="yes" allow="encrypted-media; picture-in-picture;" width="100%" height="100%" frameborder="0"></iframe>`;

// ---- UI helpers ----
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : " ok");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
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

function closeModal() { $("#modalBackdrop").hidden = true; $("#modal").innerHTML = ""; }
function openModal(html) { $("#modal").innerHTML = html; $("#modalBackdrop").hidden = false; }
$("#modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });

function isMobileMode() { return window.matchMedia("(max-width: 760px)").matches; }

function setPanelHidden(el, hidden) {
  if (!el) return;
  el.hidden = hidden;
  el.inert = hidden;
  el.setAttribute("aria-hidden", hidden ? "true" : "false");
}

function setMode(mode) {
  state.mode = mode;
  const layout = $("#layout");
  layout.classList.toggle("mode-watch", mode === "watch");
  layout.classList.toggle("mode-browse", mode === "browse");
  layout.classList.toggle("mode-recommended", mode === "recommended");
  layout.classList.toggle("mode-desktop", mode === "desktop");
  layout.classList.toggle("mode-embed", mode === "embed");
  layout.classList.toggle("mode-saved", mode === "saved");
  layout.classList.toggle("mode-library", mode === "library");
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  setPanelHidden($("#channelsView"), mode !== "browse");
  setPanelHidden($("#recommendationsView"), mode !== "recommended");
  setPanelHidden($("#desktopView"), mode !== "desktop");
  setPanelHidden($("#embedView"), mode !== "embed");
  setPanelHidden($("#playlistDrawer"), mode !== "saved");
  setPanelHidden($("#legacyLibraryView"), mode !== "library");
  const player = $(".player");
  const hideMobilePlayer = isMobileMode() && mode !== "watch";
  player.inert = hideMobilePlayer;
  player.setAttribute("aria-hidden", hideMobilePlayer ? "true" : "false");
}

function closePlaylistDrawer() { if (state.mode === "saved") setMode("watch"); }
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
  setMode("saved");
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
  if (!state.selectedPlaylistId && state.playlists.length) selectPlaylist(state.playlists[0].id);
  else renderItems();
  refreshChannelSavedStates();
}

function renderPlaylists() {
  const ul = $("#playlistList");
  if (!state.playlists.length) { ul.innerHTML = `<div class="empty">No playlists yet.<br>Tap “+ New”.</div>`; return; }
  ul.innerHTML = state.playlists.map((p) => `
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
  const p = new URLSearchParams({ _: Date.now() });
  const timestamp = timestampValue(startAt);
  if (timestamp) p.set("timestamp", String(Math.floor(timestamp * 1000) / 1000));
  return p.toString();
}

let soundOn = true;
let replayFn = null;     // rebuilds the current stream with the latest control values
let mpegtsPlayer = null; // active mpegts.js player instance
let activeCompat = null; // active MJPEG + audio fallback URLs
let audioPrompted = false;
let desktopStreamActive = false;
let desktopHlsSessionId = null;
let desktopAudioHlsSessionId = null;
let desktopInputStatus = null;
let desktopInputActive = false;
let desktopInputPointerId = null;
let desktopInputLastMoveAt = 0;
let desktopInputLastErrorAt = 0;
const DESKTOP_ZOOM_MIN = 1;
const DESKTOP_ZOOM_MAX = 4;
const DESKTOP_ZOOM_STEP = 0.25;
const desktopZoom = {
  scale: 1,
  panX: 0,
  panY: 0,
  panPointerId: null,
  panLastX: 0,
  panLastY: 0,
};
let syntheticFullscreen = false;
let activeEmbedCode = "";
let activeEmbedHeight = "";
let streamAttempt = 0;
let streamWarnTimer = null;
let streamFailTimer = null;
let restreamTimer = null;
const streamSeek = {
  seekable: false,
  duration: 0,
  startAt: 0,
  timer: null,
  liveAtMs: 0,
};
const STREAM_WARN_MS = 12000;
const STREAM_FAIL_MS = 30000;
const COMPAT_STREAM_WARN_MS = 25000;
const COMPAT_STREAM_FAIL_MS = 60000;

function currentSettingsLabel() {
  const h = $("#ctlHeight");
  const hl = h.value === "0" ? "Source" : h.value + "p";
  const q = $("#ctlQuality").selectedOptions[0]?.textContent || "";
  return `${hl} · ${$("#ctlFps").value}fps · ${q}`;
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

function setBadge(mode, text) {
  const b = $("#streamBadge");
  if (mode === "hidden") { b.hidden = true; return; }
  b.hidden = false;
  b.className = "stream-badge " + mode;
  b.textContent = text;
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
}

function currentAttempt(attempt) {
  return attempt === streamAttempt;
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
}

function clampStreamSeekTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, streamSeek.duration ? Math.min(n, streamSeek.duration) : n);
}

function getStreamCurrentTime() {
  if (!streamSeek.seekable) return 0;
  const videoTime = $("#video").currentTime || 0;
  const audioTime = $("#audio").currentTime || 0;
  const mediaTime = Math.max(videoTime, audioTime);
  if (mediaTime > 0) return clampStreamSeekTime(streamSeek.startAt + mediaTime);
  if (streamSeek.liveAtMs) {
    return clampStreamSeekTime(streamSeek.startAt + ((Date.now() - streamSeek.liveAtMs) / 1000));
  }
  return clampStreamSeekTime(streamSeek.startAt);
}

function updateStreamSeekUi(current = getStreamCurrentTime()) {
  const panel = $("#streamSeek");
  if (!panel) return;
  panel.hidden = !streamSeek.seekable;
  if (!streamSeek.seekable) return;
  const duration = streamSeek.duration || 0;
  const pct = duration ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  $("#streamSeekFill").style.width = `${pct}%`;
  $("#streamSeekThumb").style.left = `${pct}%`;
  $("#streamSeekTrack").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("#streamSeekTime").textContent = `${clock(current)} / ${clock(duration)}`;
  $("#streamBackBtn").disabled = current <= 0;
  $("#streamForwardBtn").disabled = duration ? current >= duration - 1 : false;
}

function stopStreamSeekTimer(reset = false) {
  clearInterval(streamSeek.timer);
  streamSeek.timer = null;
  streamSeek.liveAtMs = 0;
  if (reset) {
    streamSeek.seekable = false;
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
  streamSeek.startAt = clampStreamSeekTime(startAt);
  updateStreamSeekUi(streamSeek.startAt);
}

function seekStreamTo(time) {
  if (!streamSeek.seekable || !replayFn) return;
  const target = clampStreamSeekTime(time);
  streamSeek.startAt = target;
  streamSeek.liveAtMs = 0;
  updateStreamSeekUi(target);
  toast("Seeking to " + clock(target));
  replayFn(target);
}

function failStreamAttempt(attempt, title, detail) {
  if (!currentAttempt(attempt)) return;
  streamAttempt++;
  clearStreamTimers();
  stopStreamSeekTimer(false);
  destroyPlayer();
  const screen = $("#screen"), video = $("#video"), img = $("#mjpeg"), audio = $("#audio");
  screen.classList.remove("loading");
  setBadge("error", "Stream failed");
  showStreamNotice("error", title, detail);
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  try { video.load(); } catch {}
  img.removeAttribute("src");
  try { audio.pause(); } catch {}
  audio.removeAttribute("src");
  try { audio.load(); } catch {}
  activeCompat = null;
  toast(title, true);
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

function destroyPlayer() {
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch {} mpegtsPlayer = null; }
}

function canTryMpegts() {
  return Boolean(window.MediaSource || window.ManagedMediaSource || window.mpegts);
}

function cleanupMedia() {
  const video = $("#video"), img = $("#mjpeg"), audio = $("#audio");
  streamAttempt++;
  clearStreamTimers();
  clearStreamNotice();
  stopStreamSeekTimer(false);
  destroyPlayer();
  clearEmbedFrame();
  try { video.pause(); } catch {}
  video.onplaying = null;
  video.onerror = null;
  video.onstalled = null;
  video.onwaiting = null;
  video.removeAttribute("src");
  try { video.load(); } catch {}
  img.onload = null;
  img.onerror = null;
  img.removeAttribute("src");
  img.style.visibility = "";
  try { audio.pause(); } catch {}
  audio.onloadeddata = null;
  audio.oncanplay = null;
  audio.oncanplaythrough = null;
  audio.onerror = null;
  audio.onplaying = null;
  audio.removeAttribute("src");
  try { audio.load(); } catch {}
  activeCompat = null;
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

function renderEmbedCode(code, heightValue) {
  const source = parseEmbedIframe(code);
  stopDesktopHlsSession();
  stopDesktopAudioHlsSession();
  cleanupMedia();
  stopLegacyProgress();
  stopStreamSeekTimer(true);
  desktopStreamActive = false;
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
  screen.classList.remove("loading", "video-mode", "mjpeg-mode");
  screen.classList.add("playing", "embed-mode");
  activeEmbedCode = code;
  activeEmbedHeight = heightValue || $("#embedHeight")?.value || "";
  replayFn = () => renderEmbedCode(activeEmbedCode, activeEmbedHeight);
  $("#nowPlaying").textContent = frame.title || "Embed Player";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  setBadge("live", "EMBED");
  $("#embedStatus").textContent = "Loaded";
  if (isMobileMode()) setMode("watch");
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

function openEmbed() {
  setMode("embed");
  const input = $("#embedCodeInput");
  if (input && !input.value.trim()) input.value = DEFAULT_EMBED_CODE;
  requestAnimationFrame(() => {
    input?.focus();
    input?.select();
  });
}

function startCompatAudio(notify = false) {
  const audio = $("#audio");
  if (!activeCompat?.audioUrl || !soundOn) return null;
  if (!audio.src) audio.src = activeCompat.audioUrl;
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

function loadCompatVideo(attempt, mjpegUrl) {
  const img = $("#mjpeg");
  if (!currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl || activeCompat.videoStarted) return;
  activeCompat.videoStarted = true;
  img.src = mjpegUrl;
}

function audioReadyForSync(audio) {
  return audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

function withUrlParam(url, key, value) {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set(key, String(value));
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function measuredAudioStartupDelayMs(startedAt) {
  if (!startedAt) return 0;
  return Math.max(0, Math.min(5000, Math.round(performance.now() - startedAt)));
}

function playCompatStream({ mjpegUrl, audioUrl }, label, meta = {}) {
  const screen = $("#screen"), img = $("#mjpeg"), audio = $("#audio");
  cleanupMedia();
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
  activeCompat = { mjpegUrl, audioUrl, audioReady: false, videoReady: false, videoStarted: false, playbackStarted: false };

  const releaseCompatPlayback = () => {
    if (!currentAttempt(attempt) || activeCompat?.mjpegUrl !== mjpegUrl || activeCompat.playbackStarted) return;
    if (!activeCompat.videoReady) return;
    if (audioUrl && soundOn && !activeCompat.audioReady && !meta.looseAudioSync) return;
    activeCompat.playbackStarted = true;
    if (audioUrl && soundOn && activeCompat.audioReady) {
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
    audio.src = audioUrl;
    try { audio.load(); } catch {}
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
  const screen = $("#screen"), video = $("#video");
  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  cleanupMedia();
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
  video.muted = !soundOn;
  mpegtsPlayer.load();
  video.play().catch(() => {});
}

function playNativeVideoStream({ nativeUrl, fallback }, label, meta = {}) {
  const screen = $("#screen"), video = $("#video");
  cleanupMedia();
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
  video.src = nativeUrl;
  try { video.load(); } catch {}
  video.play().catch(() => {});
}

async function enrichYoutubeStreamMeta(item) {
  if (item.type !== "youtube" || item.meta?.duration) return item;
  try {
    const info = await api.get(`/api/youtube/info?url=${encodeURIComponent(item.url)}`);
    item.meta = { ...(item.meta || {}), duration: info.duration, thumbnail: info.thumbnail };
    if (!item.title && info.title) item.title = info.title;
  } catch (e) {
    console.warn("youtube info failed for saved item:", e.message);
  }
  return item;
}

async function playItem(item) {
  item = await enrichYoutubeStreamMeta(item);
  state.playingItemId = item.id;
  renderItems();
  if (isMobileMode()) setMode("watch");
  showAttemptedUrl(item.url);
  replayFn = (startAt = getStreamCurrentTime()) => {
    const q = streamQuery(startAt);
    playStream({
      tsUrl: `/stream/ts/item/${item.id}?${q}`,
      mjpegUrl: `/stream/item/${item.id}?${q}`,
      audioUrl: `/stream/audio/item/${item.id}?${audioQuery(startAt)}`,
    }, item.title, {
      seekable: item.type === "youtube" || item.type === "file",
      duration: item.meta?.duration,
      startAt,
    });
  };
  replayFn();
}

function stopPlayback() {
  stopDesktopHlsSession();
  stopDesktopAudioHlsSession();
  cleanupMedia();
  stopLegacyProgress();
  stopStreamSeekTimer(true);
  replayFn = null;
  desktopStreamActive = false;
  desktopInputActive = false;
  desktopInputPointerId = null;
  resetDesktopZoom();
  renderDesktopInputUi();
  setBadge("hidden");
  $("#screen").classList.remove("playing", "loading", "video-mode", "mjpeg-mode", "embed-mode");
  $("#screen").style.height = "";
  $("#screen").style.aspectRatio = "";
  $("#nowPlaying").textContent = "Player";
  $("#stopBtn").disabled = true;
  $("#restreamBtn").disabled = true;
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = null;
  activeEmbedCode = "";
  activeEmbedHeight = "";
  legacy.playing = null;
  legacy.resolution = null;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
}

function restreamPlayback() {
  if (!replayFn) return;
  const replay = replayFn;
  const resumeAt = streamSeek.seekable ? getStreamCurrentTime() : undefined;
  stopDesktopAudioHlsSession();
  cleanupMedia();
  $("#screen").classList.remove("playing", "loading", "video-mode", "mjpeg-mode", "embed-mode");
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

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isScreenFullscreen() {
  return fullscreenElement() === $("#screen") || syntheticFullscreen;
}

function updateFullscreenButton() {
  const btn = $("#fullscreenBtn");
  document.body.classList.toggle("screen-fullscreen", isScreenFullscreen());
  if (!btn) return;
  const active = isScreenFullscreen();
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

// Re-apply controls live: restart whatever is currently playing with new params.
function reapplyControls() {
  renderFpsPresets();
  updateBwHint();
  if (!replayFn) return;
  toast("Restarting at " + currentSettingsLabel());
  replayFn(streamSeek.seekable ? getStreamCurrentTime() : undefined);
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

// ---- Processed YouTube library ----
const legacy = {
  playing: null,
  resolution: null,
  progressTimer: null,
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
    return;
  }
  select.disabled = false;
  select.innerHTML = state.legacyPlaylists.map((playlist) => (
    `<option value="${esc(playlist.id)}" ${playlist.id === state.selectedLegacyPlaylistId ? "selected" : ""}>${esc(playlist.name || playlist.url)}</option>`
  )).join("");
  const active = selectedLegacyPlaylist();
  $("#legacyDeletePlaylistBtn").disabled = !active || active.builtin;
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
    container.innerHTML = `<div class="legacy-empty">No playlist selected.</div>`;
    return;
  }
  container.innerHTML = `<div class="legacy-empty">Loading playlist...</div>`;
  try {
    const data = await api.get(`/api/legacy-library/playlists/${encodeURIComponent(playlist.id)}/videos`);
    state.legacyPlaylistVideos = data.videos || [];
    renderLegacyPlaylistVideos();
  } catch (e) {
    state.legacyPlaylistVideos = [];
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
  if (!state.legacyItems.length) {
    list.innerHTML = `<div class="legacy-empty">No processed videos yet.</div>`;
    updateLegacyResolutionSelect();
    return;
  }
  list.innerHTML = state.legacyItems.map((item) => `
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
  updateLegacyResolutionSelect();
}

function currentLegacyItem() {
  return state.legacyItems.find((item) => item.id === state.legacyPlayingId) || legacy.playing || null;
}

function updateLegacyResolutionSelect() {
  const select = $("#legacyResolutionSelect");
  if (!select) return;
  const item = currentLegacyItem();
  if (!item) {
    select.innerHTML = `<option>No video selected</option>`;
    select.disabled = true;
    return;
  }
  const current = legacy.resolution || item.resolutions?.[0];
  select.disabled = false;
  select.innerHTML = (item.resolutions || []).map((res) => (
    `<option value="${res}" ${res === current ? "selected" : ""}>${res}p</option>`
  )).join("");
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

async function streamLegacyPlaylistVideo(video) {
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
  renderItems();
  renderLegacyLibrary();
  showAttemptedUrl(url);
  replayFn = (startAt = getStreamCurrentTime()) => {
    const q = streamQuery(startAt);
    const u = encodeURIComponent(url);
    playStream({
      tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
      mjpegUrl: `/stream/youtube?url=${u}&${q}`,
      audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
    }, video.title || "YouTube", {
      seekable: !video.isLive,
      duration: video.duration,
      startAt,
    });
  };
  replayFn().catch((e) => toast(e.message, true));
}

function stopLegacyProgress() {
  clearInterval(legacy.progressTimer);
  legacy.progressTimer = null;
  const fill = $("#legacySeekFill");
  const thumb = $("#legacySeekThumb");
  const time = $("#legacyTime");
  if (fill) fill.style.width = "0%";
  if (thumb) thumb.style.left = "0%";
  if (time) time.textContent = "0:00 / 0:00";
  ["#legacyBackBtn", "#legacyForwardBtn"].forEach((sel) => {
    const btn = $(sel);
    if (btn) btn.disabled = true;
  });
}

function startLegacyProgress() {
  stopLegacyProgress();
  const audio = $("#audio");
  const tick = () => {
    const duration = audio.duration || legacy.playing?.duration || 0;
    const current = audio.currentTime || 0;
    const pct = duration ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
    $("#legacySeekFill").style.width = `${pct}%`;
    $("#legacySeekThumb").style.left = `${pct}%`;
    $("#legacySeek").setAttribute("aria-valuenow", String(Math.round(pct)));
    $("#legacyTime").textContent = `${clock(current)} / ${clock(duration)}`;
    const ready = Boolean(legacy.playing && duration);
    $("#legacyBackBtn").disabled = !ready;
    $("#legacyForwardBtn").disabled = !ready;
  };
  tick();
  legacy.progressTimer = setInterval(tick, 250);
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

function seekLegacy(time) {
  if (!legacy.playing) return;
  const audio = $("#audio");
  const duration = audio.duration || legacy.playing.duration || 0;
  const target = Math.max(0, duration ? Math.min(time, duration) : time);
  $("#mjpeg").src = legacyStreamUrl(target);
  try { audio.currentTime = target; } catch {}
  if (soundOn) audio.play().catch(() => toast("Tap sound to resume audio"));
}

function playLegacyItem(item, resolution = null, startAt = 0) {
  const screen = $("#screen"), img = $("#mjpeg"), audio = $("#audio");
  cleanupMedia();
  stopStreamSeekTimer(true);
  state.playingItemId = null;
  state.legacyPlayingId = item.id;
  legacy.playing = item;
  legacy.resolution = resolution || item.resolutions?.[0];
  renderItems();
  renderLegacyLibrary();
  updateLegacyResolutionSelect();
  if (isMobileMode()) setMode("watch");
  $("#nowPlaying").textContent = item.title || "Processed video";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  screen.classList.remove("video-mode");
  screen.classList.add("playing", "loading", "mjpeg-mode");
  setBadge("reconnecting", "↻ Starting processed video...");
  const attempt = streamAttempt;
  startStreamWatchdog(attempt, "Processed video");

  img.onload = () => {
    if (!currentAttempt(attempt)) return;
    markStreamLive(attempt);
  };
  img.onerror = () => failStreamAttempt(attempt, "Processed video failed", "The Mac could not convert the saved video at this position.");
  img.src = legacyStreamUrl(startAt);

  audio.src = `/stream/legacy-audio/${encodeURIComponent(item.id)}?_=${Date.now()}`;
  audio.muted = !soundOn;
  audio.onloadedmetadata = () => {
    try { audio.currentTime = startAt || 0; } catch {}
    if (soundOn) audio.play().catch(() => toast("Tap sound to start audio"));
    startLegacyProgress();
  };
  audio.oncanplay = () => {
    if (soundOn) audio.play().catch(() => {});
  };
  replayFn = () => playLegacyItem(item, legacy.resolution, $("#audio").currentTime || startAt || 0);
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
  const select = $("#ytCategoryFilter");
  if (!select) return;
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
  select.innerHTML = `<option value="all">All categories (${state.recommendations.length})</option>${options.map(([id, value]) =>
    `<option value="${esc(id)}">${esc(value.title)} (${value.count})</option>`
  ).join("")}`;
  select.value = state.recommendationCategory;
  select.disabled = !state.recommendations.length;
}

function renderYoutubeAuth() {
  const auth = state.youtubeAuth;
  if (!auth) {
    $("#ytConnectBtn").hidden = false;
    $("#ytConnectBtn").disabled = true;
    $("#ytDisconnectBtn").hidden = true;
    $("#ytRefreshBtn").disabled = true;
    setRecommendationStatus("Checking YouTube connection...");
    return;
  }
  const configured = Boolean(auth?.configured);
  const connected = Boolean(auth?.connected);
  const renewalRequired = Boolean(auth?.renewalRequired);
  $("#ytConnectBtn").hidden = !configured;
  $("#ytConnectBtn").disabled = !configured;
  $("#ytConnectBtn").textContent = connected || renewalRequired ? "Renew" : "Connect";
  $("#ytDisconnectBtn").hidden = !auth?.hasCredentials;
  $("#ytRefreshBtn").disabled = !connected;

  if (!configured) {
    setRecommendationStatus(`Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET. Redirect: ${auth?.redirectUri || "/api/youtube-auth/callback"}`, true);
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
    const thumb = item.thumbnail
      ? `<div class="recommendation-thumb"><img src="${esc(item.thumbnail)}" alt="" loading="lazy" /></div>`
      : `<div class="recommendation-thumb placeholder">▶</div>`;
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

function connectYoutube() {
  $("#ytConnectBtn").disabled = true;
  setRecommendationStatus("Opening Google authorization...");
  const popup = window.open("/api/youtube-auth/start", "ytstreamer_youtube_oauth");
  if (!popup) window.location.href = "/api/youtube-auth/start";
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    try {
      const auth = await loadYoutubeAuthStatus();
      if (auth.connected) {
        clearInterval(timer);
        await loadRecommendations();
      }
    } catch {}
    if (tries > 60) {
      clearInterval(timer);
      renderYoutubeAuth();
    }
  }, 2000);
}

async function disconnectYoutube() {
  if (!confirm("Disconnect YouTube from this Mac?")) return;
  try {
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

async function streamRecommendation(item) {
  if (!item) return;
  state.playingItemId = null;
  state.legacyPlayingId = null;
  state.recommendedPlayingId = item.id;
  renderItems();
  renderLegacyLibrary();
  renderRecommendations();
  showAttemptedUrl(item.url);
  if (isMobileMode()) setMode("watch");
  replayFn = (startAt = getStreamCurrentTime()) => {
    const q = streamQuery(startAt);
    const u = encodeURIComponent(item.url);
    playStream({
      tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
      mjpegUrl: `/stream/youtube?url=${u}&${q}`,
      audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
    }, item.title || "YouTube", {
      seekable: !item.isLive && !item.isUpcoming,
      duration: item.duration,
      startAt,
    });
  };
  replayFn();
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
  view.scrollTop = 0;
}
function openChannels() { revealChannels(); if (!ch.sourcesLoaded) loadChannelSources(true); else loadChannels(true); }
function closeChannels() { closeChannelMenus(); if (state.mode === "browse") setMode("watch"); }

async function openLegacyLibrary() {
  setMode("library");
  try {
    await loadLegacyLibrary();
    await loadLegacyPlaylists();
  }
  catch (e) { toast(e.message, true); }
}

async function openDesktop() {
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
}

async function stopDesktopHlsSession() {
  const id = desktopHlsSessionId;
  desktopHlsSessionId = null;
  if (!id) return;
  await api.post(`/api/desktop/hls/${encodeURIComponent(id)}/stop`).catch(() => {});
}

async function stopDesktopAudioHlsSession() {
  const id = desktopAudioHlsSessionId;
  desktopAudioHlsSessionId = null;
  if (!id) return;
  await api.post(`/api/desktop/audio-hls/${encodeURIComponent(id)}/stop`).catch(() => {});
}

function stopDesktopAudioHlsSessionOnUnload() {
  const id = desktopAudioHlsSessionId;
  desktopAudioHlsSessionId = null;
  if (!id) return;
  const url = `/api/desktop/audio-hls/${encodeURIComponent(id)}/stop`;
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

async function desktopAudioUrl(audio) {
  await stopDesktopAudioHlsSession();
  if (!audio) return "";
  return `/stream/desktop-audio?audio=${encodeURIComponent(audio)}&_=${Date.now()}`;
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
  if (isMobileMode()) setMode("watch");
  desktopStreamActive = true;
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
  };
  replayFn().catch((e) => toast(e.message, true));
}

function reapplyDesktopControls() {
  if (!desktopStreamActive || !replayFn) return;
  restreamPlayback();
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
let chSearchTimer;
$("#chSearch").addEventListener("input", (e) => {
  clearTimeout(chSearchTimer);
  chSearchTimer = setTimeout(() => { ch.q = e.target.value.trim(); loadChannels(true); }, 350);
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
  state.playingItemId = null; renderItems();
  showAttemptedUrl(c.url);
  replayFn = () => playStream(channelStreamSrc(c), c.name);
  replayFn();
});

// ---- Event wiring ----
$("#addPlaylistBtn").onclick = modalNewPlaylist;
$("#addItemBtn").onclick = modalAddItem;
$("#manageSavedBtn").onclick = () => setManageSaved(!state.manageSaved);
document.querySelectorAll(".mode-tab").forEach((tab) => {
  tab.onclick = () => {
    if (tab.dataset.mode === "browse") openChannels();
    else if (tab.dataset.mode === "recommended") openRecommendations();
    else if (tab.dataset.mode === "desktop") openDesktop();
    else if (tab.dataset.mode === "embed") openEmbed();
    else if (tab.dataset.mode === "library") openLegacyLibrary();
    else setMode(tab.dataset.mode);
  };
});
$("#emptySavedBtn").onclick = () => setMode("saved");
$("#emptyBrowseBtn").onclick = openChannels;
$("#emptyDesktopBtn").onclick = openDesktop;
$("#emptyEmbedBtn").onclick = openEmbed;
$("#emptyPasteBtn").onclick = () => {
  setMode("watch");
  const input = $("#quickUrl");
  input.focus();
  input.select();
};
$("#desktopHomeBtn").onclick = () => setMode("watch");
$("#desktopRefreshBtn").onclick = () => loadDesktopSources().catch((e) => renderDesktopStatus({ error: e.message }));
$("#desktopStartBtn").onclick = playDesktopStream;
$("#desktopStopBtn").onclick = stopPlayback;
$("#desktopInputToggle").onclick = toggleDesktopInput;
$("#embedHomeBtn").onclick = () => setMode("watch");
$("#embedLoadBtn").onclick = loadEmbedFromInput;
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
$("#desktopInputBtn").onclick = toggleDesktopInput;
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.mode !== "watch") setMode("watch");
});
$("#stopBtn").onclick = stopPlayback;
$("#restreamBtn").onclick = restreamPlayback;
$("#fullscreenBtn").onclick = toggleScreenFullscreen;
$("#streamRetryBtn").onclick = () => {
  if (!replayFn) return;
  toast("Retrying stream");
  replayFn(streamSeek.seekable ? getStreamCurrentTime() : undefined);
};
$("#streamLowerBtn").onclick = () => {
  if (!replayFn) return;
  lowerPlaybackSettings();
  toast("Retrying at " + currentSettingsLabel());
  replayFn(streamSeek.seekable ? getStreamCurrentTime() : undefined);
};
$("#legacyRefreshBtn").onclick = async () => {
  try {
    await loadLegacyLibrary();
    await loadLegacyPlaylists();
  } catch (e) {
    toast(e.message, true);
  }
};
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
$("#legacyResolutionSelect").onchange = () => {
  const item = currentLegacyItem();
  if (!item) return;
  const next = parseInt($("#legacyResolutionSelect").value, 10);
  playLegacyItem(item, next, $("#audio").currentTime || 0);
};
$("#ytConnectBtn").onclick = connectYoutube;
$("#ytDisconnectBtn").onclick = disconnectYoutube;
$("#ytRefreshBtn").onclick = loadRecommendations;
$("#ytCategoryFilter").onchange = () => {
  state.recommendationCategory = $("#ytCategoryFilter").value || "all";
  state.recommendationVisibleCount = RECOMMENDATION_PAGE_SIZE;
  renderRecommendations();
};
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
  clearInterval(streamSeek.timer);
  const seek = (clientX) => {
    const rect = $("#streamSeekTrack").getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    updateStreamSeekUi(pos * streamSeek.duration);
    return pos * streamSeek.duration;
  };
  let target = seek(e.clientX);
  const move = (ev) => { target = seek(ev.clientX); };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    seekStreamTo(target);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
});
$("#streamSeekTrack").addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); seekStreamTo(getStreamCurrentTime() - 10); }
  if (e.key === "ArrowRight") { e.preventDefault(); seekStreamTo(getStreamCurrentTime() + 10); }
});
$("#legacyBackBtn").onclick = () => seekLegacy(($("#audio").currentTime || 0) - 5);
$("#legacyForwardBtn").onclick = () => seekLegacy(($("#audio").currentTime || 0) + 5);
$("#legacySeek").addEventListener("pointerdown", (e) => {
  if (!legacy.playing) return;
  const seek = (clientX) => {
    const rect = $("#legacySeek").getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const duration = $("#audio").duration || legacy.playing.duration || 0;
    seekLegacy(pos * duration);
  };
  seek(e.clientX);
  const move = (ev) => seek(ev.clientX);
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
});
$("#legacySeek").addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); seekLegacy(($("#audio").currentTime || 0) - 5); }
  if (e.key === "ArrowRight") { e.preventDefault(); seekLegacy(($("#audio").currentTime || 0) + 5); }
});
$("#muteBtn").onclick = () => {
  const a = $("#audio");
  if (soundOn && activeCompat?.audioUrl && a.paused) {
    startCompatAudio(true);
    return;
  }
  soundOn = !soundOn;
  $("#muteBtn").textContent = soundOn ? "🔊" : "🔇";
  const v = $("#video");
  v.muted = !soundOn;
  a.muted = !soundOn;
  if (!soundOn) { try { a.pause(); } catch {} }
  if (soundOn) v.play().catch(() => {});
  if (soundOn && activeCompat?.audioUrl) startCompatAudio(true);
};

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
    playItem(item);
  }
});

bindTap($("#legacyList"), async (e) => {
  const row = e.target.closest(".legacy-item");
  if (!row) return;
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

function desktopInputActiveForScreen() {
  return Boolean(desktopStreamActive && desktopInputActive && desktopInputReady());
}

function activeScreenMediaElement() {
  const screen = $("#screen");
  if (screen.classList.contains("video-mode")) return $("#video");
  if (screen.classList.contains("mjpeg-mode")) return $("#mjpeg");
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
  let ignoreDblClickUntil = 0;

  function handleTap(x, y) {
    const now = Date.now();
    const moved = Math.hypot(x - lastTapX, y - lastTapY) > 40;
    if (now - lastTapAt < 350 && !moved) {
      lastTapAt = 0;
      ignoreDblClickUntil = now + 500;
      toggleScreenFullscreen();
      return true;
    }
    lastTapAt = now;
    lastTapX = x;
    lastTapY = y;
    return false;
  }

  if (window.PointerEvent) {
    screen.addEventListener("pointerdown", handleDesktopInputPointerDown);
    screen.addEventListener("pointerdown", handleDesktopPanPointerDown);
    screen.addEventListener("pointermove", handleDesktopInputPointerMove);
    screen.addEventListener("pointermove", handleDesktopPanPointerMove);
    screen.addEventListener("pointercancel", handleDesktopInputPointerUp);
    screen.addEventListener("pointercancel", handleDesktopPanPointerUp);
    screen.addEventListener("pointerup", (e) => {
      if (handleDesktopInputPointerUp(e)) return;
      if (handleDesktopPanPointerUp(e)) return;
      if (desktopInputActiveForScreen()) return;
      if (typeof e.button === "number" && e.button > 0) return;
      if (handleTap(e.clientX, e.clientY)) e.preventDefault();
    });
  } else {
    screen.addEventListener("touchend", (e) => {
      if (desktopInputActiveForScreen()) return;
      const touch = e.changedTouches?.[0];
      if (touch && handleTap(touch.clientX, touch.clientY)) e.preventDefault();
    }, { passive: false });
  }

  screen.addEventListener("wheel", (e) => {
    if (handleDesktopZoomWheel(e)) return;
    handleDesktopInputWheel(e);
  }, { passive: false });
  screen.addEventListener("dblclick", (e) => {
    if (desktopInputActiveForScreen()) return;
    if (Date.now() < ignoreDblClickUntil) return;
    e.preventDefault();
    toggleScreenFullscreen();
  });
  document.addEventListener("fullscreenchange", () => { setSyntheticFullscreen(false); updateFullscreenButton(); renderDesktopZoomUi(); });
  document.addEventListener("webkitfullscreenchange", () => { setSyntheticFullscreen(false); updateFullscreenButton(); renderDesktopZoomUi(); });
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
    state.playingItemId = null; renderItems();
    replayFn = (startAt = getStreamCurrentTime()) => {
      const q = streamQuery(startAt);
      const u = encodeURIComponent(url);
      playStream({
        tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
        mjpegUrl: `/stream/youtube?url=${u}&${q}`,
        audioUrl: `/stream/audio/youtube?url=${u}&${audioQuery(startAt)}`,
      }, info?.title || "YouTube", {
        seekable: !info?.isLive,
        duration: info?.duration,
        startAt,
      });
    };
    return replayFn();
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
      }, "Live URL");
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
    }, "Live URL");
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
  setMode("watch");
  renderFpsPresets();
  updateBwHint();
  await pingHealth();
  await loadPlaylists().catch((e) => toast(e.message, true));
  setInterval(pingHealth, 10000);
  window.addEventListener("resize", () => setMode(state.mode));
  window.addEventListener("pagehide", () => {
    stopDesktopAudioHlsSessionOnUnload();
    stopDesktopHlsSessionOnUnload();
  });
})();
