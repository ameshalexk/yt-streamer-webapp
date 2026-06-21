import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import * as ytdlp from "./ytdlp.js";

const ROOT = path.join(config.dataDir, "prepared-cache");
const TMP = path.join(config.dataDir, "prepared-tmp");
export const RETENTION_DAYS = config.prepared.retentionDays;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function normalizeId(value) {
  return String(value || "").replace(/[^-\w]/g, "").slice(0, 100);
}

async function ensureDirs() {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(TMP, { recursive: true });
}

export async function get(id) {
  const cleanId = normalizeId(id);
  if (!cleanId) return null;
  const dir = path.join(ROOT, cleanId);
  try {
    const info = JSON.parse(await fs.readFile(path.join(dir, "info.json"), "utf8"));
    const filePath = path.join(dir, info.fileName);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { ...info, id: cleanId, filePath, size: stat.size };
  } catch {
    return null;
  }
}

export async function statuses(ids = []) {
  const result = {};
  await Promise.all([...new Set(ids.map(normalizeId).filter(Boolean))].map(async (id) => {
    const item = await get(id);
    if (item) {
      result[id] = {
        status: "ready",
        preparedAt: item.preparedAt,
        expiresAt: item.preparedAt + RETENTION_MS,
        size: item.size,
      };
    }
  }));
  return result;
}

export async function prepare({ id, url, title, duration, thumbnail, onProgress } = {}) {
  if (!url) throw new Error("video url required");
  await ensureDirs();
  const cleanId = normalizeId(id);
  if (!cleanId) throw new Error("video id required");
  const existing = await get(cleanId);
  if (existing) return existing;

  const sessionDir = path.join(TMP, `${Date.now()}-${cleanId}`);
  await fs.mkdir(sessionDir, { recursive: true });
  try {
    onProgress?.(1);
    const { filePath } = await ytdlp.downloadToDirectory(url, {
      directory: sessionDir,
      maxHeight: config.prepared.maxHeight,
      outputTemplate: "video.%(ext)s",
      onProgress,
    });
    const fileName = path.basename(filePath);
    const preparedAt = Date.now();
    const info = {
      id: cleanId,
      title: String(title || cleanId),
      originalUrl: String(url),
      duration: Number(duration) || null,
      thumbnail: thumbnail || null,
      fileName,
      preparedAt,
    };
    await fs.writeFile(path.join(sessionDir, "info.json"), JSON.stringify(info, null, 2), "utf8");
    const finalDir = path.join(ROOT, cleanId);
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(sessionDir, finalDir);
    onProgress?.(100);
    return get(cleanId);
  } catch (err) {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function cleanupExpired(now = Date.now()) {
  await ensureDirs();
  const cutoff = now - RETENTION_MS;
  const removed = [];
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ROOT, entry.name);
    let preparedAt = 0;
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, "info.json"), "utf8"));
      preparedAt = Number(info.preparedAt) || 0;
    } catch {
      const stat = await fs.stat(dir).catch(() => null);
      preparedAt = stat?.mtimeMs || 0;
    }
    if (preparedAt && preparedAt <= cutoff) {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}
