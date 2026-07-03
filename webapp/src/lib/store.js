// Server-side JSON store for playlists + their items (m3u8 streams and YouTube refs).
// Single-user, so a simple file with a serialized write queue is plenty.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

const STORE_FILE = path.join(config.dataDir, "store.json");

const DEFAULT_DATA = { version: 3, playlists: [], savedEmbeds: [], watchHistory: [], browserHistory: [] };
const MAX_WATCH_HISTORY = 300;
const MAX_BROWSER_HISTORY = 100;
const GENERIC_BROWSER_TITLES = new Set(["real chrome", "chrome", "browser", "about:blank"]);

let cache = null;
let writeChain = Promise.resolve();

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function canonicalUrl(url) {
  return String(url || "").trim();
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "") || "";
  } catch {
    return "";
  }
}

function browserHistoryTitle(entry = {}, previous = null, url = "") {
  const title = String(entry?.title || "").trim();
  const previousTitle = String(previous?.title || "").trim();
  if (title && !GENERIC_BROWSER_TITLES.has(title.toLowerCase())) return title.slice(0, 300);
  if (previousTitle && !GENERIC_BROWSER_TITLES.has(previousTitle.toLowerCase())) return previousTitle.slice(0, 300);
  return (hostnameFromUrl(url) || url || "Website").slice(0, 300);
}

function youtubeIdFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.hostname.includes("youtu.be")) return u.pathname.split("/").filter(Boolean)[0] || "";
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
    if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
  } catch {}
  return "";
}

function canonicalYoutubeId(entry = {}) {
  return String(entry.youtubeId || entry.id || youtubeIdFromUrl(entry.url) || "").trim();
}

function canonicalCategory(meta = {}) {
  return String(meta.category || meta.group || "").trim().toLowerCase();
}

function canonicalCountry(meta = {}, playlistMeta = {}) {
  return String(meta.countryCode || playlistMeta.countryCode || meta.countryName || playlistMeta.countryName || "")
    .trim()
    .toUpperCase();
}

function itemKey(item, playlistMeta = {}) {
  return [
    item.type || "m3u8",
    canonicalUrl(item.url),
    canonicalCountry(item.meta || {}, playlistMeta),
    canonicalCategory(item.meta || {}),
  ].join("\u0001");
}

function dedupeItems(data) {
  let changed = false;
  for (const playlist of data.playlists || []) {
    const seen = new Set();
    const next = [];
    for (const item of playlist.items || []) {
      const key = itemKey(item, playlist.meta || {});
      if (seen.has(key)) {
        changed = true;
        continue;
      }
      seen.add(key);
      next.push(item);
    }
    playlist.items = next;
  }
  return changed;
}

async function ensureDirs() {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(config.libraryDir, { recursive: true });
}

async function load() {
  if (cache) return cache;
  await ensureDirs();
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = { ...DEFAULT_DATA, ...parsed };
    if (!Array.isArray(cache.playlists)) cache.playlists = [];
    if (!Array.isArray(cache.savedEmbeds)) cache.savedEmbeds = [];
    if (!Array.isArray(cache.watchHistory)) cache.watchHistory = [];
    if (!Array.isArray(cache.browserHistory)) cache.browserHistory = [];
    cache.version = DEFAULT_DATA.version;
    if (dedupeItems(cache)) await persist();
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[store] could not read store, starting fresh:", err.message);
    }
    cache = structuredClone(DEFAULT_DATA);
    await persist();
  }
  return cache;
}

// Serialize writes so concurrent requests can't corrupt the file.
function persist() {
  writeChain = writeChain.then(async () => {
    const tmp = STORE_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.rename(tmp, STORE_FILE);
  });
  return writeChain;
}

// ---- Playlists ----

export async function listPlaylists() {
  const data = await load();
  return data.playlists;
}

export async function getPlaylist(playlistId) {
  const data = await load();
  return data.playlists.find((p) => p.id === playlistId) || null;
}

export async function addPlaylist({ name, meta }) {
  const data = await load();
  const playlist = {
    id: id(),
    name: (name || "Untitled").trim(),
    items: [],
    meta: meta && typeof meta === "object" ? meta : {},
    createdAt: Date.now(),
  };
  data.playlists.push(playlist);
  await persist();
  return playlist;
}

export async function updatePlaylist(playlistId, { name, meta }) {
  const data = await load();
  const p = data.playlists.find((x) => x.id === playlistId);
  if (!p) return null;
  if (typeof name === "string" && name.trim()) p.name = name.trim();
  if (meta && typeof meta === "object") p.meta = { ...(p.meta || {}), ...meta };
  await persist();
  return p;
}

export async function deletePlaylist(playlistId) {
  const data = await load();
  const before = data.playlists.length;
  data.playlists = data.playlists.filter((p) => p.id !== playlistId);
  await persist();
  return data.playlists.length < before;
}

// ---- Items within a playlist ----
// item = { id, title, type: 'm3u8' | 'youtube' | 'file', url, addedAt, meta? }

export async function addItem(playlistId, { title, type, url, meta }) {
  const data = await load();
  const p = data.playlists.find((x) => x.id === playlistId);
  if (!p) return null;
  const candidate = { type: type || "m3u8", url, meta: meta || {} };
  const candidateKey = itemKey(candidate, p.meta || {});
  const existing = (p.items || []).find((item) => itemKey(item, p.meta || {}) === candidateKey);
  if (existing) return { ...existing, duplicate: true };
  const item = {
    id: id(),
    title: (title || url || "Untitled").toString().slice(0, 300),
    type: type || "m3u8",
    url: (url || "").toString(),
    meta: meta || {},
    addedAt: Date.now(),
  };
  p.items.push(item);
  await persist();
  return item;
}

export async function updateItem(playlistId, itemId, patch) {
  const data = await load();
  const p = data.playlists.find((x) => x.id === playlistId);
  if (!p) return null;
  const item = p.items.find((i) => i.id === itemId);
  if (!item) return null;
  for (const k of ["title", "type", "url"]) {
    if (typeof patch[k] === "string") item[k] = patch[k];
  }
  if (patch.meta && typeof patch.meta === "object") {
    item.meta = { ...item.meta, ...patch.meta };
  }
  await persist();
  return item;
}

export async function deleteItem(playlistId, itemId) {
  const data = await load();
  const p = data.playlists.find((x) => x.id === playlistId);
  if (!p) return false;
  const before = p.items.length;
  p.items = p.items.filter((i) => i.id !== itemId);
  await persist();
  return p.items.length < before;
}

export async function findItem(itemId) {
  const data = await load();
  for (const p of data.playlists) {
    const item = p.items.find((i) => i.id === itemId);
    if (item) return { playlist: p, item };
  }
  return null;
}

// ---- Saved iframe embeds ----

export async function listSavedEmbeds() {
  const data = await load();
  return data.savedEmbeds;
}

export async function addSavedEmbed({ title, src, code, height, savedAt }) {
  const data = await load();
  const normalizedCode = String(code || "").trim();
  const existing = data.savedEmbeds.find((embed) => embed.code === normalizedCode);
  if (existing) return { ...existing, duplicate: true };
  const embed = {
    id: id(),
    title: String(title || "Embedded player").slice(0, 300),
    src: String(src || "").slice(0, 4096),
    code: normalizedCode.slice(0, 65536),
    height: String(height || "70vh").slice(0, 64),
    savedAt: Number.isFinite(Date.parse(savedAt)) ? new Date(savedAt).toISOString() : new Date().toISOString(),
  };
  data.savedEmbeds.unshift(embed);
  await persist();
  return embed;
}

export async function deleteSavedEmbed(embedId) {
  const data = await load();
  const before = data.savedEmbeds.length;
  data.savedEmbeds = data.savedEmbeds.filter((embed) => embed.id !== embedId);
  if (data.savedEmbeds.length === before) return false;
  await persist();
  return true;
}

// ---- YouTube watch history recorded by this web app ----

export async function listWatchHistory() {
  const data = await load();
  return data.watchHistory;
}

export async function recordWatchHistory(entry) {
  const data = await load();
  const url = canonicalUrl(entry?.url);
  const youtubeId = canonicalYoutubeId(entry);
  if (!url && !youtubeId) throw new Error("video url required");
  const now = Date.now();
  const key = youtubeId || url;
  const existingIndex = data.watchHistory.findIndex((item) => (item.youtubeId || item.url) === key || (youtubeId && item.youtubeId === youtubeId));
  const previous = existingIndex >= 0 ? data.watchHistory.splice(existingIndex, 1)[0] : null;
  const item = {
    id: youtubeId || previous?.id || id(),
    youtubeId,
    title: String(entry?.title || previous?.title || "YouTube").slice(0, 300),
    url: url || previous?.url || (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : ""),
    thumbnail: String(entry?.thumbnail || previous?.thumbnail || "").slice(0, 4096),
    channelTitle: String(entry?.channelTitle || entry?.uploader || previous?.channelTitle || "").slice(0, 300),
    duration: Number.isFinite(Number(entry?.duration)) ? Number(entry.duration) : previous?.duration || null,
    isLive: Boolean(entry?.isLive),
    source: String(entry?.source || previous?.source || "webapp").slice(0, 80),
    firstPlayedAt: previous?.firstPlayedAt || now,
    lastPlayedAt: now,
    playCount: (previous?.playCount || 0) + 1,
  };
  data.watchHistory.unshift(item);
  data.watchHistory = data.watchHistory.slice(0, MAX_WATCH_HISTORY);
  await persist();
  return item;
}

export async function deleteWatchHistoryEntry(entryId) {
  const data = await load();
  const before = data.watchHistory.length;
  data.watchHistory = data.watchHistory.filter((entry) => entry.id !== entryId && entry.youtubeId !== entryId);
  if (data.watchHistory.length === before) return false;
  await persist();
  return true;
}

export async function clearWatchHistory() {
  const data = await load();
  data.watchHistory = [];
  await persist();
}

// ---- Browser renderer history ----

export async function listBrowserHistory() {
  const data = await load();
  return data.browserHistory.map((item) => ({
    ...item,
    title: browserHistoryTitle(item, null, item.url),
  }));
}

export async function recordBrowserHistory(entry) {
  const data = await load();
  const url = canonicalUrl(entry?.url);
  if (!url) throw new Error("browser url required");
  const now = Date.now();
  const existingIndex = data.browserHistory.findIndex((item) => canonicalUrl(item.url) === url);
  const previous = existingIndex >= 0 ? data.browserHistory.splice(existingIndex, 1)[0] : null;
  const item = {
    id: previous?.id || id(),
    title: browserHistoryTitle(entry, previous, url),
    url,
    firstOpenedAt: previous?.firstOpenedAt || now,
    lastOpenedAt: now,
    openCount: (previous?.openCount || 0) + 1,
  };
  data.browserHistory.unshift(item);
  data.browserHistory = data.browserHistory.slice(0, MAX_BROWSER_HISTORY);
  await persist();
  return item;
}

export async function deleteBrowserHistoryEntry(entryId) {
  const data = await load();
  const before = data.browserHistory.length;
  data.browserHistory = data.browserHistory.filter((entry) => entry.id !== entryId);
  if (data.browserHistory.length === before) return false;
  await persist();
  return true;
}

export async function clearBrowserHistory() {
  const data = await load();
  data.browserHistory = [];
  await persist();
}
