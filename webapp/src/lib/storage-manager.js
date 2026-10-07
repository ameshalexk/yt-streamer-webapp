import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import * as processedLibrary from "./processed-library.js";
import * as processedDashCache from "./processed-dash-cache.js";

const DEFAULT_POLICY = Object.freeze({ enabled: false, watchedRetentionDays: 30 });
const MAX_RETENTION_DAYS = 3650;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function normalizedId(value) {
  const id = String(value ?? "");
  return /^[\w.-]{1,100}$/.test(id) && id !== "." && id !== ".."
    && !["__proto__", "prototype", "constructor"].includes(id) ? id : "";
}

function within(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function treeBytes(target) {
  let stat;
  try { stat = await fs.lstat(target); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    total += await treeBytes(path.join(target, entry.name));
  }
  return total;
}

export function createStorageManager({
  dataDir = config.dataDir,
  libraryDir = config.libraryDir,
  policyFile = path.join(dataDir, "storage-policy.json"),
  processedRoot = path.join(dataDir, "processed-library"),
  cacheRoots = [path.join(dataDir, "prepared-cache"), path.join(dataDir, "prepared-tmp"),
    path.join(dataDir, "processed-dash-cache"), path.join(dataDir, "processed-dash-tmp")],
  processedDashRoot = path.join(dataDir, "processed-dash-cache"),
  listDownloads = processedLibrary.list,
  removeDownload = processedLibrary.remove,
  removeCache = processedDashCache.remove,
  now = () => Date.now(),
} = {}) {
  const dataRoot = path.resolve(dataDir);
  const libraryRoot = path.resolve(libraryDir);
  const downloadRoot = path.resolve(processedRoot);
  const policyPath = path.resolve(policyFile);
  const caches = cacheRoots.map((root) => path.resolve(root));
  const dashRoot = path.resolve(processedDashRoot);
  let statePromise;
  let writeChain = Promise.resolve();
  let operationChain = Promise.resolve();

  function serialize(operation) {
    const result = operationChain.then(operation);
    operationChain = result.catch(() => {});
    return result;
  }

  async function readState() {
    try {
      const saved = JSON.parse(await fs.readFile(policyPath, "utf8"));
      const storedPolicy = saved.policy && typeof saved.policy === "object" ? saved.policy : saved;
      const policy = {
        enabled: storedPolicy.enabled === true,
        watchedRetentionDays: Number.isInteger(storedPolicy.watchedRetentionDays) && storedPolicy.watchedRetentionDays >= 1
          && storedPolicy.watchedRetentionDays <= MAX_RETENTION_DAYS ? storedPolicy.watchedRetentionDays : DEFAULT_POLICY.watchedRetentionDays,
      };
      const downloads = Object.create(null);
      if (saved.downloads && typeof saved.downloads === "object" && !Array.isArray(saved.downloads)) {
        for (const [id, entry] of Object.entries(saved.downloads)) {
          if (normalizedId(id) && entry && typeof entry === "object") downloads[id] = {
            pinned: entry.pinned === true,
            watchedAt: Number.isFinite(entry.watchedAt) && entry.watchedAt > 0 ? entry.watchedAt : null,
          };
        }
      }
      return { policy, downloads };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { policy: { ...DEFAULT_POLICY }, downloads: Object.create(null) };
    }
  }

  function state() {
    if (!statePromise) {
      statePromise = readState().catch((error) => {
        statePromise = undefined;
        throw error;
      });
    }
    return statePromise;
  }

  async function commit(next) {
    const write = writeChain.then(async () => {
      await fs.mkdir(path.dirname(policyPath), { recursive: true });
      const tmp = `${policyPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify({ ...next.policy, downloads: next.downloads }, null, 2), { encoding: "utf8", flag: "wx" });
        await fs.rename(tmp, policyPath);
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
      statePromise = Promise.resolve(next);
    });
    writeChain = write.catch(() => {});
    return write;
  }

  async function safeItemDirectory(id) {
    const directory = path.resolve(downloadRoot, id);
    if (!within(downloadRoot, directory) || directory === downloadRoot) return null;
    try {
      const [rootStat, itemStat] = await Promise.all([fs.lstat(downloadRoot), fs.lstat(directory)]);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !itemStat.isDirectory() || itemStat.isSymbolicLink()) return null;
      const realRoot = await fs.realpath(downloadRoot);
      const realItem = await fs.realpath(directory);
      return within(realRoot, realItem) && realItem !== realRoot ? directory : null;
    } catch { return null; }
  }

  async function safeDashCachePath(id) {
    const directory = path.resolve(dashRoot, id);
    if (!within(dashRoot, directory) || directory === dashRoot) return false;
    async function safeExistingAncestors() {
      let cursor = dashRoot;
      let dataRootExists = false;
      while (within(dataRoot, cursor)) {
        try {
          const stat = await fs.lstat(cursor);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
          if (cursor === dataRoot) dataRootExists = true;
        } catch (error) { if (error.code !== "ENOENT") return false; }
        if (cursor === dataRoot) return dataRootExists;
        const parent = path.dirname(cursor);
        if (parent === cursor || !within(dataRoot, parent)) return false;
        cursor = parent;
      }
      return false;
    }
    try {
      const [rootStat, itemStat] = await Promise.all([fs.lstat(dashRoot), fs.lstat(directory)]);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
      if (itemStat.isSymbolicLink() || !itemStat.isDirectory()) return false;
      return within(await fs.realpath(dashRoot), await fs.realpath(directory));
    } catch (error) {
      if (error.code === "ENOENT") {
        return safeExistingAncestors();
      }
      return false;
    }
  }

  async function summary() {
    const [downloads, saved, libraryBytes, cacheBytes] = await Promise.all([
      listDownloads(), state(), treeBytes(libraryRoot), Promise.all(caches.map(treeBytes)).then((values) => values.reduce((a, b) => a + b, 0)),
    ]);
    const rows = [];
    for (const item of downloads) {
      const id = normalizedId(item?.id);
      if (!id || !await safeItemDirectory(id)) continue;
      const bytes = await treeBytes(path.join(downloadRoot, id));
      const meta = saved.downloads[id] || {};
      rows.push({ id, title: String(item.title || id), pinned: meta.pinned === true, watchedAt: meta.watchedAt || null, bytes });
    }
    let freeBytes = null;
    let totalCapacity = null;
    try {
      const stat = await fs.statfs(libraryRoot);
      freeBytes = Number(stat.bavail) * Number(stat.bsize);
      totalCapacity = Number(stat.blocks) * Number(stat.bsize);
    } catch {}
    return { libraryBytes: libraryBytes + rows.reduce((sum, row) => sum + row.bytes, 0), cacheBytes, freeBytes,
      totalBytes: totalCapacity,
      policy: { ...saved.policy }, downloads: rows.sort((a, b) => a.title.localeCompare(b.title)) };
  }

  function setPolicy(input) { return serialize(async () => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Object.keys(input).some((key) => !["enabled", "watchedRetentionDays"].includes(key))
      || (Object.hasOwn(input, "enabled") && typeof input.enabled !== "boolean")
      || (Object.hasOwn(input, "watchedRetentionDays") && (!Number.isInteger(input.watchedRetentionDays)
        || input.watchedRetentionDays < 1 || input.watchedRetentionDays > MAX_RETENTION_DAYS))) {
      const error = new Error("policy accepts enabled:boolean and watchedRetentionDays:integer (1-3650)"); error.status = 400; throw error;
    }
    const current = await state();
    const next = { ...current, policy: { ...current.policy, ...input } };
    await commit(next);
    return { ...next.policy };
  }); }

  async function updateDownload(idValue, update) {
    const id = normalizedId(idValue);
    if (!id) { const error = new Error("invalid download id"); error.status = 400; throw error; }
    const item = (await listDownloads()).find((entry) => entry.id === id);
    if (!item || !await safeItemDirectory(id)) { const error = new Error("processed download not found"); error.status = 404; throw error; }
    const current = await state();
    const nextDownloads = Object.assign(Object.create(null), current.downloads);
    nextDownloads[id] = { pinned: false, watchedAt: null, ...current.downloads[id], ...update };
    const next = { ...current, downloads: nextDownloads };
    await commit(next);
    return { id, ...next.downloads[id] };
  }

  function setPinned(id, pinned) {
    if (typeof pinned !== "boolean") { const error = new Error("pinned must be a boolean"); error.status = 400; throw error; }
    return serialize(() => updateDownload(id, { pinned }));
  }

  function markWatched(id) { return serialize(() => updateDownload(id, { watchedAt: now() })); }

  function cleanup(options = {}, runtime = {}) { return serialize(async () => {
    const { apply = false, ids } = options || {};
    const { busy = false } = runtime || {};
    if (typeof apply !== "boolean" || typeof busy !== "boolean"
      || (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => !normalizedId(id))))) {
      const error = new Error("cleanup requires apply:boolean and at most 1000 valid IDs"); error.status = 400; throw error;
    }
    const saved = await state();
    if (apply && !Array.isArray(ids)) { const error = new Error("apply cleanup requires the selected preview ids"); error.status = 400; throw error; }
    if (apply && !saved.policy.enabled) { const error = new Error("watched-download cleanup is disabled"); error.status = 409; throw error; }
    if (apply && busy) { const error = new Error("cleanup unavailable while server jobs are active"); error.status = 409; throw error; }
    const selected = ids ? new Set(ids.map(normalizedId)) : null;
    const cutoff = now() - saved.policy.watchedRetentionDays * 86400000;
    const candidates = [];
    for (const item of await listDownloads()) {
      const id = normalizedId(item?.id);
      if (!id || (selected && !selected.has(id))) continue;
      const meta = saved.downloads[id] || {};
      if (meta.pinned || !meta.watchedAt || meta.watchedAt > cutoff || !await safeItemDirectory(id)
        || !await safeDashCachePath(id)) continue;
      candidates.push({
        id,
        title: String(item.title || id),
        bytes: await treeBytes(path.join(downloadRoot, id)),
        cacheBytes: await treeBytes(path.join(dashRoot, id)),
        watchedAt: meta.watchedAt,
      });
    }
    if (!apply) return { applied: false, eligible: candidates };
    const removed = [];
    for (const candidate of candidates) {
      const stillExists = (await listDownloads()).some((item) => item.id === candidate.id);
      if (!stillExists || !await safeItemDirectory(candidate.id) || !await safeDashCachePath(candidate.id)) continue;
      await removeDownload(candidate.id);
      await removeCache(candidate.id);
      removed.push(candidate);
    }
    if (removed.length) {
      const fresh = await state();
      const nextDownloads = Object.assign(Object.create(null), fresh.downloads);
      for (const item of removed) delete nextDownloads[item.id];
      await commit({ ...fresh, downloads: nextDownloads });
    }
    return {
      applied: true,
      removed,
      reclaimedBytes: removed.reduce((total, item) => total + item.bytes, 0),
      reclaimedCacheBytes: removed.reduce((total, item) => total + item.cacheBytes, 0),
    };
  }); }

  return { summary, setPolicy, setPinned, markWatched, cleanup };
}

const manager = createStorageManager();
export const summary = (...args) => manager.summary(...args);
export const setPolicy = (...args) => manager.setPolicy(...args);
export const setPinned = (...args) => manager.setPinned(...args);
export const markWatched = (...args) => manager.markWatched(...args);
export const cleanup = (...args) => manager.cleanup(...args);
