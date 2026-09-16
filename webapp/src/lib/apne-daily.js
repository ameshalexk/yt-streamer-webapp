import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import * as store from "./store.js";

const APNE_ORIGIN = "https://apnetv.xyz";
const SHOWS_FILE = path.join(config.dataDir, "apne-daily-shows.json");
const LOG_FILE = path.join(config.dataDir, "apne-daily.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const APNE_HISTORY_MONTHS = 3;
const APNE_HISTORY_FETCH_LIMIT = 250;
const APNE_HISTORY_PAGE_SIZE = 10;
const EPISODE_METADATA_CACHE_MS = 30 * 60 * 1000;
const SKY_EPISODE_METADATA_URLS = {
  anupamaa: "https://www.sky.com/watch/series/16f8285a-09c0-4b5b-812b-12c154d2c9f4/season-1",
};
const ACTOR_AGE_CHECK_EPISODE_METADATA_URLS = {
  anupamaa: "https://actoragecheck.com/tv/Anupamaa/116479/season/1",
};
const ANUPAMAA_EPISODE_TITLE_OVERRIDES = {
  2134: "Hasmukh Risks the Shah House",
  2135: "Anupama Refuses Hasmukh's Help",
  2136: "Paritosh's Truth Breaks Anupama",
  2137: "Anupama Guides Rahi",
  2138: "Leela Eyes the Shah House",
  2139: "Ansh, Prerana Share Their Plans",
  2140: "Anupama Gets Scammed!",
  2141: "Anupama Vows to Fight for Justice",
  2142: "Rahi and Anupama Remember Anuj",
};
const episodeMetadataCache = new Map();
const DEFAULT_SHOWS = [{
  id: "anupamaa",
  name: "Anupamaa",
  url: "https://apnetv.xyz/Hindi-Serial/Anupamaa",
  builtIn: true,
}];

const jobs = new Map();

function jobKey(showId, dateKey) {
  return `${showId}:${dateKey}`;
}

function hostOf(value) {
  try { return new URL(String(value || "")).hostname; } catch { return ""; }
}

async function writeApneLog(event, fields = {}) {
  const entry = { ts: new Date().toISOString(), event, ...fields };
  const line = JSON.stringify(entry) + "\n";
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    try {
      const stat = await fs.stat(LOG_FILE);
      if (stat.size >= LOG_MAX_BYTES) {
        await fs.rm(`${LOG_FILE}.1`, { force: true }).catch(() => {});
        await fs.rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => {});
      }
    } catch {}
    await fs.appendFile(LOG_FILE, line, "utf8");
  } catch (error) {
    console.warn("[apne-daily] log write failed:", error.message);
  }
  const consoleFields = { ...fields };
  delete consoleFields.ffmpegTail;
  console.log(`[apne-daily] ${event}`, consoleFields);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dateKeyFromParts(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseApneDateLabel(label) {
  const clean = stripTags(label).replace(/(\d+)(?:st|nd|rd|th)\b/i, "$1").replace(/\s+/g, " ").trim();
  const match = clean.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = monthNames.indexOf(match[2].toLowerCase()) + 1;
  if (!month) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || day < 1 || day > 31 || year < 2000) return null;
  return { label: stripTags(label), key: dateKeyFromParts(year, month, day), year, month, day };
}

function todayKey(timeZone = "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function showIdFromUrl(url) {
  const parsed = new URL(url);
  const slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "");
  const value = normalized(slug).replace(/\s+/g, "-").slice(0, 80);
  return value || crypto.randomBytes(5).toString("hex");
}

function titleFromSlug(slug) {
  return decodeURIComponent(slug || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeApneShowInput(rawUrl, rawName = "") {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw httpError(400, "Enter a valid APNE TV show URL.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== "apnetv.xyz" && !hostname.endsWith(".apnetv.xyz")) {
    throw httpError(400, "Show URL must be on apnetv.xyz.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== "hindi-serial") throw httpError(400, "Use an APNE Hindi Serial show URL.");
  let slug = "";
  if (parts[1]?.toLowerCase() === "show" && parts[3]) slug = parts[3];
  else if (parts[1] && parts[1].toLowerCase() !== "episodes") slug = parts[1];
  if (!slug) throw httpError(400, "Could not identify the APNE show from that URL.");
  const url = `${APNE_ORIGIN}/Hindi-Serial/${encodeURIComponent(decodeURIComponent(slug))}`;
  return {
    id: showIdFromUrl(url),
    name: String(rawName || "").trim().slice(0, 120) || titleFromSlug(slug),
    url,
    builtIn: false,
  };
}

async function loadShows() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(SHOWS_FILE, "utf8"));
    const items = Array.isArray(parsed?.shows) ? parsed.shows : [];
    const merged = [...DEFAULT_SHOWS];
    for (const item of items) {
      if (!item?.id || !item?.url || merged.some((show) => show.id === item.id)) continue;
      merged.push({ id: String(item.id), name: String(item.name || item.id), url: String(item.url), builtIn: false });
    }
    return merged;
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[apne-daily] could not read shows:", error.message);
    return [...DEFAULT_SHOWS];
  }
}

async function saveCustomShows(shows) {
  const custom = shows.filter((show) => !show.builtIn).map(({ id, name, url }) => ({ id, name, url }));
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${SHOWS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, shows: custom }, null, 2), "utf8");
  await fs.rename(tmp, SHOWS_FILE);
}

async function fetchText(url, { method = "GET", body = null, referer = APNE_ORIGIN + "/" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      "User-Agent": DESKTOP_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": referer,
    };
    if (body != null) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return { html: await response.text(), url: response.url };
  } finally {
    clearTimeout(timer);
  }
}

export function parseRecentEpisodesFromShowHtml(html, show = {}, limit = 10) {
  const pattern = /<option\b[^>]*value=["'][^"'<>]*#@#(https:\/\/apnetv\.xyz\/Hindi-Serial\/show\/\d+\/[^"'<>]+)["'][^>]*>([\s\S]*?)<\/option>/gi;
  const matches = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(pattern)) {
    const date = parseApneDateLabel(match[2]);
    if (!date) continue;
    const url = decodeHtml(match[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    matches.push({
      url,
      dateLabel: date.label,
      dateKey: date.key,
      title: `${show.name || "APNE"} ${date.label}`,
    });
  }
  if (!matches.length) throw new Error("APNE did not return any dated episodes for this show.");
  matches.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  const count = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(APNE_HISTORY_FETCH_LIMIT, Math.trunc(Number(limit)))) : 10;
  return matches.slice(0, count);
}

export function filterApneEpisodesByMonths(episodes, months = APNE_HISTORY_MONTHS) {
  const list = Array.isArray(episodes)
    ? episodes.filter((episode) => /^\d{4}-\d{2}-\d{2}$/.test(String(episode?.dateKey || "")))
    : [];
  if (!list.length) return [];
  const newest = list[0].dateKey;
  const parts = newest.split("-").map(Number);
  const cutoff = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - Math.max(1, Math.trunc(Number(months) || APNE_HISTORY_MONTHS)));
  const cutoffKey = [
    cutoff.getUTCFullYear(),
    String(cutoff.getUTCMonth() + 1).padStart(2, "0"),
    String(cutoff.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return list.filter((episode) => episode.dateKey >= cutoffKey);
}

export function parseLatestEpisodeFromShowHtml(html, show = {}) {
  return parseRecentEpisodesFromShowHtml(html, show, 1)[0];
}

function dateKeyInTimeZone(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return byType.year + "-" + byType.month + "-" + byType.day;
}

function decodeSkyJsonString(value) {
  try {
    return JSON.parse('"' + String(value || "") + '"');
  } catch {
    return String(value || "")
      .replace(/\u0026/gi, "&")
      .replace(/\"/g, '"')
  }
}

function usefulEpisodeTitle(title, showName = "") {
  const value = String(title || "").trim();
  if (!value) return "";
  if (value.length > 160 || /episodeNumber|synopsis|waysToWatch|__typename|\{\s*"/i.test(value)) return "";
  const normalizedTitle = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedShow = String(showName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalizedTitle === normalizedShow || normalizedTitle === "anupama" || normalizedTitle === "anupamaa") return "";
  if (/^episode\s+\d+$/i.test(value)) return "";
  if (/^(?:mon|tue|wed|thu|fri|sat|sun)\s*-\s*[a-z]{3}\s+\d{1,2},\s+\d{4}$/i.test(value)) return "";
  return value;
}

export function parseSkyEpisodeMetadata(html, showName = "Anupamaa") {
  const source = String(html || "");
  const pattern = /\\"episode\\":\{\\"uuid\\":\\"[^"]+\\",\\"title\\":\\"([\s\S]*?)\\",\\"episodeNumber\\":(\d+)([\s\S]{0,8000}?)\\"startTime\\":\\"([^"]+)\\"/g;
  const byDate = {};
  for (const match of source.matchAll(pattern)) {
    const episodeNumber = Number(match[2]);
    const dateKey = dateKeyInTimeZone(match[4], "Asia/Kolkata");
    if (!dateKey || !Number.isFinite(episodeNumber)) continue;
    const rawTitle = decodeSkyJsonString(match[1]);
    const episodeTitle = usefulEpisodeTitle(rawTitle, showName);
    const current = byDate[dateKey];
    const candidate = { episodeNumber, episodeTitle };
    if (!current || (!current.episodeTitle && candidate.episodeTitle)) byDate[dateKey] = candidate;
  }
  return byDate;
}

function dateKeyFromAirDateLabel(value) {
  const match = String(value || "").trim().match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})$/);
  if (!match) return "";
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const month = months[match[1]];
  if (!month) return "";
  return [match[3], String(month).padStart(2, "0"), String(Number(match[2])).padStart(2, "0")].join("-");
}

export function parseActorAgeCheckEpisodeMetadata(html, showName = "Anupamaa") {
  const source = String(html || "");
  const pattern = /<div class="movie episode">[\s\S]*?<a href="tv\/Anupamaa\/116479\/season\/1\/episode\/(\d+)"[^>]*title="Anupamaa - Season 1 - ([\s\S]*?) \(Episode \d+\)"[\s\S]*?<div class="release"><span class="seinfo">Episode Air Date: <\/span>([^<]+)<\/div><\/div>/g;
  const byDate = {};
  for (const match of source.matchAll(pattern)) {
    const episodeNumber = Number(match[1]);
    const dateKey = dateKeyFromAirDateLabel(decodeHtml(match[3]));
    if (!dateKey || !Number.isFinite(episodeNumber)) continue;
    const rawTitle = decodeHtml(match[2]);
    const episodeTitle = usefulEpisodeTitle(rawTitle, showName);
    byDate[dateKey] = { episodeNumber, episodeTitle };
  }
  return byDate;
}

function plusDaysDateKey(dateKey, days) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-");
}

async function episodeMetadataForShow(show) {
  const skyUrl = SKY_EPISODE_METADATA_URLS[show.id];
  const guideUrl = ACTOR_AGE_CHECK_EPISODE_METADATA_URLS[show.id];
  if (!skyUrl && !guideUrl) return {};
  const cached = episodeMetadataCache.get(show.id);
  if (cached && Date.now() - cached.at < EPISODE_METADATA_CACHE_MS) return cached.data;

  const fetchMetadataHtml = async (url) => {
    if (!url) return "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": DESKTOP_USER_AGENT,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP " + response.status + " from " + new URL(url).hostname);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const [skyHtml, guideHtml] = await Promise.all([
      fetchMetadataHtml(skyUrl).catch(() => ""),
      fetchMetadataHtml(guideUrl).catch(() => ""),
    ]);
    const skyByDate = skyHtml ? parseSkyEpisodeMetadata(skyHtml, show.name) : {};
    const guideByDate = guideHtml ? parseActorAgeCheckEpisodeMetadata(guideHtml, show.name) : {};
    const skyByNumber = {};
    for (const item of Object.values(skyByDate)) {
      if (item?.episodeNumber && (!skyByNumber[item.episodeNumber] || item.episodeTitle)) skyByNumber[item.episodeNumber] = item;
    }

    const merged = {};
    for (const [dateKey, item] of Object.entries(guideByDate)) {
      const overrideTitle = show.id === "anupamaa" ? ANUPAMAA_EPISODE_TITLE_OVERRIDES[item.episodeNumber] || "" : "";
      const skyTitle = skyByNumber[item.episodeNumber]?.episodeTitle || "";
      merged[dateKey] = {
        episodeNumber: item.episodeNumber,
        episodeTitle: overrideTitle || item.episodeTitle || skyTitle || "",
      };
    }

    // The full-season guide can lag the newest few episodes. Anupamaa airs daily,
    // so extend episode numbers only a few days beyond the newest confirmed guide date.
    if (show.id === "anupamaa") {
      const confirmedDates = Object.keys(guideByDate).sort();
      const latestConfirmedDate = confirmedDates.at(-1) || "";
      const latestConfirmedNumber = guideByDate[latestConfirmedDate]?.episodeNumber || 0;
      for (let offset = 1; offset <= 7 && latestConfirmedDate && latestConfirmedNumber; offset++) {
        const dateKey = plusDaysDateKey(latestConfirmedDate, offset);
        const episodeNumber = latestConfirmedNumber + offset;
        merged[dateKey] = {
          episodeNumber,
          episodeTitle: ANUPAMAA_EPISODE_TITLE_OVERRIDES[episodeNumber] || skyByNumber[episodeNumber]?.episodeTitle || "",
        };
      }
    }

    // Keep Sky-only dates as a final fallback, but never overwrite a guide-backed mapping.
    for (const [dateKey, item] of Object.entries(skyByDate)) {
      if (!merged[dateKey]) merged[dateKey] = item;
    }

    episodeMetadataCache.set(show.id, { at: Date.now(), data: merged });
    await writeApneLog("episode_metadata_ok", {
      showId: show.id,
      count: Object.keys(merged).length,
      guideCount: Object.keys(guideByDate).length,
      skyCount: Object.keys(skyByDate).length,
    });
    return merged;
  } catch (error) {
    await writeApneLog("episode_metadata_failed", { showId: show.id, error: error.message });
    return cached?.data || {};
  }
}

function readAttributes(tag) {
  const out = {};
  for (const match of String(tag || "").matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    out[match[1].toLowerCase()] = decodeHtml(match[3]);
  }
  return out;
}

export function parseFlashTargetFromEpisodeHtml(html) {
  for (const match of String(html || "").matchAll(/<div\b[^>]*>/gi)) {
    const attrs = readAttributes(match[0]);
    const classes = String(attrs.class || "").split(/\s+/);
    if (!classes.includes("flash_link")) continue;
    const href = String(attrs["data-href"] || "");
    const id = String(attrs["data-id"] || "");
    if (!id || !/^https:\/\/(?:www\.)?newsportaling\.com\/finnance-/i.test(href)) continue;
    return { id, href };
  }
  throw new Error("APNE Flash Link was not found for this episode.");
}

export function parseNewsportalingRedirect(html) {
  const source = String(html || "");
  const redirect = source.match(/myRedirect\(\s*["'](https:\/\/[^"']*mediagraming\.com\/[^"']+)["']\s*,\s*["']id["']\s*,\s*["']([^"']+)["']\s*\)/i);
  if (!redirect) throw new Error("Newsportaling did not expose the Mediagraming handoff.");
  const channel = source.match(/name=["']channel["']\s+value=["']([^"']+)["']/i)
    || source.match(/name=\\?["']channel\\?["']\s+value=\\?["']([^"'\\]+)\\?["']/i);
  return {
    url: decodeHtml(redirect[1]),
    id: decodeHtml(redirect[2]),
    channel: decodeHtml(channel?.[1] || "starplus1"),
  };
}

export function parseMediagramingHlsFromHtml(html) {
  const source = decodeHtml(String(html || ""));
  const match = source.match(/<iframe\b[^>]*\bsrc=["']([^"']*mediagraming\.com\/new\/video\.php\/?\?url=[^"']+)["']/i);
  if (!match) throw new Error("Mediagraming player iframe was not found.");
  const iframeUrl = new URL(match[1]);
  const hlsUrl = new URL(iframeUrl.searchParams.get("url") || "");
  const host = hlsUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (hlsUrl.protocol !== "https:" || (host !== "videoapne.to" && !host.endsWith(".videoapne.to"))) {
    throw new Error("Mediagraming returned an unexpected media host.");
  }
  if (!/\.m3u8(?:$|[?#])/i.test(hlsUrl.href)) throw new Error("Mediagraming did not return an HLS playlist.");
  return hlsUrl.href;
}

export async function resolveApneEpisodeDirect(episodeUrl, context = {}) {
  const log = (event, fields = {}) => writeApneLog(event, {
    showId: context.showId || null,
    dateKey: context.dateKey || null,
    episodeUrl,
    ...fields,
  });
  await log("resolve_start");
  try {
    const episode = await fetchText(episodeUrl, { referer: APNE_ORIGIN + "/" });
    await log("episode_html_ok", { bytes: episode.html.length, responseHost: hostOf(episode.url) });
    const flash = parseFlashTargetFromEpisodeHtml(episode.html);
    await log("flash_target_ok", { nextHost: hostOf(flash.href) });
    const news = await fetchText(flash.href, {
      method: "POST",
      body: new URLSearchParams({ id: flash.id }).toString(),
      referer: episodeUrl,
    });
    await log("newsportaling_html_ok", { bytes: news.html.length, responseHost: hostOf(news.url) });
    const handoff = parseNewsportalingRedirect(news.html);
    await log("mediagraming_handoff_ok", { nextHost: hostOf(handoff.url), channel: handoff.channel });
    const media = await fetchText(handoff.url, {
      method: "POST",
      body: new URLSearchParams({ id: handoff.id || flash.id, channel: handoff.channel }).toString(),
      referer: flash.href,
    });
    await log("mediagraming_html_ok", { bytes: media.html.length, responseHost: hostOf(media.url) });
    const hlsUrl = parseMediagramingHlsFromHtml(media.html);
    await log("hls_resolved", { hlsHost: hostOf(hlsUrl) });
    return { hlsUrl, referer: handoff.url };
  } catch (error) {
    await log("resolve_failed", { error: error.message });
    throw error;
  }
}

export function sanitizeDownloadName(value) {
  const cleaned = String(value || "APNE TV episode")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(?:online|watch online)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || "APNE TV episode").slice(0, 160);
}

async function ensureDownloadedVideosPlaylist() {
  const playlists = await store.listPlaylists();
  let playlist = playlists.find((item) => item?.meta?.kind === "downloaded-files");
  if (!playlist) {
    playlist = await store.addPlaylist({
      name: "Downloaded Videos",
      meta: { kind: "downloaded-files", hidden: true },
    });
  }
  return playlist;
}

async function probeLocalVideoDuration(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve(null);
    }, 5000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const duration = Number.parseFloat(output.trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
  });
}

async function registerDownloadedVideo(filePath, title, meta = {}) {
  const playlist = await ensureDownloadedVideosPlaylist();
  return store.addItem(playlist.id, {
    title,
    type: "file",
    url: filePath,
    meta: { downloaded: true, source: "apnetv", ...meta },
  });
}

async function uniqueLibraryVideoPath(title) {
  await fs.mkdir(config.libraryDir, { recursive: true });
  const base = sanitizeDownloadName(title);
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const candidate = path.join(config.libraryDir, `${base}${suffix}.mp4`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(config.libraryDir, `${base} ${Date.now()}.mp4`);
}

export async function downloadApneHls({ hlsUrl, referer, title, meta = {}, onStage = () => {} }) {
  const finalPath = await uniqueLibraryVideoPath(title);
  const partPath = finalPath.replace(/\.mp4$/i, ".part.mp4");
  await fs.rm(partPath, { force: true }).catch(() => {});
  onStage("Downloading", { filePath: finalPath });
  await writeApneLog("ffmpeg_start", {
    showId: meta.apneShowId || null, dateKey: meta.apneEpisodeDate || null,
    hlsHost: hostOf(hlsUrl), fileName: path.basename(finalPath),
  });

  await new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "warning",
      "-y",
      "-user_agent", DESKTOP_USER_AGENT,
      "-referer", referer || "https://mediagraming.com/",
      "-i", hlsUrl,
      "-map", "0:v:0?",
      "-map", "0:a:0?",
      "-c", "copy",
      "-movflags", "+faststart",
      partPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });
    child.on("error", (err) => reject(new Error(`ffmpeg failed to start: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const message = stderr.trim().split("\n").slice(-5).join(" | ") || `ffmpeg exited ${code}`;
        writeApneLog("ffmpeg_failed", {
          showId: meta.apneShowId || null, dateKey: meta.apneEpisodeDate || null,
          code, ffmpegTail: message,
        }).finally(() => reject(new Error(message)));
      }
    });
  });

  await fs.rename(partPath, finalPath);
  const duration = await probeLocalVideoDuration(finalPath);
  const item = await registerDownloadedVideo(finalPath, title, duration ? { ...meta, duration } : meta);
  await writeApneLog("download_saved", {
    showId: meta.apneShowId || null, dateKey: meta.apneEpisodeDate || null,
    fileName: path.basename(finalPath), duration: duration || null, itemId: item?.id || null,
  });
  onStage("Saved", { filePath: finalPath, itemId: item?.id || null, duration });
  return { filePath: finalPath, item, duration };
}

function episodeTitle(show, episode) {
  const shortDate = String(episode.dateLabel || "").replace(/\s+\d{4}\s*$/, "").trim();
  return sanitizeDownloadName(`${show.name} ${shortDate || episode.dateLabel || ""}`);
}

export function episodeMatchesDownloadedItem(item, show, episode) {
  if (!item || item.type !== "file") return false;
  const meta = item.meta || {};
  if (meta.source !== "apnetv") return false;
  if (meta.apneEpisodeUrl && meta.apneEpisodeUrl === episode.url) return true;
  if (meta.apneShowId === show.id && meta.apneEpisodeDate === episode.dateKey) return true;
  const itemTitle = normalized(item.title);
  const showName = normalized(show.name);
  const shortDate = normalized(String(episode.dateLabel || "").replace(/\s+\d{4}\s*$/, ""));
  return Boolean(itemTitle && showName && shortDate && itemTitle.includes(showName) && itemTitle.includes(shortDate));
}

async function downloadedApneItems() {
  const playlists = await store.listPlaylists();
  return playlists
    .filter((playlist) => playlist?.meta?.kind === "downloaded-files")
    .flatMap((playlist) => playlist.items || [])
    .filter((item) => item?.type === "file" && item?.meta?.source === "apnetv");
}

async function downloadedItemFor(show, episode, items = null) {
  const candidates = items || await downloadedApneItems();
  return candidates.find((item) => episodeMatchesDownloadedItem(item, show, episode)) || null;
}

async function detectRecent(show, limit = 10) {
  await writeApneLog("show_check_start", { showId: show.id, showUrl: show.url, limit });
  try {
    const page = await fetchText(show.url, { referer: APNE_ORIGIN + "/" });
    const episodes = parseRecentEpisodesFromShowHtml(page.html, show, limit);
    await writeApneLog("show_check_ok", {
      showId: show.id, count: episodes.length, latestDateKey: episodes[0]?.dateKey || null, htmlBytes: page.html.length,
    });
    return episodes;
  } catch (error) {
    await writeApneLog("show_check_failed", { showId: show.id, error: error.message });
    throw error;
  }
}

async function detectLatest(show) {
  return (await detectRecent(show, 1))[0];
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    showId: job.showId,
    status: job.status,
    detail: job.detail || "",
    episode: job.episode || null,
    itemId: job.itemId || null,
    filePath: job.filePath || null,
    error: job.error || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

async function episodeStatus(show, episode, downloadedItems = null) {
  const saved = await downloadedItemFor(show, episode, downloadedItems);
  const job = jobs.get(jobKey(show.id, episode.dateKey));
  let status = saved ? "Saved" : "Available";
  let itemId = saved?.id || null;
  let detail = "";
  if (!saved && job) {
    status = job.status || status;
    itemId = job.itemId || null;
    detail = job.detail || "";
  }
  return { ...episode, status, itemId, detail, job: publicJob(job) };
}

async function statusForShow(show) {
  try {
    const [detected, episodeMetadata] = await Promise.all([
      detectRecent(show, APNE_HISTORY_FETCH_LIMIT),
      episodeMetadataForShow(show),
    ]);
    const historyEpisodes = filterApneEpisodesByMonths(detected, APNE_HISTORY_MONTHS).map((episode) => ({
      ...episode,
      ...(episodeMetadata[episode.dateKey] || {}),
    }));
    const downloadedItems = await downloadedApneItems();
    const recentEpisodes = await Promise.all(historyEpisodes.map((episode) => episodeStatus(show, episode, downloadedItems)));
    const episode = recentEpisodes[0];
    const status = episode.status;
    let detail = "Latest: " + episode.dateLabel;
    const itemId = episode.itemId || null;
    const latestJob = jobs.get(jobKey(show.id, episode.dateKey));

    // APNE follows the Indian TV date, which can already be tomorrow in America/Chicago.
    // If APNE has published the newest dated episode, treat it as the current available
    // episode instead of greying it out purely because the local calendar date differs.
    if (status === "Failed") {
      detail = episode.detail || latestJob?.error || "Download failed";
    } else if (status === "Downloading") {
      detail = episode.detail || ("Downloading " + episode.dateLabel + "…");
    }

    return {
      ...show,
      status,
      detail,
      episode,
      recentEpisodes,
      itemId,
      job: publicJob(latestJob),
      history: {
        months: APNE_HISTORY_MONTHS,
        total: recentEpisodes.length,
        pageSize: APNE_HISTORY_PAGE_SIZE,
        pageCount: Math.max(1, Math.ceil(recentEpisodes.length / APNE_HISTORY_PAGE_SIZE)),
      },
    };
  } catch (error) {
    return {
      ...show,
      status: "Failed",
      detail: error.message,
      episode: null,
      recentEpisodes: [],
      itemId: null,
      job: null,
      history: {
        months: APNE_HISTORY_MONTHS,
        total: 0,
        pageSize: APNE_HISTORY_PAGE_SIZE,
        pageCount: 1,
      },
    };
  }
}

export async function listDailyStatus() {
  const shows = await loadShows();
  const results = await Promise.all(shows.map((show) => statusForShow(show)));
  return { today: todayKey(), shows: results };
}

export async function addShow(input = {}) {
  const candidate = normalizeApneShowInput(input.url, input.name);
  const shows = await loadShows();
  if (shows.some((show) => show.id === candidate.id || show.url === candidate.url)) {
    throw httpError(409, "That show is already in APNE Daily.");
  }
  shows.push(candidate);
  await saveCustomShows(shows);
  await writeApneLog("show_added", { showId: candidate.id, showUrl: candidate.url });
  return candidate;
}

export async function removeShow(showId) {
  const shows = await loadShows();
  const show = shows.find((item) => item.id === showId);
  if (!show) return false;
  if (show.builtIn) throw httpError(400, "Anupamaa is the built-in APNE Daily show.");
  await saveCustomShows(shows.filter((item) => item.id !== showId));
  for (const key of jobs.keys()) {
    if (key.startsWith(`${showId}:`)) jobs.delete(key);
  }
  await writeApneLog("show_removed", { showId });
  return true;
}

async function createEpisodeDownloadJob(show, episode) {
  const key = jobKey(show.id, episode.dateKey);
  const active = jobs.get(key);
  if (active && ["Checking", "Downloading"].includes(active.status)) return publicJob(active);

  const saved = await downloadedItemFor(show, episode);
  if (saved) {
    const existing = {
      id: crypto.randomBytes(8).toString("hex"), showId: show.id, status: "Saved", detail: "Already downloaded",
      startedAt: Date.now(), finishedAt: Date.now(), episode, itemId: saved.id, filePath: saved.url, error: null,
    };
    jobs.set(key, existing);
    await writeApneLog("download_duplicate", { showId: show.id, dateKey: episode.dateKey, itemId: saved.id });
    return publicJob(existing);
  }

  const job = {
    id: crypto.randomBytes(8).toString("hex"),
    showId: show.id,
    status: "Checking",
    detail: "Resolving APNE stream…",
    startedAt: Date.now(),
    episode,
    itemId: null,
    filePath: null,
    error: null,
  };
  jobs.set(key, job);
  await writeApneLog("download_requested", { showId: show.id, dateKey: episode.dateKey, episodeUrl: episode.url });

  (async () => {
    try {
      job.status = "Downloading";
      const resolved = await resolveApneEpisodeDirect(episode.url, { showId: show.id, dateKey: episode.dateKey });
      const title = episodeTitle(show, episode);
      const result = await downloadApneHls({
        hlsUrl: resolved.hlsUrl,
        referer: resolved.referer,
        title,
        meta: {
          apneDaily: true,
          apneShowId: show.id,
          apneEpisodeUrl: episode.url,
          apneEpisodeDate: episode.dateKey,
          apneEpisodeLabel: episode.dateLabel,
        },
        onStage: (status, extra = {}) => {
          job.status = status;
          job.detail = status === "Downloading" ? "Downloading to Mac…" : status;
          if (extra.filePath) job.filePath = extra.filePath;
          if (extra.itemId) job.itemId = extra.itemId;
        },
      });
      job.status = "Saved";
      job.detail = "Saved to Downloaded Videos";
      job.itemId = result.item?.id || job.itemId;
      job.filePath = result.filePath;
      job.finishedAt = Date.now();
    } catch (error) {
      job.status = "Failed";
      job.detail = error.message;
      job.error = error.message;
      job.finishedAt = Date.now();
      await writeApneLog("download_failed", { showId: show.id, dateKey: episode.dateKey, error: error.message });
      console.warn("[apne-daily] download failed:", error.message);
    }
  })();

  return publicJob(job);
}

export async function startEpisodeDownload(showId, dateKey) {
  const key = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw httpError(400, "A valid APNE episode date is required.");
  const shows = await loadShows();
  const show = shows.find((item) => item.id === showId);
  if (!show) throw httpError(404, "APNE Daily show not found.");
  const detected = await detectRecent(show, APNE_HISTORY_FETCH_LIMIT);
  const history = filterApneEpisodesByMonths(detected, APNE_HISTORY_MONTHS);
  const episode = history.find((item) => item.dateKey === key);
  if (!episode) throw httpError(404, "That episode is outside APNE Daily's " + APNE_HISTORY_MONTHS + "-month history window.");
  return createEpisodeDownloadJob(show, episode);
}

export async function startShowDownload(showId) {
  const shows = await loadShows();
  const show = shows.find((item) => item.id === showId);
  if (!show) throw httpError(404, "APNE Daily show not found.");
  const episode = await detectLatest(show);
  return createEpisodeDownloadJob(show, episode);
}
