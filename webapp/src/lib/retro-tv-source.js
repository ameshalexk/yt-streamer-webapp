// Independent Retro TV feed adapter. Uses the documented Orphaned Films TV feed,
// not Spelunkr's unpublished/proprietary channel schedule.
export const RETRO_FEED_URL = "https://www.orphanedfilms.com/api/tv";
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 45_000;

export function archiveVideoUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!["archive.org", "www.archive.org"].includes(url.hostname)) return null;
    if (!url.pathname.startsWith("/download/") || url.pathname.length < 14) return null;
    return url.href;
  } catch { return null; }
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeRetroGuide(data, at = Date.now()) {
  if (!Array.isArray(data?.channels)) throw new Error("Retro TV guide has no channel list");
  const channels = [];
  for (const candidate of data.channels.slice(0, 100)) {
    const live = candidate?.now;
    const film = live?.film;
    const url = archiveVideoUrl(film?.url);
    const id = String(candidate?.id || "");
    if (!url || !/^[a-z0-9][a-z0-9_-]{0,70}$/i.test(id)) continue;
    const duration = Math.max(1, finiteNumber(film.seconds, 1));
    const startsAt = finiteNumber(live.startsAt, at);
    const endsAt = finiteNumber(live.endsAt, startsAt + duration * 1000);
    const offset = Math.max(0, Math.min(duration - 0.1,
      finiteNumber(live.offset) + Math.max(0, at - finiteNumber(data.now, at)) / 1000));
    // Do not serve an expired slot. The caller can refresh the guide after rollover.
    if (endsAt > 0 && at >= endsAt) continue;
    channels.push({
      id, number: Math.max(1, Math.min(999, Math.floor(finiteNumber(candidate.number, channels.length + 1)))),
      name: String(candidate.name || id).slice(0, 100),
      blurb: String(candidate.blurb || "").slice(0, 250),
      now: {
        id: String(film.id || "").slice(0, 140),
        title: String(film.title || "Untitled film").slice(0, 200),
        poster: typeof film.poster === "string" && /^https:\/\//.test(film.poster) ? film.poster : null,
        url, offset, duration, startsAt, endsAt,
      },
      programmes: Array.isArray(candidate.programmes) ? candidate.programmes.slice(0, 10).map(p => ({
        title: String(p?.title || "").slice(0, 180),
        startsAt: finiteNumber(p?.startsAt),
      })) : [],
    });
  }
  return { fetchedAt: at, source: "Orphaned Films", channels };
}

export function createRetroTvSource({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cached = null;
  let inFlight = null;
  async function read({ refresh = false } = {}) {
    const at = now();
    if (!refresh && cached && at - cached.fetchedAt < CACHE_MS) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await fetchImpl(RETRO_FEED_URL, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok || !response.body) throw new Error("Retro TV guide unavailable");
      const chunks = []; let bytes = 0;
      for await (const part of response.body) {
        bytes += part.byteLength;
        if (bytes > MAX_FEED_BYTES) throw new Error("Retro TV guide too large");
        chunks.push(part);
      }
      const buffer = new Uint8Array(bytes); let pos = 0;
      for (const part of chunks) { buffer.set(part, pos); pos += part.byteLength; }
      const value = normalizeRetroGuide(JSON.parse(new TextDecoder().decode(buffer)), now());
      cached = value;
      return value;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  return { read };
}
