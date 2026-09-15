import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import * as store from "./store.js";

const APNE_ORIGIN = "https://apnetv.xyz";
const SHOWS_FILE = path.join(config.dataDir, "apne-daily-shows.json");
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SHOWS = [{
  id: "anupamaa",
  name: "Anupamaa",
  url: "https://apnetv.xyz/Hindi-Serial/Anupamaa",
  builtIn: true,
}];

const jobs = new Map();

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
  const count = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(25, Math.trunc(Number(limit)))) : 10;
  return matches.slice(0, count);
}

export function parseLatestEpisodeFromShowHtml(html, show = {}) {
  return parseRecentEpisodesFromShowHtml(html, show, 1)[0];
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

export async function resolveApneEpisodeDirect(episodeUrl) {
  const episode = await fetchText(episodeUrl, { referer: APNE_ORIGIN + "/" });
  const flash = parseFlashTargetFromEpisodeHtml(episode.html);
  const news = await fetchText(flash.href, {
    method: "POST",
    body: new URLSearchParams({ id: flash.id }).toString(),
    referer: episodeUrl,
  });
  const handoff = parseNewsportalingRedirect(news.html);
  const media = await fetchText(handoff.url, {
    method: "POST",
    body: new URLSearchParams({ id: handoff.id || flash.id, channel: handoff.channel }).toString(),
    referer: flash.href,
  });
  return {
    hlsUrl: parseMediagramingHlsFromHtml(media.html),
    referer: handoff.url,
  };
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
      else reject(new Error(stderr.trim().split("\n").slice(-5).join(" | ") || `ffmpeg exited ${code}`));
    });
  });

  await fs.rename(partPath, finalPath);
  const duration = await probeLocalVideoDuration(finalPath);
  const item = await registerDownloadedVideo(finalPath, title, duration ? { ...meta, duration } : meta);
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

async function downloadedItemFor(show, episode) {
  const playlists = await store.listPlaylists();
  const items = playlists.filter((playlist) => playlist?.meta?.kind === "downloaded-files").flatMap((playlist) => playlist.items || []);
  return items.find((item) => episodeMatchesDownloadedItem(item, show, episode)) || null;
}

async function detectRecent(show, limit = 10) {
  const page = await fetchText(show.url, { referer: APNE_ORIGIN + "/" });
  return parseRecentEpisodesFromShowHtml(page.html, show, limit);
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

async function statusForShow(show) {
  const job = jobs.get(show.id);
  if (job && ["Checking", "Downloading"].includes(job.status)) {
    return { ...show, status: job.status, detail: job.detail || "", episode: job.episode || null, itemId: job.itemId || null, job: publicJob(job) };
  }
  try {
    const recentEpisodes = await detectRecent(show, 10);
    const episode = recentEpisodes[0];
    const saved = await downloadedItemFor(show, episode);
    const isToday = episode.dateKey === todayKey();
    let status = isToday ? "Available" : "Not available yet";
    let detail = isToday ? episode.dateLabel : `Latest: ${episode.dateLabel}`;
    let itemId = null;
    if (saved) {
      status = "Saved";
      detail = episode.dateLabel;
      itemId = saved.id;
    } else if (job?.status === "Failed" && job.episode?.url === episode.url) {
      status = "Failed";
      detail = job.error || "Download failed";
    }
    return { ...show, status, detail, episode, recentEpisodes, itemId, job: publicJob(job) };
  } catch (error) {
    return { ...show, status: "Failed", detail: error.message, episode: null, recentEpisodes: [], itemId: null, job: publicJob(job) };
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
  return candidate;
}

export async function removeShow(showId) {
  const shows = await loadShows();
  const show = shows.find((item) => item.id === showId);
  if (!show) return false;
  if (show.builtIn) throw httpError(400, "Anupamaa is the built-in APNE Daily show.");
  await saveCustomShows(shows.filter((item) => item.id !== showId));
  jobs.delete(showId);
  return true;
}

export async function startShowDownload(showId) {
  const shows = await loadShows();
  const show = shows.find((item) => item.id === showId);
  if (!show) throw httpError(404, "APNE Daily show not found.");
  const active = jobs.get(show.id);
  if (active && ["Checking", "Downloading"].includes(active.status)) return publicJob(active);

  const job = {
    id: crypto.randomBytes(8).toString("hex"),
    showId: show.id,
    status: "Checking",
    detail: "Checking APNE TV…",
    startedAt: Date.now(),
    episode: null,
    itemId: null,
    filePath: null,
    error: null,
  };
  jobs.set(show.id, job);

  (async () => {
    try {
      const episode = await detectLatest(show);
      job.episode = episode;
      const saved = await downloadedItemFor(show, episode);
      if (saved) {
        job.status = "Saved";
        job.detail = "Already downloaded";
        job.itemId = saved.id;
        job.filePath = saved.url;
        job.finishedAt = Date.now();
        return;
      }
      if (episode.dateKey !== todayKey()) {
        job.status = "Not available yet";
        job.detail = `Latest: ${episode.dateLabel}`;
        job.finishedAt = Date.now();
        return;
      }

      job.status = "Downloading";
      job.detail = "Resolving APNE stream…";
      const resolved = await resolveApneEpisodeDirect(episode.url);
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
      console.warn("[apne-daily] download failed:", error.message);
    }
  })();

  return publicJob(job);
}
