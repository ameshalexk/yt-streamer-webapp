// YT Streamer webapp — single-origin Node server: serves the SPA, REST API, and MJPEG streams.
// Designed to sit behind a Cloudflare Tunnel on your custom domain. No auth (single user).
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { config } from "./config.js";
import * as store from "./lib/store.js";
import * as ytdlp from "./lib/ytdlp.js";
import * as stream from "./lib/stream.js";
import * as desktopInput from "./lib/desktop-input.js";
import * as browserRenderer from "./lib/browser-renderer.js";
import * as realChromeRenderer from "./lib/real-chrome-renderer.js";
import * as browserAudioCapture from "./lib/browser-audio-capture.js";
import * as catalog from "./lib/catalog.js";
import * as processedLibrary from "./lib/processed-library.js";
import * as preparedCache from "./lib/prepared-cache.js";
import * as youtubeOAuth from "./lib/youtube-oauth.js";
import * as moneyDashboard from "./lib/money-dashboard.js";
import * as apneDaily from "./lib/apne-daily.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const SERVER_STARTED_AT = Date.now();
const SERVER_INSTANCE_ID = `${SERVER_STARTED_AT.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const LAUNCHD_SERVICE_NAME = "com.ytstreamer.webapp";
const YOUTUBE_STREAM_HEADERS = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145 Safari/537.36",
  referer: "https://www.youtube.com/",
};
const RESTART_AUTH_WINDOW_MS = 10 * 60 * 1000;
const RESTART_AUTH_MAX_FAILURES = 5;
const restartAuthFailures = new Map();
let restartPending = false;
let httpServer = null;

const PLAYBACK_LOG_FILE = path.join(config.dataDir, "playback-events.jsonl");
const PLAYBACK_LOG_MAX_BYTES = 5 * 1024 * 1024;

function playbackLogString(value, max = 1000) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, max);
}

function playbackStats(value) {
  const source = value && typeof value === "object" ? value : {};
  const keys = [
    "state", "fps", "receivedFrames", "renderedFrames", "droppedFrames", "receivedBytes",
    "queueSeconds", "queueBytes", "maxQueueSeconds", "maxQueueBytes", "queueTrend",
    "queueTrendFps", "receiveBytesPerSecond", "receiveFps", "renderedFps", "producerSpeed",
    "averageDecodeMs", "maxDecodeMs", "startupMs", "responseStartMs", "firstByteMs",
    "firstFrameReceivedMs", "firstFrameDecodedMs", "firstPictureMs", "bufferReadyMs",
    "audioReadyMs", "audioStartMs", "firstRenderedMs", "serverResolveMs",
    "serverFirstOutputMs", "ffmpegFirstOutputMs", "resolveCache", "rebufferCount",
    "recoveryTargetSeconds", "lastAvDriftMs", "eof",
    "lateFrames", "averageRenderMs", "maxRenderMs", "bandwidthFast", "bandwidthSlow",
    "estimatedBandwidth", "mediaBitrate", "jpegQuality", "width", "height", "profile", "protocol",
    "durationSeconds", "firstJpegMs", "averageBufferSeconds", "minimumBufferSeconds",
    "stallCount", "stallDurationSeconds", "rebufferEvents", "dropPercent", "effectiveFps",
    "totalVideoBytes", "averageVideoMbps", "estimatedBandwidthMbps", "averageAvDriftMs",
    "selectedFps", "selectedJpegQuality", "selectedHeight",
  ];
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function playbackTiming(value) {
  const source = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = Math.round(raw * 10) / 10;
    else if (typeof raw === "string") out[key] = playbackLogString(raw, 120);
  }
  return out;
}

function youtubeIdFromPlaybackUrl(value) {
  try {
    const outer = new URL(String(value || ""), "https://stream.ameshalex.com");
    const nested = outer.searchParams.get("url");
    const target = nested ? new URL(nested) : outer;
    if (target.hostname.includes("youtu.be")) return target.pathname.split("/").filter(Boolean)[0] || null;
    if (target.hostname.includes("youtube.com")) return target.searchParams.get("v") || null;
  } catch {}
  return null;
}

async function appendPlaybackEvent(entry) {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    try {
      const stat = await fs.stat(PLAYBACK_LOG_FILE);
      if (stat.size >= PLAYBACK_LOG_MAX_BYTES) {
        await fs.rm(`${PLAYBACK_LOG_FILE}.1`, { force: true });
        await fs.rename(PLAYBACK_LOG_FILE, `${PLAYBACK_LOG_FILE}.1`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.appendFile(PLAYBACK_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error("[playback-log]", error.message);
  }
}

const GOOGLEVIDEO_PROXY_TTL_MS = 2 * 60 * 60 * 1000;
const googleVideoProxySessions = new Map();

function isGoogleVideoUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && /(^|\.)googlevideo\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function cleanGoogleVideoHeaders(value) {
  const source = value && typeof value === "object" ? value : {};
  const blocked = new Set(["host", "range", "if-range", "connection", "content-length", "transfer-encoding"]);
  const headers = {};
  for (const [key, raw] of Object.entries(source)) {
    if (raw == null || blocked.has(String(key).toLowerCase())) continue;
    headers[String(key)] = String(raw);
  }
  return headers;
}

function pruneGoogleVideoProxySessions() {
  const cutoff = Date.now() - GOOGLEVIDEO_PROXY_TTL_MS;
  for (const [id, session] of googleVideoProxySessions) {
    if (session.createdAt < cutoff) googleVideoProxySessions.delete(id);
  }
}

function localGoogleVideoProxyUrl(value, { headers = {}, sourceUrl = "", role = "video", maxHeight = config.download.maxHeight } = {}) {
  if (!isGoogleVideoUrl(value)) return value;
  pruneGoogleVideoProxySessions();
  const id = crypto.randomBytes(18).toString("base64url");
  googleVideoProxySessions.set(id, {
    target: String(value),
    headers: cleanGoogleVideoHeaders(headers),
    sourceUrl: String(sourceUrl || ""),
    role: role === "audio" ? "audio" : "video",
    maxHeight,
    createdAt: Date.now(),
    refreshCount: 0,
  });
  return `http://127.0.0.1:${config.port}/internal/googlevideo/${id}`;
}

function proxyYouTubeStreams(resolved, { sourceUrl = "", maxHeight = config.download.maxHeight } = {}) {
  const { videoUrl, audioUrl, videoHeaders, audioHeaders } = resolved;
  return {
    videoUrl: localGoogleVideoProxyUrl(videoUrl, { headers: videoHeaders, sourceUrl, role: "video", maxHeight }),
    audioUrl: audioUrl ? localGoogleVideoProxyUrl(audioUrl, { headers: audioHeaders, sourceUrl, role: "audio", maxHeight }) : null,
  };
}

const YOUTUBE_RESOLVE_CACHE_TTL_MS = 90 * 1000;
const youtubeResolveCache = new Map();

function pruneYouTubeResolveCache(now = Date.now()) {
  for (const [key, entry] of youtubeResolveCache) {
    if (!entry.promise && entry.expiresAt <= now) youtubeResolveCache.delete(key);
  }
}

async function resolveYouTubeStreamsCached(sourceUrl, maxHeight = config.download.maxHeight) {
  const key = String(maxHeight) + "|" + String(sourceUrl || "");
  const now = Date.now();
  pruneYouTubeResolveCache(now);
  const cached = youtubeResolveCache.get(key);
  if (cached?.value && cached.expiresAt > now) {
    return { resolved: cached.value, resolveCache: "hit", resolveMs: 0 };
  }
  if (cached?.promise) {
    const startedAt = Date.now();
    const resolved = await cached.promise;
    return { resolved, resolveCache: "shared", resolveMs: Date.now() - startedAt };
  }

  const startedAt = Date.now();
  const promise = ytdlp.getStreamUrls(sourceUrl, maxHeight);
  youtubeResolveCache.set(key, { promise, value: null, expiresAt: now + YOUTUBE_RESOLVE_CACHE_TTL_MS });
  try {
    const resolved = await promise;
    youtubeResolveCache.set(key, {
      promise: null,
      value: resolved,
      expiresAt: Date.now() + YOUTUBE_RESOLVE_CACHE_TTL_MS,
    });
    return { resolved, resolveCache: "miss", resolveMs: Date.now() - startedAt };
  } catch (error) {
    youtubeResolveCache.delete(key);
    throw error;
  }
}

async function resolveProxiedYouTubeStreams(sourceUrl, maxHeight = config.download.maxHeight) {
  const result = await resolveYouTubeStreamsCached(sourceUrl, maxHeight);
  return {
    ...proxyYouTubeStreams(result.resolved, { sourceUrl, maxHeight }),
    resolveCache: result.resolveCache,
    resolveMs: result.resolveMs,
  };
}

function requestedYouTubeMaxHeight(value) {
  const requested = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(requested) || requested <= 0) return config.download.maxHeight;
  return Math.max(144, Math.min(config.download.maxHeight, requested));
}

async function refreshGoogleVideoProxySession(session) {
  if (!session?.sourceUrl || session.refreshCount >= 1) return false;
  const fresh = await ytdlp.getStreamUrls(session.sourceUrl, session.maxHeight);
  const target = session.role === "audio" ? (fresh.audioUrl || fresh.videoUrl) : fresh.videoUrl;
  const headers = session.role === "audio" ? (fresh.audioHeaders || fresh.videoHeaders) : fresh.videoHeaders;
  if (!isGoogleVideoUrl(target)) return false;
  session.target = target;
  session.headers = cleanGoogleVideoHeaders(headers);
  session.refreshCount += 1;
  return true;
}

// In-memory download job tracker (single user, ephemeral is fine).
const jobs = new Map();
const preparedJobs = new Map();
let preparedQueue = Promise.resolve();
function newJob() {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, status: "running", pct: 0, error: null, item: null, createdAt: Date.now() };
  jobs.set(id, job);
  // prune old jobs
  if (jobs.size > 50) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

function preparedJobStatus(id) {
  const job = preparedJobs.get(preparedCache.normalizeId(id));
  if (!job) return null;
  return { status: job.status, pct: job.pct, error: job.error || null };
}

async function startPreparedJob(payload) {
  const id = preparedCache.normalizeId(payload.id);
  if (!id) throw new Error("video id required");
  const existing = await preparedCache.get(id);
  if (existing) return { status: "ready", pct: 100 };
  const active = preparedJobs.get(id);
  if (active?.status === "preparing") return preparedJobStatus(id);

  const job = { id, status: "preparing", pct: 0, error: null, createdAt: Date.now() };
  preparedJobs.set(id, job);
  preparedQueue = preparedQueue.then(async () => {
    try {
      await preparedCache.prepare({
        ...payload,
        id,
        onProgress: (pct) => { job.pct = Math.max(0, Math.min(100, Number(pct) || 0)); },
      });
      job.status = "ready";
      job.pct = 100;
      preparedJobs.delete(id);
    } catch (err) {
      job.status = "error";
      job.error = err.message;
      console.error("[prepared]", id, "-", err.message);
    }
  });
  return preparedJobStatus(id);
}

preparedCache.cleanupExpired().then((removed) => {
  if (removed.length) console.log(`[prepared] removed ${removed.length} expired video(s)`);
}).catch((err) => console.error("[prepared] cleanup -", err.message));
const preparedCleanupTimer = setInterval(() => {
  preparedCache.cleanupExpired().then((removed) => {
    if (removed.length) console.log(`[prepared] removed ${removed.length} expired video(s)`);
  }).catch((err) => console.error("[prepared] cleanup -", err.message));
}, 24 * 60 * 60 * 1000);
preparedCleanupTimer.unref?.();

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("[api]", req.method, req.path, "-", err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
});

function firstForwardedValue(value) {
  return String(value || "").split(",")[0].trim();
}

function isSameOriginRequest(req) {
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return false;
  const origin = String(req.get("origin") || "");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const host = firstForwardedValue(req.get("x-forwarded-host")) || String(req.get("host") || "");
    const protocol = firstForwardedValue(req.get("x-forwarded-proto")) || req.protocol;
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

function restartAuthKey(req) {
  return firstForwardedValue(req.get("cf-connecting-ip"))
    || firstForwardedValue(req.get("x-forwarded-for"))
    || req.ip
    || "unknown";
}

function restartAuthRetryAfter(req) {
  const key = restartAuthKey(req);
  const now = Date.now();
  const recent = (restartAuthFailures.get(key) || []).filter((timestamp) => now - timestamp < RESTART_AUTH_WINDOW_MS);
  if (recent.length) restartAuthFailures.set(key, recent);
  else restartAuthFailures.delete(key);
  if (recent.length < RESTART_AUTH_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((RESTART_AUTH_WINDOW_MS - (now - recent[0])) / 1000));
}

function recordRestartAuthFailure(req) {
  const key = restartAuthKey(req);
  const now = Date.now();
  const recent = (restartAuthFailures.get(key) || []).filter((timestamp) => now - timestamp < RESTART_AUTH_WINDOW_MS);
  recent.push(now);
  restartAuthFailures.set(key, recent);
}

function activeBackgroundJobCount() {
  const downloads = [...jobs.values()].filter((job) => job.status === "running").length;
  const preparations = [...preparedJobs.values()].filter((job) => job.status === "preparing").length;
  return downloads + preparations;
}

async function shutdownForRestart() {
  const forceExit = setTimeout(() => process.exit(0), 3500);
  try {
    httpServer?.close();
    httpServer?.closeAllConnections?.();
    await Promise.race([
      Promise.allSettled([
        stream.stopAllDesktopHls(),
        stream.stopAllDesktopAudioHls(),
        desktopInput.stop(),
        browserRenderer.stopAll("app-restart"),
        realChromeRenderer.stopAll("app-restart"),
        realChromeRenderer.cleanupOrphans("app-restart"),
        browserAudioCapture.releaseAll(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 2800)),
    ]);
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

function requireDesktopEnabled(req, res, next) {
  if (config.desktop.enabled) return next();
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(404).json({ error: "Desktop streaming is disabled." });
  }
  return res.status(404).type("text/plain").end("Desktop streaming is disabled.");
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    instanceId: SERVER_INSTANCE_ID,
    startedAt: SERVER_STARTED_AT,
    restartAvailable: process.env.XPC_SERVICE_NAME === LAUNCHD_SERVICE_NAME,
    activeStreams: stream.activeStreamCount(),
    activeAudioStreams: stream.activeAudioCount(),
    activeBrowserSessions: browserRenderer.activeSessionCount(),
    activeRealChromeSessions: realChromeRenderer.activeSessionCount(),
    time: Date.now(),
  });
});

app.post("/api/playback-event", asyncH(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const event = playbackLogString(body.event, 64);
  if (!/^[a-z0-9_-]{1,64}$/i.test(event)) return res.status(400).json({ error: "invalid event" });
  const streamUrl = playbackLogString(body.streamUrl, 1500);
  await appendPlaybackEvent({
    at: new Date().toISOString(),
    event,
    label: playbackLogString(body.label, 240) || null,
    youtubeId: youtubeIdFromPlaybackUrl(streamUrl),
    streamUrl: streamUrl || null,
    message: playbackLogString(body.message, 1200) || null,
    errorName: playbackLogString(body.errorName, 120) || null,
    reason: playbackLogString(body.reason, 120) || null,
    stats: playbackStats(body.stats),
    timing: playbackTiming(body.timing),
    diagnosis: playbackLogString(body.diagnosis, 240) || null,
    clientUserAgent: playbackLogString(body.userAgent, 600) || null,
    requestUserAgent: playbackLogString(req.get("user-agent"), 600) || null,
    serverInstanceId: SERVER_INSTANCE_ID,
  });
  res.status(204).end();
}));

app.get("/api/sessions", (req, res) => {
  const browserSessions = browserRenderer.listSessions();
  const realChromeSessions = realChromeRenderer.listSessions();
  res.json({
    browser: browserSessions,
    realChrome: realChromeSessions,
    counts: {
      streams: stream.activeStreamCount(),
      audioStreams: stream.activeAudioCount(),
      browserSessions: browserSessions.length,
      realChromeSessions: realChromeSessions.length,
    },
    limits: {
      browserIdleCloseMs: 60_000,
      browserSessionTtlMs: 15 * 60 * 1000,
    },
    time: Date.now(),
  });
});

app.post("/api/sessions/cleanup", asyncH(async (req, res) => {
  const stoppedAudioHls = await stream.stopAllDesktopAudioHls();
  const stoppedBrowser = await browserRenderer.stopAll("remote-cleanup");
  const stoppedRealChrome = await realChromeRenderer.stopAll("remote-cleanup");
  const stoppedRealChromeOrphans = await realChromeRenderer.cleanupOrphans("remote-cleanup");
  res.json({
    ok: true,
    stoppedAudioHls,
    stoppedBrowser,
    stoppedRealChrome,
    stoppedRealChromeOrphans,
    stopped: stoppedAudioHls + stoppedBrowser + stoppedRealChrome + stoppedRealChromeOrphans,
  });
}));

app.post("/api/app/restart", asyncH(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (process.env.XPC_SERVICE_NAME !== LAUNCHD_SERVICE_NAME) {
    return res.status(503).json({ error: "App restart is available only when YT Streamer is supervised by launchd." });
  }
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required." });
  if (!req.is("application/json") || req.body?.confirm !== "restart-app") {
    return res.status(400).json({ error: "Restart confirmation is required." });
  }
  const retryAfter = restartAuthRetryAfter(req);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many owner-code attempts. Try again later." });
  }
  if (!(await moneyDashboard.authorizeOwnerControl(req))) {
    recordRestartAuthFailure(req);
    return res.status(401).json({ error: "Owner access code required." });
  }
  restartAuthFailures.delete(restartAuthKey(req));
  const { token } = await moneyDashboard.accessToken();
  moneyDashboard.setAccessCookie(req, res, token);
  const activeJobs = activeBackgroundJobCount();
  if (activeJobs) {
    return res.status(409).json({ error: `Wait for ${activeJobs} active download or preparation job${activeJobs === 1 ? "" : "s"} to finish before restarting.` });
  }
  if (restartPending) return res.status(409).json({ error: "App restart is already in progress." });

  restartPending = true;
  res.once("finish", () => {
    const timer = setTimeout(() => { void shutdownForRestart(); }, 150);
    timer.unref?.();
  });
  res.status(202).json({ ok: true, restarting: true, instanceId: SERVER_INSTANCE_ID });
}));

// ---------------------------------------------------------------------------
// Private money dashboard
// ---------------------------------------------------------------------------
const moneyPage = asyncH(async (req, res) => {
  if (!(await moneyDashboard.authorize(req))) return moneyDashboard.sendUnauthorizedPage(res);
  const { token } = await moneyDashboard.accessToken();
  moneyDashboard.setAccessCookie(req, res, token);
  res.sendFile(path.join(config.publicDir, "money.html"));
});

app.get("/money", moneyPage);
app.get("/", (req, res, next) => {
  if (req.hostname !== "money.ameshalex.com") return next();
  return moneyPage(req, res);
});

app.get("/api/money-dashboard", asyncH(async (req, res) => {
  if (!(await moneyDashboard.authorize(req))) return res.status(401).json({ error: "money dashboard token required" });
  const { token } = await moneyDashboard.accessToken();
  moneyDashboard.setAccessCookie(req, res, token);
  res.json(await moneyDashboard.dashboardData());
}));

app.post("/api/money-dashboard", asyncH(async (req, res) => {
  if (!(await moneyDashboard.authorize(req))) return res.status(401).json({ error: "money dashboard token required" });
  const { token } = await moneyDashboard.accessToken();
  moneyDashboard.setAccessCookie(req, res, token);
  await moneyDashboard.updateTrackedData(req.body || {});
  res.json(await moneyDashboard.dashboardData());
}));

// ---------------------------------------------------------------------------
// Playlists CRUD
// ---------------------------------------------------------------------------
app.get("/api/apne-daily", asyncH(async (req, res) => {
  res.json(await apneDaily.listDailyStatus());
}));

app.post("/api/apne-daily/shows", asyncH(async (req, res) => {
  res.status(201).json(await apneDaily.addShow(req.body || {}));
}));

app.delete("/api/apne-daily/shows/:id", asyncH(async (req, res) => {
  const removed = await apneDaily.removeShow(req.params.id);
  if (!removed) return res.status(404).json({ error: "APNE Daily show not found." });
  res.json({ ok: true });
}));

app.post("/api/apne-daily/shows/:id/episodes/:dateKey/download", asyncH(async (req, res) => {
  const job = await apneDaily.startEpisodeDownload(req.params.id, req.params.dateKey);
  res.status(202).json(job);
}));

app.post("/api/apne-daily/shows/:id/download", asyncH(async (req, res) => {
  const job = await apneDaily.startShowDownload(req.params.id);
  res.status(202).json(job);
}));

app.get("/api/playlists", asyncH(async (req, res) => {
  res.json(await store.listPlaylists());
}));

app.post("/api/playlists", asyncH(async (req, res) => {
  const { name, meta } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
  res.status(201).json(await store.addPlaylist({ name, meta }));
}));

app.get("/api/playlists/:id", asyncH(async (req, res) => {
  const p = await store.getPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
}));

app.patch("/api/playlists/:id", asyncH(async (req, res) => {
  const p = await store.updatePlaylist(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
}));

app.delete("/api/playlists/:id", asyncH(async (req, res) => {
  const ok = await store.deletePlaylist(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Items within a playlist
// ---------------------------------------------------------------------------
app.post("/api/playlists/:id/items", asyncH(async (req, res) => {
  const { title, type, url, meta } = req.body || {};
  if (!url || !url.trim()) return res.status(400).json({ error: "url required" });
  const item = await store.addItem(req.params.id, { title, type: type || "m3u8", url: url.trim(), meta });
  if (!item) return res.status(404).json({ error: "playlist not found" });
  res.status(item.duplicate ? 200 : 201).json(item);
}));

app.patch("/api/playlists/:id/items/:itemId", asyncH(async (req, res) => {
  const item = await store.updateItem(req.params.id, req.params.itemId, req.body || {});
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
}));

app.delete("/api/playlists/:id/items/:itemId", asyncH(async (req, res) => {
  const ok = await store.deleteItem(req.params.id, req.params.itemId);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Saved iframe embeds
// ---------------------------------------------------------------------------
app.get("/api/saved-embeds", asyncH(async (req, res) => {
  res.json(await store.listSavedEmbeds());
}));

app.post("/api/saved-embeds", asyncH(async (req, res) => {
  const { title, src, code, height, savedAt } = req.body || {};
  if (!code || !String(code).trim()) return res.status(400).json({ error: "iframe code required" });
  if (!src || !/^https?:\/\//i.test(String(src).trim())) return res.status(400).json({ error: "valid iframe src required" });
  const embed = await store.addSavedEmbed({ title, src, code, height, savedAt });
  res.status(embed.duplicate ? 200 : 201).json(embed);
}));

app.delete("/api/saved-embeds/:id", asyncH(async (req, res) => {
  const ok = await store.deleteSavedEmbed(req.params.id);
  if (!ok) return res.status(404).json({ error: "saved iframe not found" });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// YouTube watch history recorded by this web app
// ---------------------------------------------------------------------------
app.get("/api/watch-history", asyncH(async (req, res) => {
  res.json(await store.listWatchHistory());
}));

app.post("/api/watch-history", asyncH(async (req, res) => {
  const entry = await store.recordWatchHistory(req.body || {});
  res.status(201).json(entry);
}));

app.delete("/api/watch-history/:id", asyncH(async (req, res) => {
  const ok = await store.deleteWatchHistoryEntry(req.params.id);
  if (!ok) return res.status(404).json({ error: "history entry not found" });
  res.json({ ok: true });
}));

app.delete("/api/watch-history", asyncH(async (req, res) => {
  await store.clearWatchHistory();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Browser renderer history
// ---------------------------------------------------------------------------
app.get("/api/browser-history", asyncH(async (req, res) => {
  res.json(await store.listBrowserHistory());
}));

app.post("/api/browser-history", asyncH(async (req, res) => {
  const entry = await store.recordBrowserHistory(req.body || {});
  res.status(201).json(entry);
}));

app.delete("/api/browser-history/:id", asyncH(async (req, res) => {
  const ok = await store.deleteBrowserHistoryEntry(req.params.id);
  if (!ok) return res.status(404).json({ error: "browser history entry not found" });
  res.json({ ok: true });
}));

app.delete("/api/browser-history", asyncH(async (req, res) => {
  await store.clearBrowserHistory();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// YouTube helpers
// ---------------------------------------------------------------------------
app.get("/api/youtube-auth/status", asyncH(async (req, res) => {
  res.json(await youtubeOAuth.status(req));
}));

app.get("/api/youtube-auth/start", asyncH(async (req, res) => {
  res.redirect(youtubeOAuth.authUrl(req));
}));

app.get("/api/youtube-auth/callback", asyncH(async (req, res) => {
  await youtubeOAuth.finishAuth(req);
  res.type("html").send(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>YouTube connected</title>
    <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#0b0d10;color:#eef2f6;display:grid;place-items:center;min-height:100vh;margin:0">
      <div style="max-width:520px;text-align:center;padding:24px">
        <h1>YouTube connected</h1>
        <p>You can close this tab and return to YT Streamer.</p>
        <script>
          try { if (window.opener) window.opener.postMessage({ type: "ytstreamer-youtube-connected" }, location.origin); } catch {}
          setTimeout(() => {
            try { window.close(); } catch {}
            location.href = "/";
          }, 900);
        </script>
      </div>
    </body>`);
}));

app.post("/api/youtube-auth/logout", asyncH(async (req, res) => {
  await youtubeOAuth.logout();
  res.json({ ok: true });
}));

app.get("/api/youtube/recommendations", asyncH(async (req, res) => {
  res.json(await youtubeOAuth.recommendations());
}));

app.get("/api/youtube/search", asyncH(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });
  const limit = Math.min(40, parseInt(req.query.limit, 10) || 20);
  res.json(await ytdlp.searchVideos(q, { limit }));
}));

app.post("/api/prepared/status", asyncH(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 250) : [];
  const items = await preparedCache.statuses(ids);
  for (const rawId of ids) {
    const id = preparedCache.normalizeId(rawId);
    if (!id || items[id]) continue;
    const job = preparedJobStatus(id);
    if (job) items[id] = job;
  }
  res.json({ items, retentionDays: preparedCache.RETENTION_DAYS });
}));

app.post("/api/prepared", asyncH(async (req, res) => {
  const { id, url, title, duration, thumbnail } = req.body || {};
  if (!id) return res.status(400).json({ error: "video id required" });
  if (!url) return res.status(400).json({ error: "video url required" });
  const status = await startPreparedJob({ id, url, title, duration, thumbnail });
  res.status(status.status === "ready" ? 200 : 202).json(status);
}));

// Expand a YouTube playlist URL into entries (for bulk-add).
app.get("/api/youtube/playlist", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  res.json(await ytdlp.getPlaylistEntries(url));
}));

// Single video metadata.
app.get("/api/youtube/info", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  res.json(await ytdlp.getInfo(url));
}));

// Bulk-import a YouTube playlist's entries as items in a given playlist (as 'youtube' refs, no download).
app.post("/api/playlists/:id/import-youtube", asyncH(async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  const { entries } = await ytdlp.getPlaylistEntries(url);
  const added = [];
  for (const e of entries) {
    const item = await store.addItem(req.params.id, {
      title: e.title, type: "youtube", url: e.url, meta: { duration: e.duration, thumbnail: e.thumbnail },
    });
    if (item) added.push(item);
  }
  res.json({ added: added.length, items: added });
}));

// ---------------------------------------------------------------------------
// Built-in IPTV catalog (iptv-org)
// ---------------------------------------------------------------------------
app.get("/api/catalog", asyncH(async (req, res) => res.json(await catalog.listSources())));

// Inspect a pasted URL: is it a single playable stream, or a multi-channel playlist?
app.get("/api/catalog/inspect", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  res.json(await catalog.inspectUrl(url));
}));

app.get("/api/catalog/channels", asyncH(async (req, res) => {
  const { src, q, group } = req.query;
  if (!src) return res.status(400).json({ error: "src required" });
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json(await catalog.getChannels(src, { q: q || "", group: group || "", limit, offset }));
}));

// ---------------------------------------------------------------------------
// Downloads (yt-dlp -> library). Async job with progress polling.
// ---------------------------------------------------------------------------
app.post("/api/download", asyncH(async (req, res) => {
  const { url, playlistId, maxHeight } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  const job = newJob();
  res.status(202).json({ jobId: job.id });

  (async () => {
    try {
      const { filePath } = await ytdlp.download(url, {
        maxHeight: maxHeight || config.download.maxHeight,
        onProgress: (pct) => { job.pct = pct; },
      });
      const title = path.basename(filePath).replace(/\.[^.]+$/, "");
      let item = null;
      if (playlistId) {
        item = await store.addItem(playlistId, {
          title, type: "file", url: filePath, meta: { downloaded: true },
        });
      }
      job.status = "done";
      job.pct = 100;
      job.item = item;
      job.filePath = filePath;
    } catch (err) {
      job.status = "error";
      job.error = err.message;
    }
  })();
}));

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown job" });
  res.json(job);
});

// ---------------------------------------------------------------------------
// Legacy-style processed YouTube library
// ---------------------------------------------------------------------------
app.get("/api/legacy-library/formats", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  res.json(await processedLibrary.formats(url));
}));

app.get("/api/legacy-library", asyncH(async (req, res) => {
  res.json(await processedLibrary.list());
}));

app.get("/api/legacy-library/playlists", asyncH(async (req, res) => {
  res.json(await processedLibrary.listPlaylists());
}));

app.post("/api/legacy-library/playlists", asyncH(async (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  res.status(201).json(await processedLibrary.addPlaylist({ url, name }));
}));

app.get("/api/legacy-library/playlists/:id/videos", asyncH(async (req, res) => {
  const playlists = await processedLibrary.listPlaylists();
  const playlist = playlists.find((entry) => entry.id === req.params.id);
  if (!playlist) return res.status(404).json({ error: "playlist not found" });
  res.json({ playlist, videos: await processedLibrary.playlistEntries(playlist.url) });
}));

app.delete("/api/legacy-library/playlists/:id", asyncH(async (req, res) => {
  const ok = await processedLibrary.deletePlaylist(req.params.id);
  if (!ok) return res.status(404).json({ error: "playlist not found or built-in" });
  res.json({ ok: true });
}));

app.post("/api/legacy-library/download", asyncH(async (req, res) => {
  const { url, resolutions } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  const job = newJob();
  job.message = "Queued";
  res.status(202).json({ jobId: job.id });

  (async () => {
    try {
      const item = await processedLibrary.processDownload(url, {
        resolutions,
        onProgress: (pct, message) => {
          job.pct = Math.max(0, Math.min(100, Math.round(pct)));
          job.message = message;
        },
      });
      job.status = "done";
      job.pct = 100;
      job.message = "Ready";
      job.item = item;
    } catch (err) {
      job.status = "error";
      job.error = err.message;
      job.message = "Failed";
    }
  })();
}));

app.get("/api/legacy-library/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown job" });
  res.json(job);
});

app.delete("/api/legacy-library/:id", asyncH(async (req, res) => {
  await processedLibrary.remove(req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Probe an arbitrary url/m3u8 to validate before saving.
// ---------------------------------------------------------------------------
app.get("/api/probe", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  res.json(await stream.probe(url));
}));

// ---------------------------------------------------------------------------
// On-demand Mac desktop capture
// ---------------------------------------------------------------------------
app.use([
  "/api/desktop",
  "/stream/desktop",
  "/stream/desktop-audio",
  "/stream/ts/desktop",
  "/stream/mp4/desktop",
  "/stream/hls/desktop",
  "/stream/hls/desktop-audio",
], requireDesktopEnabled);

app.get("/api/desktop/sources", asyncH(async (req, res) => {
  res.json(await stream.listDesktopSources());
}));

app.get("/api/desktop/hls/start", asyncH(async (req, res) => {
  const params = stream.normalizeParams(req.query);
  res.json(await stream.startDesktopHls({ params, audio: req.query.audio }));
}));

app.post("/api/desktop/hls/:id/stop", asyncH(async (req, res) => {
  await stream.stopDesktopHls(req.params.id);
  res.json({ ok: true });
}));

app.get("/api/desktop/audio-hls/start", asyncH(async (req, res) => {
  res.json(await stream.startDesktopAudioHls({ audio: req.query.audio, bitrateK: req.query.bitrate }));
}));

app.post("/api/desktop/audio-hls/:id/stop", asyncH(async (req, res) => {
  await stream.stopDesktopAudioHls(req.params.id);
  res.json({ ok: true });
}));

app.get("/api/desktop/input/status", asyncH(async (req, res) => {
  if (req.query.prompt === "1" && !desktopInput.authorize(req)) return res.status(401).json({ error: "desktop input token required" });
  res.json(await desktopInput.status({ prompt: req.query.prompt === "1" }));
}));

app.post("/api/desktop/input", asyncH(async (req, res) => {
  if (!desktopInput.authorize(req)) return res.status(401).json({ error: "desktop input token required" });
  res.json(await desktopInput.send(req.body || {}));
}));

// ---------------------------------------------------------------------------
// Isolated browser renderer
// ---------------------------------------------------------------------------
app.post("/api/browser/start", asyncH(async (req, res) => {
  await stream.stopAllDesktopAudioHls();
  res.status(201).json(await browserRenderer.start(req.body || {}));
}));

app.post("/api/browser/:id/navigate", asyncH(async (req, res) => {
  res.json(await browserRenderer.navigate(req.params.id, req.body || {}));
}));

app.patch("/api/browser/:id/settings", asyncH(async (req, res) => {
  res.json(await browserRenderer.updateSettings(req.params.id, req.body || {}));
}));

app.post("/api/browser/:id/input", asyncH(async (req, res) => {
  res.json(await browserRenderer.input(req.params.id, req.body || {}));
}));


async function acquireBrowserAudioCapture(req) {
  const backend = browserAudioCapture.normalizeBackend(req.query.backend);
  let processPids = [];
  if (backend === "core-tap") {
    const sessionId = String(req.query.session || "").trim();
    if (!sessionId) {
      const error = new Error("Core Tap requires an active Real Chrome session.");
      error.status = 400;
      throw error;
    }
    processPids = await realChromeRenderer.audioCapturePids(sessionId);
  }
  try {
    return await browserAudioCapture.acquire({
      backend,
      audio: req.query.audio,
      processPids,
    });
  } catch (error) {
    if (error?.code === "CORE_TAP_PERMISSION_REQUIRED") error.status = 403;
    throw error;
  }
}

app.get("/api/browser/audio-sources", asyncH(async (req, res) => {
  res.json(await stream.listDesktopSources(5000, { requireDesktopEnabled: false }));
}));

app.get("/api/browser/audio-hls/start", asyncH(async (req, res) => {
  const capture = await acquireBrowserAudioCapture(req);
  try {
    const hls = await stream.startDesktopAudioHls({
      audio: capture.audio,
      bitrateK: req.query.bitrate,
      requireDesktopEnabled: false,
      urlPrefix: "/stream/hls/browser-audio",
      onCleanup: capture.release,
    });
    res.json({ ...hls, capture: { backend: capture.backend, ...capture.details } });
  } catch (error) {
    await capture.release().catch(() => {});
    throw error;
  }
}));

app.post("/api/browser/audio-hls/:id/stop", asyncH(async (req, res) => {
  await stream.stopDesktopAudioHls(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/browser/:id/stop", asyncH(async (req, res) => {
  const ok = await browserRenderer.stop(req.params.id);
  if (!ok) return res.status(404).json({ error: "Browser session not found" });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Real Chrome renderer: dedicated Chrome profile streamed through DevTools
// ---------------------------------------------------------------------------
app.post("/api/real-chrome/start", asyncH(async (req, res) => {
  await stream.stopAllDesktopAudioHls();
  res.status(201).json(await realChromeRenderer.start(req.body || {}));
}));

app.post("/api/real-chrome/stop", asyncH(async (req, res) => {
  const stopped = await realChromeRenderer.stopAll("manual");
  res.json({ ok: true, stopped });
}));

app.post("/api/real-chrome/:id/navigate", asyncH(async (req, res) => {
  res.json(await realChromeRenderer.navigate(req.params.id, req.body || {}));
}));

app.patch("/api/real-chrome/:id/settings", asyncH(async (req, res) => {
  res.json(await realChromeRenderer.updateSettings(req.params.id, req.body || {}));
}));

app.post("/api/real-chrome/:id/input", asyncH(async (req, res) => {
  res.json(await realChromeRenderer.input(req.params.id, req.body || {}));
}));

app.post("/api/real-chrome/:id/media", asyncH(async (req, res) => {
  res.json(await realChromeRenderer.mediaPlayback(req.params.id, req.body || {}));
}));

app.post("/api/real-chrome/:id/close-tab", asyncH(async (req, res) => {
  res.json(await realChromeRenderer.closeSecondaryTab(req.params.id, "remote-x"));
}));

app.post("/api/real-chrome/:id/stop", asyncH(async (req, res) => {
  const ok = await realChromeRenderer.stop(req.params.id);
  if (!ok) return res.status(404).json({ error: "Real Chrome session not found" });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// MJPEG streaming endpoints
// ---------------------------------------------------------------------------
app.get("/stream/desktop", asyncH(async (req, res) => {
  const params = stream.normalizeParams(req.query);
  const videoDelayMs = Math.max(0, Math.min(5000, parseInt(req.query.videoDelay ?? "0", 10) || 0));
  return stream.streamDesktopMjpeg(req, res, { params, videoDelayMs });
}));

app.get("/stream/desktop-audio", asyncH(async (req, res) => {
  return stream.streamDesktopAudio(req, res, { audio: req.query.audio, bitrateK: req.query.bitrate });
}));

app.get("/stream/browser/:id", (req, res) => {
  return browserRenderer.stream(req, res, req.params.id);
});

app.get("/stream/real-chrome/:id", (req, res) => {
  return realChromeRenderer.stream(req, res, req.params.id);
});

app.get("/stream/browser-audio", asyncH(async (req, res) => {
  const capture = await acquireBrowserAudioCapture(req);
  if (capture.pcmStream) {
    return stream.streamPipeAudio(req, res, {
      inputStream: capture.pcmStream,
      sampleRate: capture.details?.sampleRate,
      channels: capture.details?.channels,
      bitrateK: req.query.bitrate,
      onCleanup: capture.release,
    });
  }
  return stream.streamCapturedAudio(req, res, {
    audio: capture.audio,
    bitrateK: req.query.bitrate,
    onCleanup: capture.release,
  });
}));

app.get("/stream/browser-pcm", asyncH(async (req, res) => {
  const capture = await acquireBrowserAudioCapture(req);
  if (capture.pcmStream) {
    return stream.streamPipePcm(req, res, {
      inputStream: capture.pcmStream,
      sampleRate: capture.details?.sampleRate,
      channels: capture.details?.channels,
      onCleanup: capture.release,
    });
  }
  return stream.streamCapturedPcm(req, res, {
    audio: capture.audio,
    sampleRate: req.query.rate,
    onCleanup: capture.release,
  });
}));

app.get("/stream/ts/desktop", asyncH(async (req, res) => {
  const params = stream.normalizeParams(req.query);
  return stream.streamDesktopTS(req, res, { params, audio: req.query.audio });
}));

app.get("/stream/mp4/desktop", asyncH(async (req, res) => {
  const params = stream.normalizeParams(req.query);
  return stream.streamDesktopMp4(req, res, { params, audio: req.query.audio });
}));

app.get("/stream/hls/desktop/:id/:file", (req, res) => {
  const filePath = stream.desktopHlsFilePath(req.params.id, req.params.file);
  if (!filePath) return res.status(404).type("text/plain").end("HLS session not found");
  if (req.params.file.endsWith(".m3u8")) {
    res.set({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
    });
  } else {
    res.set({
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
    });
  }
  res.sendFile(filePath);
});

app.get("/stream/hls/desktop-audio/:id/:file", (req, res) => {
  const filePath = stream.desktopAudioHlsFilePath(req.params.id, req.params.file);
  if (!filePath) return res.status(404).type("text/plain").end("Audio HLS session not found");
  if (req.params.file.endsWith(".m3u8")) {
    res.set({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
    });
  } else {
    res.set({
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
    });
  }
  res.sendFile(filePath);
});

app.get("/stream/hls/browser-audio/:id/:file", (req, res) => {
  const filePath = stream.desktopAudioHlsFilePath(req.params.id, req.params.file);
  if (!filePath) return res.status(404).type("text/plain").end("Browser audio HLS session not found");
  if (req.params.file.endsWith(".m3u8")) {
    res.set({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
    });
  } else {
    res.set({
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Accel-Buffering": "no",
    });
  }
  res.sendFile(filePath);
});

function wantsBufferedMjpeg(req) {
  return req.query.buffered === "1" || wantsFramedJpeg(req);
}

function wantsFramedJpeg(req) {
  return req.query.eauto === "1" || req.query.transport === "eauto";
}

function mjpegTransportOptions(req) {
  const framed = wantsFramedJpeg(req);
  const rawSessionId = Number.parseInt(req.query.eautoSession || req.query.session || "0", 10);
  const requestedProfile = String(req.query.eautoProfile || "e-auto").toLowerCase();
  const frameProfile = new Set(["economy", "low", "balanced", "smooth", "high"]).has(requestedProfile)
    ? requestedProfile : "e-auto";
  return {
    allowBurst: wantsBufferedMjpeg(req),
    framed,
    sessionId: Number.isFinite(rawSessionId) ? rawSessionId >>> 0 : 0,
    frameProfile,
  };
}

// GoogleVideo increasingly rejects FFmpeg's TLS/HTTP fingerprint even when the
// signed yt-dlp URL itself is valid. Keep FFmpeg local and proxy only validated
// googlevideo.com URLs through Node's fetch implementation. Range requests are
// forwarded so FFmpeg can still seek efficiently in long on-demand videos.
app.get("/internal/googlevideo/:id", asyncH(async (req, res) => {
  const session = googleVideoProxySessions.get(String(req.params.id || ""));
  if (!session || Date.now() - session.createdAt > GOOGLEVIDEO_PROXY_TTL_MS) {
    return res.status(404).type("text/plain").end("GoogleVideo proxy session expired");
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const fetchUpstream = () => {
    const headers = { ...session.headers };
    if (!headers["User-Agent"] && !headers["user-agent"]) headers["User-Agent"] = YOUTUBE_STREAM_HEADERS.userAgent;
    if (!headers.Accept && !headers.accept) headers.Accept = "*/*";
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers["if-range"]) headers["If-Range"] = req.headers["if-range"];
    return fetch(session.target, { method: "GET", headers, redirect: "follow", signal: controller.signal });
  };

  let upstream = await fetchUpstream();
  const firstStatus = upstream.status;
  if ((upstream.status === 403 || upstream.status === 410) && await refreshGoogleVideoProxySession(session)) {
    try { await upstream.body?.cancel(); } catch {}
    console.warn(`[googlevideo-proxy] upstream ${firstStatus}; refreshed signed ${session.role} URL`);
    await appendPlaybackEvent({
      at: new Date().toISOString(),
      event: "googlevideo_refresh",
      youtubeId: youtubeIdFromPlaybackUrl(session.sourceUrl),
      role: session.role,
      upstreamStatus: firstStatus,
      serverInstanceId: SERVER_INSTANCE_ID,
    });
    upstream = await fetchUpstream();
  }
  if (upstream.status >= 400) {
    await appendPlaybackEvent({
      at: new Date().toISOString(),
      event: "googlevideo_proxy_error",
      youtubeId: youtubeIdFromPlaybackUrl(session.sourceUrl),
      role: session.role,
      upstreamStatus: upstream.status,
      refreshCount: session.refreshCount,
      serverInstanceId: SERVER_INSTANCE_ID,
    });
  }

  res.status(upstream.status);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader("Cache-Control", "no-store");

  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body)
    .on("error", (error) => {
      if (!res.destroyed && error?.name !== "AbortError") res.destroy(error);
    })
    .pipe(res);
}));

// Stream a saved item by id (resolves type: m3u8 | youtube | file).
app.get("/stream/item/:itemId", asyncH(async (req, res) => {
  const found = await store.findItem(req.params.itemId);
  if (!found) return res.status(404).json({ error: "item not found" });
  const { item } = found;
  const params = stream.normalizeParams(req.query);

  if (item.type === "youtube") {
    const requestStartedAt = Date.now();
    const maxHeight = requestedYouTubeMaxHeight(params.height);
    const { videoUrl, audioUrl, resolveCache, resolveMs } = await resolveProxiedYouTubeStreams(item.url, maxHeight);
    return stream.streamMjpeg(req, res, {
      input: videoUrl,
      audioInput: audioUrl,
      params,
      isLive: false,
      paceInput: !wantsBufferedMjpeg(req),
      ...mjpegTransportOptions(req),
      startAt: req.query.timestamp,
      timing: { requestStartedAt, resolveMs, resolveCache },
      onTelemetry: (telemetry) => appendPlaybackEvent({
        at: new Date().toISOString(),
        event: "server_stream_summary",
        youtubeId: youtubeIdFromPlaybackUrl(item.url),
        streamUrl: playbackLogString(req.originalUrl, 1500),
        serverInstanceId: SERVER_INSTANCE_ID,
        serverTelemetry: telemetry,
        timing: { resolveMs, resolveCache },
      }),
      ...YOUTUBE_STREAM_HEADERS,
    });
  }
  if (item.type === "file") {
    // Guard: only stream files that live inside the library dir.
    const resolved = path.resolve(item.url);
    if (!resolved.startsWith(path.resolve(config.libraryDir))) {
      return res.status(403).json({ error: "file outside library" });
    }
    try { await fs.access(resolved); } catch { return res.status(404).json({ error: "file missing" }); }
    return stream.streamMjpeg(req, res, { input: resolved, params, isLive: false, ...mjpegTransportOptions(req), startAt: req.query.timestamp });
  }
  // default: m3u8 / direct url (carry any saved UA/referer headers)
  return stream.streamMjpeg(req, res, {
    input: item.url, params, isLive: true,
    userAgent: item.meta?.userAgent, referer: item.meta?.referer,
  });
}));

// Stream an ad-hoc m3u8/url passed directly (not yet saved). For the "test/play now" box and catalog.
app.get("/stream/url", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  const params = stream.normalizeParams(req.query);
  const isLive = req.query.live === "1";
  return stream.streamMjpeg(req, res, {
    input: url, params, isLive,
    userAgent: req.query.ua, referer: req.query.referer,
    ...mjpegTransportOptions(req),
    startAt: req.query.timestamp,
  });
}));

// Stream a YouTube url directly (extract then transcode), without saving.
app.get("/stream/youtube", asyncH(async (req, res) => {
  const requestStartedAt = Date.now();
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  const params = stream.normalizeParams(req.query);
  const maxHeight = requestedYouTubeMaxHeight(params.height);
  const { videoUrl, audioUrl, resolveCache, resolveMs } = await resolveProxiedYouTubeStreams(url, maxHeight);
  return stream.streamMjpeg(req, res, {
    input: videoUrl,
    audioInput: audioUrl,
    params,
    isLive: false,
    paceInput: !wantsBufferedMjpeg(req),
    ...mjpegTransportOptions(req),
    startAt: req.query.timestamp,
    timing: { requestStartedAt, resolveMs, resolveCache },
    onTelemetry: (telemetry) => appendPlaybackEvent({
      at: new Date().toISOString(),
      event: "server_stream_summary",
      youtubeId: youtubeIdFromPlaybackUrl(url),
      streamUrl: playbackLogString(req.originalUrl, 1500),
      serverInstanceId: SERVER_INSTANCE_ID,
      serverTelemetry: telemetry,
      timing: { resolveMs, resolveCache },
    }),
    ...YOUTUBE_STREAM_HEADERS,
  });
}));

app.get("/stream/prepared/:id", asyncH(async (req, res) => {
  const item = await preparedCache.get(req.params.id);
  if (!item) return res.status(404).json({ error: "prepared video not found" });
  return stream.streamMjpeg(req, res, {
    input: item.filePath,
    params: stream.normalizeParams(req.query),
    isLive: false,
    ...mjpegTransportOptions(req),
    startAt: req.query.timestamp,
  });
}));

// Stream a processed-library video. This mirrors the old saved-video path:
// audio is served separately, while video is converted to MJPEG on demand.
app.get("/stream/legacy/:id/:resolution", asyncH(async (req, res) => {
  const item = await processedLibrary.get(req.params.id);
  if (!item) return res.status(404).json({ error: "item not found" });
  const resolution = parseInt(req.params.resolution, 10);
  if (!item.resolutions.includes(resolution)) return res.status(404).json({ error: "resolution not found" });
  const input = processedLibrary.videoPath(item.id, resolution);
  try { await fs.access(input); } catch { return res.status(404).json({ error: "video missing" }); }
  return stream.streamMjpeg(req, res, {
    input,
    params: stream.normalizeParams({ ...req.query, height: req.query.height || resolution }),
    isLive: false,
    ...mjpegTransportOptions(req),
    startAt: req.query.timestamp,
  });
}));

app.get("/stream/legacy-audio/:id", asyncH(async (req, res) => {
  const item = await processedLibrary.get(req.params.id);
  if (!item) return res.status(404).json({ error: "item not found" });
  const input = processedLibrary.audioPath(item.id);
  try { await fs.access(input); } catch { return res.status(404).json({ error: "audio missing" }); }
  res.type("audio/mpeg");
  res.sendFile(input);
}));

// ---- Synced MPEG-TS (H.264+AAC, one stream) for the mpegts.js player ----
app.get("/stream/ts/item/:itemId", asyncH(async (req, res) => {
  const found = await store.findItem(req.params.itemId);
  if (!found) return res.status(404).json({ error: "item not found" });
  const { item } = found;
  const params = stream.normalizeParams(req.query);
  if (item.type === "youtube") {
    const { videoUrl } = await resolveProxiedYouTubeStreams(item.url, config.download.maxHeight);
    return stream.streamTS(req, res, { input: videoUrl, params, isLive: false, paceInput: true, startAt: req.query.timestamp, ...YOUTUBE_STREAM_HEADERS });
  }
  if (item.type === "file") {
    const resolved = path.resolve(item.url);
    if (!resolved.startsWith(path.resolve(config.libraryDir))) return res.status(403).json({ error: "file outside library" });
    try { await fs.access(resolved); } catch { return res.status(404).json({ error: "file missing" }); }
    return stream.streamTS(req, res, { input: resolved, params, isLive: false, startAt: req.query.timestamp });
  }
  return stream.streamTS(req, res, { input: item.url, params, isLive: true, userAgent: item.meta?.userAgent, referer: item.meta?.referer });
}));

app.get("/stream/ts/url", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  const params = stream.normalizeParams(req.query);
  return stream.streamTS(req, res, { input: url, params, isLive: req.query.live === "1", userAgent: req.query.ua, referer: req.query.referer });
}));

app.get("/stream/ts/youtube", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  const params = stream.normalizeParams(req.query);
  const { videoUrl } = await resolveProxiedYouTubeStreams(url, config.download.maxHeight);
  return stream.streamTS(req, res, { input: videoUrl, params, isLive: false, paceInput: true, startAt: req.query.timestamp, ...YOUTUBE_STREAM_HEADERS });
}));

app.get("/stream/ts/prepared/:id", asyncH(async (req, res) => {
  const item = await preparedCache.get(req.params.id);
  if (!item) return res.status(404).json({ error: "prepared video not found" });
  return stream.streamTS(req, res, {
    input: item.filePath,
    params: stream.normalizeParams(req.query),
    isLive: false,
    startAt: req.query.timestamp,
  });
}));

// ---- Audio (separate mp3 stream — legacy MJPEG path) ----
app.get("/stream/audio/item/:itemId", asyncH(async (req, res) => {
  const found = await store.findItem(req.params.itemId);
  if (!found) return res.status(404).json({ error: "item not found" });
  const { item } = found;
  if (item.type === "youtube") {
    const { videoUrl, audioUrl } = await resolveProxiedYouTubeStreams(item.url, config.download.maxHeight);
    return stream.streamAudio(req, res, { input: audioUrl || videoUrl, startAt: req.query.timestamp, ...YOUTUBE_STREAM_HEADERS });
  }
  if (item.type === "file") {
    const resolved = path.resolve(item.url);
    if (!resolved.startsWith(path.resolve(config.libraryDir))) return res.status(403).json({ error: "file outside library" });
    try { await fs.access(resolved); } catch { return res.status(404).json({ error: "file missing" }); }
    return stream.streamAudio(req, res, { input: resolved, startAt: req.query.timestamp });
  }
  return stream.streamAudio(req, res, { input: item.url, isLive: true, userAgent: item.meta?.userAgent, referer: item.meta?.referer });
}));

app.get("/stream/audio/url", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  return stream.streamAudio(req, res, { input: url, isLive: req.query.live === "1", userAgent: req.query.ua, referer: req.query.referer });
}));

app.get("/stream/audio/youtube", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  const maxHeight = requestedYouTubeMaxHeight(req.query.height);
  const { videoUrl, audioUrl, resolveCache, resolveMs } = await resolveProxiedYouTubeStreams(url, maxHeight);
  res.set("X-YT-Resolve-Ms", String(Math.max(0, Math.round(resolveMs))));
  res.set("X-YT-Resolve-Cache", resolveCache);
  return stream.streamAudio(req, res, { input: audioUrl || videoUrl, startAt: req.query.timestamp, ...YOUTUBE_STREAM_HEADERS });
}));

app.get("/stream/audio/prepared/:id", asyncH(async (req, res) => {
  const item = await preparedCache.get(req.params.id);
  if (!item) return res.status(404).json({ error: "prepared video not found" });
  return stream.streamAudio(req, res, { input: item.filePath, startAt: req.query.timestamp });
}));

// ---------------------------------------------------------------------------
// Static SPA (served last so API routes win).
// ---------------------------------------------------------------------------
// Serve the mpegts.js player from node_modules so the Tesla loads it locally (no CDN needed).
app.use("/vendor", express.static(path.join(config.root, "node_modules", "mpegts.js", "dist")));
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html") || req.path.endsWith(".js") || req.path.endsWith(".css")) {
    res.set("Cache-Control", "no-store, max-age=0");
  }
  next();
});
app.use(express.static(config.publicDir, { extensions: ["html"] }));
app.get("*", (req, res) => res.sendFile(path.join(config.publicDir, "index.html")));

await Promise.all([
  stream.cleanupStaleHlsFiles().catch((err) => console.error("[startup] hls cleanup -", err.message)),
  realChromeRenderer.cleanupOrphans("startup").catch((err) => console.error("[startup] real chrome cleanup -", err.message)),
]);

httpServer = app.listen(config.port, config.host, () => {
  console.log(`\n  YT Streamer webapp`);
  console.log(`  → http://${config.host}:${config.port}`);
  console.log(`  → library: ${config.libraryDir}`);
  console.log(`  → point your Cloudflare Tunnel at http://${config.host}:${config.port}\n`);
});
