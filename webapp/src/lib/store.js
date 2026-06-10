// Server-side JSON store for playlists + their items (m3u8 streams and YouTube refs).
// Single-user, so a simple file with a serialized write queue is plenty.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

const STORE_FILE = path.join(config.dataDir, "store.json");

const DEFAULT_DATA = { version: 1, playlists: [] };

let cache = null;
let writeChain = Promise.resolve();

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function canonicalUrl(url) {
  return String(url || "").trim();
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
