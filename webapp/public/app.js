// YT Streamer SPA. Vanilla JS, no build step. Talks to the same-origin API.
"use strict";

const $ = (s) => document.querySelector(s);
const api = {
  async get(p) { const r = await fetch(p); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async send(method, p, body) {
    const r = await fetch(p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.status === 204 ? null : r.json();
  },
  post(p, b) { return this.send("POST", p, b); },
  patch(p, b) { return this.send("PATCH", p, b); },
  del(p) { return this.send("DELETE", p); },
};

const state = {
  playlists: [],
  selectedPlaylistId: null,
  playingItemId: null,
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

function setPlaylistDrawer(open) {
  const drawer = $("#playlistDrawer");
  const btn = $("#playlistMenuBtn");
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  $("#drawerBackdrop").hidden = !open;
}

function closePlaylistDrawer() { setPlaylistDrawer(false); }
function isCompactDrawer() { return window.matchMedia("(max-width: 760px)").matches; }
function revealDrawerItems() {
  if (!isCompactDrawer()) return;
  const itemsHead = $("#itemsTitle");
  if (!itemsHead) return;
  requestAnimationFrame(() => {
    itemsHead.scrollIntoView({ block: "start", behavior: "smooth" });
    $("#itemList").scrollTop = 0;
  });
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
      <div class="row-actions">
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
    <div class="row-actions">
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

// ---- Player ----
function streamQuery() {
  const p = new URLSearchParams({
    height: $("#ctlHeight").value,
    fps: $("#ctlFps").value,
    quality: $("#ctlQuality").value,
    _: Date.now(), // cache-bust so re-play restarts ffmpeg
  });
  return p.toString();
}

let soundOn = true;
let replayFn = null;     // rebuilds the current stream with the latest control values
let mpegtsPlayer = null; // active mpegts.js player instance
let activeCompat = null; // active MJPEG + audio fallback URLs
let audioPrompted = false;
let syntheticFullscreen = false;
let streamAttempt = 0;
let streamWarnTimer = null;
let streamFailTimer = null;
let restreamTimer = null;
const STREAM_WARN_MS = 12000;
const STREAM_FAIL_MS = 30000;

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
}

function failStreamAttempt(attempt, title, detail) {
  if (!currentAttempt(attempt)) return;
  streamAttempt++;
  clearStreamTimers();
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

function startStreamWatchdog(attempt, mode) {
  clearStreamTimers();
  streamWarnTimer = setTimeout(() => {
    if (!currentAttempt(attempt)) return;
    setBadge("reconnecting", "Still connecting...");
    showStreamNotice(
      "warning",
      "Still connecting",
      `${mode} has not delivered a video frame yet. Waiting a bit longer before marking it failed.`
    );
  }, STREAM_WARN_MS);
  streamFailTimer = setTimeout(() => {
    failStreamAttempt(
      attempt,
      "No video frames received",
      "The stream connection stayed open, but no playable video arrived after 30 seconds. Try Retry, Lower quality, another channel, or check VPN/geo restrictions."
    );
  }, STREAM_FAIL_MS);
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
  destroyPlayer();
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
  try { audio.pause(); } catch {}
  audio.oncanplay = null;
  audio.onerror = null;
  audio.removeAttribute("src");
  try { audio.load(); } catch {}
  activeCompat = null;
  audioPrompted = false;
}

function startCompatAudio(notify = false) {
  const audio = $("#audio");
  if (!activeCompat?.audioUrl || !soundOn) return;
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
}

function playCompatStream({ mjpegUrl, audioUrl }, label) {
  const screen = $("#screen"), img = $("#mjpeg"), audio = $("#audio");
  cleanupMedia();
  const attempt = streamAttempt;
  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  screen.classList.remove("video-mode");
  screen.classList.add("playing", "loading", "mjpeg-mode");
  setBadge("reconnecting", "↻ Connecting…");
  startStreamWatchdog(attempt, "MJPEG fallback");
  activeCompat = { mjpegUrl, audioUrl };

  img.onload = () => {
    if (activeCompat?.mjpegUrl !== mjpegUrl) return;
    markStreamLive(attempt);
  };
  img.onerror = () => {
    if (activeCompat?.mjpegUrl !== mjpegUrl) return;
    failStreamAttempt(attempt, "Mac could not convert stream", "The source opened, but ffmpeg did not produce MJPEG video frames. Try Lower quality, a lower resolution, or another channel.");
  };
  img.src = mjpegUrl;

  audio.muted = !soundOn;
  audio.oncanplay = () => startCompatAudio(false);
  if (audioUrl && soundOn) {
    audio.src = audioUrl;
    startCompatAudio(true);
  }
}

// Play one synced MPEG-TS stream (H.264+AAC) via mpegts.js / MSE.
async function playStream(sources, label) {
  const { tsUrl, mjpegUrl, audioUrl } = typeof sources === "string" ? { tsUrl: sources } : sources;
  const screen = $("#screen"), video = $("#video");
  $("#nowPlaying").textContent = label || "Playing";
  $("#stopBtn").disabled = false;
  $("#restreamBtn").disabled = false;
  cleanupMedia();
  const attempt = streamAttempt;
  if (mjpegUrl && !canTryMpegts()) return playCompatStream({ mjpegUrl, audioUrl }, label);
  screen.classList.remove("mjpeg-mode");
  screen.classList.add("playing", "loading", "video-mode");
  setBadge("reconnecting", "↻ Connecting…");
  startStreamWatchdog(attempt, "MPEG-TS playback");
  try { await ensureMpegts(); } catch (e) {
    if (mjpegUrl) return playCompatStream({ mjpegUrl, audioUrl }, label);
    failStreamAttempt(attempt, "Player failed to load", streamErrorDetail(e.message)); return;
  }
  if (!currentAttempt(attempt)) return;
  if (!window.mpegts || !mpegts.isSupported()) {
    if (mjpegUrl) return playCompatStream({ mjpegUrl, audioUrl }, label);
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
    if (mjpegUrl) return playCompatStream({ mjpegUrl, audioUrl }, label);
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

function playItem(item) {
  state.playingItemId = item.id;
  renderItems();
  replayFn = () => {
    const q = streamQuery();
    playStream({
      tsUrl: `/stream/ts/item/${item.id}?${q}`,
      mjpegUrl: `/stream/item/${item.id}?${q}`,
      audioUrl: `/stream/audio/item/${item.id}?_=${Date.now()}`,
    }, item.title);
  };
  replayFn();
}

function stopPlayback() {
  cleanupMedia();
  replayFn = null;
  setBadge("hidden");
  $("#screen").classList.remove("playing", "loading", "video-mode", "mjpeg-mode");
  $("#nowPlaying").textContent = "Player";
  $("#stopBtn").disabled = true;
  $("#restreamBtn").disabled = true;
  state.playingItemId = null;
  renderItems();
}

function restreamPlayback() {
  if (!replayFn) return;
  const replay = replayFn;
  cleanupMedia();
  $("#screen").classList.remove("playing", "loading", "video-mode", "mjpeg-mode");
  setBadge("reconnecting", "↻ Restreaming...");
  toast("Reloading stream");
  clearTimeout(restreamTimer);
  restreamTimer = setTimeout(() => {
    restreamTimer = null;
    if (replayFn === replay) replay();
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
  replayFn();
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

window.__closeModal = closeModal;

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
  view.hidden = false;
  const player = $(".player");
  const scrollToPanel = () => { player.scrollTop = Math.max(0, view.offsetTop - 12); };
  scrollToPanel();
  requestAnimationFrame(scrollToPanel);
}
function openChannels() { revealChannels(); if (!ch.sourcesLoaded) loadChannelSources(true); else loadChannels(true); }
function closeChannels() { closeChannelMenus(); $("#channelsView").hidden = true; }

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
    return `<div class="ch-row" data-ch="${payload}">
      ${logo}
      <div class="info"><div class="nm">${esc(c.name)}</div><div class="gp">${esc(c.group)}</div></div>
      <div class="acts">
        <button class="play" type="button" data-act="play" title="Play" aria-label="Play ${esc(c.name)}">▶</button>
        <button class="save-channel" type="button" data-act="add" title="Save to playlist" aria-label="Save ${esc(c.name)} to playlist">+</button>
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
$("#channelsBtn").onclick = openChannels;
$("#chClose").onclick = closeChannels;
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
      row.classList.add("saved");
      addBtn.classList.remove("saving");
      addBtn.classList.add("saved");
      addBtn.textContent = "✓";
      addBtn.title = "Saved";
      addBtn.setAttribute("aria-label", `Saved ${c.name}`);
      toast(`Saved “${c.name}” to ${country.countryName} / ${category}`);
      setTimeout(() => {
        row.classList.remove("saved");
        addBtn.classList.remove("saved");
        addBtn.disabled = false;
        addBtn.textContent = originalText;
        addBtn.title = originalTitle;
        addBtn.setAttribute("aria-label", `Save ${c.name} to playlist`);
      }, 2200);
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
  replayFn = () => playStream(channelStreamSrc(c), c.name);
  replayFn();
});

// ---- Event wiring ----
$("#addPlaylistBtn").onclick = modalNewPlaylist;
$("#addItemBtn").onclick = modalAddItem;
$("#playlistMenuBtn").onclick = () => setPlaylistDrawer(true);
$("#playlistCloseBtn").onclick = closePlaylistDrawer;
$("#drawerBackdrop").onclick = closePlaylistDrawer;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#playlistDrawer").classList.contains("open")) closePlaylistDrawer();
});
$("#stopBtn").onclick = stopPlayback;
$("#restreamBtn").onclick = restreamPlayback;
$("#fullscreenBtn").onclick = toggleScreenFullscreen;
$("#streamRetryBtn").onclick = () => {
  if (!replayFn) return;
  toast("Retrying stream");
  replayFn();
};
$("#streamLowerBtn").onclick = () => {
  if (!replayFn) return;
  lowerPlaybackSettings();
  toast("Retrying at " + currentSettingsLabel());
  replayFn();
};
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
    screen.addEventListener("pointerup", (e) => {
      if (typeof e.button === "number" && e.button > 0) return;
      if (handleTap(e.clientX, e.clientY)) e.preventDefault();
    });
  } else {
    screen.addEventListener("touchend", (e) => {
      const touch = e.changedTouches?.[0];
      if (touch && handleTap(touch.clientX, touch.clientY)) e.preventDefault();
    }, { passive: false });
  }

  screen.addEventListener("dblclick", (e) => {
    if (Date.now() < ignoreDblClickUntil) return;
    e.preventDefault();
    toggleScreenFullscreen();
  });
  document.addEventListener("fullscreenchange", () => { setSyntheticFullscreen(false); updateFullscreenButton(); });
  document.addEventListener("webkitfullscreenchange", () => { setSyntheticFullscreen(false); updateFullscreenButton(); });
}

$("#quickPlayBtn").onclick = async () => {
  const url = $("#quickUrl").value.trim();
  if (!url) return toast("Paste a URL first", true);

  // YouTube -> play directly.
  if (/youtube\.com|youtu\.be/.test(url)) {
    state.playingItemId = null; renderItems();
    replayFn = () => {
      const q = streamQuery();
      const u = encodeURIComponent(url);
      playStream({
        tsUrl: `/stream/ts/youtube?url=${u}&${q}`,
        mjpegUrl: `/stream/youtube?url=${u}&${q}`,
        audioUrl: `/stream/audio/youtube?url=${u}&_=${Date.now()}`,
      }, "YouTube");
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
  renderFpsPresets();
  updateBwHint();
  await pingHealth();
  await loadPlaylists().catch((e) => toast(e.message, true));
  setInterval(pingHealth, 10000);
})();
