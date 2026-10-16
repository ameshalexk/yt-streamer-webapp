// On-demand APNE HLS source availability: only validates links, never downloads
// episode media. A small serialized queue prevents bursts on the Mac mini.
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const MAX_RECORDS = 300;
const CACHE_TTL = { link: 4 * 3600000, unavailable: 2 * 3600000, error: 10 * 60000 };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

export function summarizeApneSourceError(error) {
  if (/Mediagraming HLS source was not found/i.test(String(error?.message || ""))) {
    return { state: "unavailable", detail: "Source video link missing. Recheck later." };
  }
  return { state: "error", detail: "Source check failed; try again later." };
}

export async function validateApneSourceManifest({ hlsUrl, referer }, fetchImpl = fetch) {
  const response = await fetchImpl(hlsUrl, {
    headers: { Referer: referer, "User-Agent": UA, Accept: "application/vnd.apple.mpegurl,*/*" },
    redirect: "manual", signal: AbortSignal.timeout(14000),
  });
  if (!response.ok || response.status >= 300 || response.redirected ||
      Number(response.headers.get("content-length")) > 1024 * 1024) {
    try { await response.body?.cancel(); } catch {}
    throw new Error("HLS manifest unreachable");
  }
  let content = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No HLS playlist returned");
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("HLS manifest exceeds size limit");
      content += decoder.decode(value, {stream:true});
    }
    content += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch {}
  }
  if (!content.trimStart().startsWith("#EXTM3U") ||
      !/#EXTINF:|#EXT-X-STREAM-INF:/.test(content)) throw new Error("No playable HLS playlist returned");
  return true;
}

export function createApneSourceAvailability({ cacheFile, resolveEpisode, validateManifest = validateApneSourceManifest,
  now = Date.now } = {}) {
  if (!cacheFile || typeof resolveEpisode !== "function") throw new Error("Availability storage and resolver required");
  const entries = new Map();
  const pending = new Map();
  let loading = null, worker = Promise.resolve(), writes = Promise.resolve();
  const cacheKey = (showId, dateKey) => `${showId}:${dateKey}`;
  const sourceFingerprint = url => crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 20);

  function load() {
    // All concurrent API status requests must see the same hydrated cache.
    if (!loading) loading = (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
        if (raw?.version !== 3 || !Array.isArray(raw.entries)) return;
        for (const [key, record] of raw.entries.slice(-MAX_RECORDS)) {
          if (typeof key === "string" && /^[a-z0-9-]+:\d{4}-\d{2}-\d{2}$/.test(key) &&
              CACHE_TTL[record?.state] && Number.isFinite(record?.checkedAt) &&
              /^[a-f0-9]{20}$/.test(record?.fingerprint || "")) entries.set(key, record);
        }
      } catch (e) {
        if (e.code !== "ENOENT") console.warn("[apne-source] cache read failed", e.message);
      }
    })();
    return loading;
  }

  function visibleEntry(showId, dateKey, episodeUrl) {
    const key = cacheKey(showId, dateKey);
    const record = entries.get(key);
    if (!record || record.fingerprint !== sourceFingerprint(episodeUrl) ||
        now() - record.checkedAt >= CACHE_TTL[record.state] || now() < record.checkedAt) return null;
    return { state: record.state, detail: record.detail, checkedAt: record.checkedAt, mode: record.mode || null };
  }

  async function get(showId, dateKey, episodeUrl) {
    await load();
    return visibleEntry(showId, dateKey, episodeUrl);
  }

  function save() {
    writes = writes.catch(() => {}).then(async () => {
      const newest = [...entries].sort((a,b) => a[1].checkedAt-b[1].checkedAt).slice(-MAX_RECORDS);
      await fs.mkdir(path.dirname(cacheFile), {recursive:true});
      const temporary = cacheFile + ".tmp";
      await fs.writeFile(temporary, JSON.stringify({version:3,entries:newest}), "utf8");
      await fs.rename(temporary, cacheFile);
    }).catch(e => console.warn("[apne-source] cache write failed", e.message));
    return writes;
  }

  async function check(showId, dateKey, episodeUrl, {force = false} = {}) {
    await load();
    if (!force) {
      const fresh = visibleEntry(showId, dateKey, episodeUrl);
      if (fresh) return fresh;
    }
    const key = cacheKey(showId, dateKey);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 12) throw Object.assign(new Error("Too many pending source checks."), { status:429 });
    const run = worker.catch(() => {}).then(async () => {
      let result;
      try {
        const stream = await resolveEpisode(episodeUrl, {showId,dateKey});
        if (stream.format === "embed" && Array.isArray(stream.embedUrls) && stream.embedUrls.length >= 1 && stream.embedUrls.length <= 4) {
          result = {state:"link",detail:"Video available for streaming.",mode:"embed"};
        } else if (stream.mp4Url) {
          // Alternate MP4 was already checked with a bounded Range GET by the
          // resolver; no full episode is fetched or downloaded here.
          result = {state:"link",detail:"Video available for streaming.",mode:"mp4"};
        } else {
          await validateManifest(stream);
          result = {state:"link",detail:"Video available for streaming.",mode:"hls"};
        }
      } catch (error) { result = summarizeApneSourceError(error); }
      const record = {...result, checkedAt:now(), fingerprint:sourceFingerprint(episodeUrl)};
      entries.set(key, record);
      if (entries.size > MAX_RECORDS) {
        const oldest = [...entries].sort((a,b) => a[1].checkedAt-b[1].checkedAt).slice(0,entries.size-MAX_RECORDS);
        for (const [oldKey] of oldest) entries.delete(oldKey);
      }
      await save();
      return {state:record.state,detail:record.detail,checkedAt:record.checkedAt,mode:record.mode||null};
    });
    worker = run.catch(() => {});
    pending.set(key, run);
    try { return await run; } finally { if (pending.get(key) === run) pending.delete(key); }
  }
  return {get,check,pendingCount:()=>pending.size};
}
