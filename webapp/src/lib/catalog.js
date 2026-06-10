// Built-in IPTV catalog: fetch + parse extended M3U playlists (iptv-org), cache, search.
import { config } from "../config.js";

const cache = new Map(); // key -> { at, channels }
let countriesCache = null; // { at, sources }
const pinnedGroupOrder = ["news", "movies"];

function cleanCountryName(name, code) {
  return String(name || code || "Unknown").replace(/\s*\([A-Z]{2}\)\s*$/i, "").trim() || "Unknown";
}

function countryPlaylistUrl(code) {
  return `${config.catalog.countryPlaylistBaseUrl}/${code.toLowerCase()}.m3u`;
}

async function listCountrySources() {
  if (countriesCache && Date.now() - countriesCache.at < config.catalog.cacheTtlMs) return countriesCache.sources;

  const res = await fetch(config.catalog.countriesUrl, {
    headers: { "User-Agent": "Mozilla/5.0 yt-streamer" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`countries fetch failed: HTTP ${res.status}`);

  const countries = await res.json();
  const priority = new Map([["US", 0], ["IN", 1]]);
  const sources = countries
    .filter((c) => /^[a-z]{2}$/i.test(c.code || "") && c.name)
    .sort((a, b) => {
      const ap = priority.get(String(a.code || "").toUpperCase()) ?? 99;
      const bp = priority.get(String(b.code || "").toUpperCase()) ?? 99;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .map((c) => ({
      id: `country:${c.code.toLowerCase()}`,
      name: `${c.name} (${c.code.toUpperCase()})`,
      group: "Countries",
      url: countryPlaylistUrl(c.code),
      countryCode: c.code.toUpperCase(),
      countryName: cleanCountryName(c.name, c.code),
    }));

  countriesCache = { at: Date.now(), sources };
  return sources;
}

export async function listSources() {
  const baseSources = config.catalog.sources.map(({ id, name, group = "Catalog", url }) => ({ id, name, group, url }));
  try {
    return [...baseSources, ...(await listCountrySources())];
  } catch (err) {
    console.warn("[catalog] could not load countries:", err.message);
    return baseSources;
  }
}

function sourceUrl(srcIdOrUrl) {
  const found = config.catalog.sources.find((s) => s.id === srcIdOrUrl);
  if (found) return { key: found.id, url: found.url, category: found.id === "all" ? "" : found.name };
  const country = String(srcIdOrUrl || "").match(/^country:([a-z]{2})$/i);
  if (country) {
    const code = country[1].toLowerCase();
    return { key: `country:${code}`, url: countryPlaylistUrl(code), countryCode: code.toUpperCase() };
  }
  const legacyCountry = String(srcIdOrUrl || "").match(/^[a-z]{2}$/i);
  if (legacyCountry) {
    const code = legacyCountry[0].toLowerCase();
    return { key: `country:${code}`, url: countryPlaylistUrl(code), countryCode: code.toUpperCase() };
  }
  // Allow an arbitrary M3U URL too (http/https only).
  if (/^https?:\/\//i.test(srcIdOrUrl)) return { key: srcIdOrUrl, url: srcIdOrUrl };
  return null;
}

function attr(line, name) {
  const m = line.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

function groupRank(group) {
  const normalized = String(group || "").trim().toLowerCase();
  const tokens = normalized.split(";").map((token) => token.trim()).filter(Boolean);
  const exact = pinnedGroupOrder.indexOf(normalized);
  if (exact >= 0) return exact * 3;
  const firstToken = pinnedGroupOrder.indexOf(tokens[0]);
  if (firstToken >= 0) return firstToken * 3 + 1;
  const matchingToken = pinnedGroupOrder.findIndex((pinned) => tokens.includes(pinned));
  if (matchingToken >= 0) return matchingToken * 3 + 2;
  return pinnedGroupOrder.length * 3;
}

export function sortChannelGroups(groups) {
  return [...groups].sort((a, b) => {
    const rankDiff = groupRank(a) - groupRank(b);
    return rankDiff || String(a || "").localeCompare(String(b || ""));
  });
}

// Parse extended M3U text into channel objects.
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let cur = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const name = line.slice(line.lastIndexOf(",") + 1).trim();
      cur = {
        name: name || "Unknown",
        group: attr(line, "group-title") || "Other",
        logo: attr(line, "tvg-logo") || "",
        tvgId: attr(line, "tvg-id") || "",
        country: attr(line, "tvg-country") || attr(line, "country") || "",
        url: "",
        userAgent: "",
        referer: "",
      };
    } else if (line.startsWith("#EXTVLCOPT") && cur) {
      // e.g. #EXTVLCOPT:http-user-agent=Mozilla / http-referrer=https://...
      const v = line.split("=").slice(1).join("=").trim();
      if (/user-agent/i.test(line)) cur.userAgent = v;
      else if (/referrer|referer/i.test(line)) cur.referer = v;
    } else if (line.startsWith("#")) {
      continue;
    } else if (cur) {
      cur.url = line;
      if (cur.url) channels.push(cur);
      cur = null;
    }
  }
  return channels;
}

// Decide whether M3U text is a single playable stream (HLS manifest) or an
// aggregator playlist listing many channels. Pure function (offline-testable).
export function classifyPlaylist(text) {
  // HLS manifests (master or media) are themselves playable -> single stream.
  if (/#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|ENDLIST|PLAYLIST-TYPE|VERSION)/i.test(text)) {
    return { type: "stream" };
  }
  const channels = parseM3U(text);
  const named = channels.filter((c) => c.name && c.name !== "Unknown" && c.url);
  if (named.length >= 1) return { type: "channels", channels };
  return { type: "stream" };
}

// Fetch a URL and classify it. Channel lists are cached so a follow-up
// getChannels(url) is instant.
export async function inspectUrl(url) {
  if (!/^https?:\/\//i.test(url)) return { type: "stream" }; // file paths just play
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 yt-streamer" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  const text = await res.text();
  // Binary/video content-type with no M3U body -> definitely a direct stream.
  if (!/#EXTM3U/i.test(text) && !/mpegurl/i.test(ctype)) return { type: "stream" };
  const result = classifyPlaylist(text);
  if (result.type === "channels") {
    cache.set(url, { at: Date.now(), channels: result.channels });
    return { type: "channels", total: result.channels.length };
  }
  return { type: "stream" };
}

async function loadChannels(key, url) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.catalog.cacheTtlMs) return hit.channels;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 yt-streamer" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const channels = parseM3U(text);
  cache.set(key, { at: Date.now(), channels });
  return channels;
}

// Search/filter/paginate a source. Returns { total, groups, channels }.
export async function getChannels(srcIdOrUrl, { q = "", group = "", limit = 200, offset = 0 } = {}) {
  const src = sourceUrl(srcIdOrUrl);
  if (!src) throw new Error("unknown catalog source");
  const all = await loadChannels(src.key, src.url);

  const groups = sortChannelGroups(new Set(all.map((c) => c.group)));

  const needle = q.trim().toLowerCase();
  let filtered = all;
  if (group) filtered = filtered.filter((c) => c.group === group);
  if (needle) filtered = filtered.filter((c) => c.name.toLowerCase().includes(needle));

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit).map((c, i) => ({
    idx: offset + i,
    name: c.name,
    group: c.group,
    category: c.group,
    country: c.country || src.countryCode || "",
    sourceCategory: src.category || "",
    logo: c.logo,
    url: c.url,
    userAgent: c.userAgent || "",
    referer: c.referer || "",
  }));
  return { total, groups, channels: page };
}

export function clearCache() {
  cache.clear();
}
