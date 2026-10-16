// YT Streamer webapp — single-origin Node server: serves the SPA, REST API, and MJPEG streams.
// Designed to sit behind a Cloudflare Tunnel on your custom domain. No auth (single user).
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { config } from "./config.js";
import * as store from "./lib/store.js";
import * as storageManager from "./lib/storage-manager.js";
import { findSavedPlayback } from "./lib/saved-playback.js";
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
import { requireMoneyAccess } from "./lib/cloudflare-money-access.js";
import * as apneDaily from "./lib/apne-daily.js";
import { createApneProgressStore, validEpisode as validApneProgressEpisode } from "./lib/apne-watch-progress.js";
import { createApneBackgroundCheck } from "./lib/apne-background-check.js";
import { createApneLiveRelay } from "./lib/apne-live-relay.js";
import { createApneMp4Relay } from "./lib/apne-mp4.js";
import { createApneThumbnailService } from "./lib/apne-thumbnails.js";
import { createApneLiveThumbnailService } from "./lib/apne-hls-thumbnails.js";
import { createApneOfficialArtwork } from "./lib/apne-official-artwork.js";
import * as cyberdashDash from "./lib/cyberdash-dash.js";
import * as processedDashCache from "./lib/processed-dash-cache.js";
import { readReleaseRevision } from "./lib/release-info.js";
import { createCastService } from "./lib/vlc-cast.js";
import { createCastAccess } from "./lib/vlc-cast-access.js";
import { createXPMediaHandler, createBlankDiskHandler } from "./lib/retro-xp-media.mjs";
import { createRetroRemoteHTTP } from "./lib/retro-remote-relay.mjs";
import { canUseCastReceiver, redactCastMediaPath } from "./lib/vlc-cast-routing.js";

let storageCleanupInProgress = false;
const app = express();
app.use((req, res, next) => {
  if (storageCleanupInProgress && !req.path.startsWith("/api/storage")
      && (req.path.startsWith("/stream/") || req.method !== "GET")) {
    return res.status(409).json({ error: "Storage cleanup is running; try again shortly" });
  }
  next();
});
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow, nosnippet");
  next();
});
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});
app.use(express.json({ limit: "256kb" }));
// The retired Money hostname may never access other application routes.
app.use((req, res, next) => req.hostname === "money.ameshalex.com" ? res.status(404).end() : next());
// Receiver hostname is deliberately media-only: never expose the authenticated
// Streamer UI or APIs through an unauthenticated cast-only Cloudflare route.
const CAST_RECEIVER_HOST = (() => {
  try {
    const u = new URL(process.env.CAST_PUBLIC_ORIGIN || "");
    return u.protocol === "https:" && u.pathname === "/" ? u.hostname : "";
  } catch { return ""; }
})();
app.use((req, res, next) => {
  if (!CAST_RECEIVER_HOST || req.hostname !== CAST_RECEIVER_HOST) return next();
  if (canUseCastReceiver({method:req.method, path:req.path,
    hostname:req.hostname, receiverHost:CAST_RECEIVER_HOST})) return next();
  return res.status(404).end();
});

const SERVER_STARTED_AT = Date.now();
const RELEASE_REVISION = await readReleaseRevision().catch((error) => {
  console.error("[release-info]", error.message);
  return null;
});
const SERVER_INSTANCE_ID = `${SERVER_STARTED_AT.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const LAUNCHD_SERVICE_NAME = "com.ytstreamer.webapp";
const YOUTUBE_STREAM_HEADERS = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145 Safari/537.36",
  referer: "https://www.youtube.com/",
};
let restartPending = false;
let httpServer = null;
const apneBackgroundCheck = createApneBackgroundCheck({
  dataDir: config.dataDir,
  scan: apneDaily.scanLatestForBackground,
});

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
  const durationValue = resolved.duration;
  return {
    videoUrl: localGoogleVideoProxyUrl(videoUrl, { headers: videoHeaders, sourceUrl, role: "video", maxHeight }),
    audioUrl: audioUrl ? localGoogleVideoProxyUrl(audioUrl, { headers: audioHeaders, sourceUrl, role: "audio", maxHeight }) : null,
    isLive: Boolean(resolved.isLive),
    duration: durationValue != null && durationValue !== "" && Number.isFinite(Number(durationValue))
      ? Number(durationValue)
      : null,
    title: resolved.title || null,
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
  const promise = ytdlp.getStreamUrls(sourceUrl, maxHeight).catch(async error => {
    const saved = await findSavedPlayback(sourceUrl);
    if (!saved) throw error;
    return { videoUrl: saved.videoPath, audioUrl: saved.audioPath,
      duration: saved.duration, title: saved.title, isLive: false, savedFallback: true };
  });
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
  console.error("[api]", req.method, redactCastMediaPath(req.path), "-", redactCastMediaPath(err.message));
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

function activeBackgroundJobCount() {
  const downloads = [...jobs.values()].filter((job) => job.status === "running").length;
  const preparations = [...preparedJobs.values()].filter((job) => job.status === "preparing").length;
  return downloads + preparations + apneDaily.activeJobCount();
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

// Storage is scoped to processed downloads; originals and iCloud copies are
// never candidates. Applying a reviewed list locks out new media/jobs briefly.
app.get('/api/storage', asyncH(async (_req, res) => {
  const result = await storageManager.summary();
  const { libraryBytes, cacheBytes, freeBytes, totalBytes, ...rest } = result;
  res.json({ ...rest, usage: { libraryBytes, cacheBytes, freeBytes, totalBytes } });
}));
app.patch('/api/storage/policy', asyncH(async (req, res) => {
  res.json({ policy: await storageManager.setPolicy(req.body) });
}));
app.patch('/api/storage/downloads/:id', asyncH(async (req, res) => {
  if (Object.keys(req.body || {}).some(key => key !== 'pinned')) return res.status(400).json({ error: 'Only pinned may be changed' });
  res.json(await storageManager.setPinned(req.params.id, req.body?.pinned));
}));
app.post('/api/storage/downloads/:id/watched', asyncH(async (req, res) => {
  if (req.body?.completed !== true) return res.status(400).json({ error: 'completed:true is required' });
  res.json(await storageManager.markWatched(req.params.id));
}));
app.post('/api/storage/cleanup', asyncH(async (req, res) => {
  const apply = req.body?.apply === true;
  if (apply && storageCleanupInProgress) return res.status(409).json({ error: 'Cleanup is already running' });
  if (apply) storageCleanupInProgress = true;
  try {
    const busy = Boolean(activeBackgroundJobCount() || stream.activeStreamCount() || stream.activeAudioCount()
      || browserRenderer.activeSessionCount() || realChromeRenderer.activeSessionCount());
    const result = await storageManager.cleanup(req.body, { busy });
    const candidates = result.eligible || [];
    const removed = result.removed || [];
    res.json({ applied: result.applied, candidates, removed,
      reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes + (item.cacheBytes || 0), 0),
      reclaimedBytes: removed.reduce((sum, item) => sum + item.bytes + (item.cacheBytes || 0), 0),
      reclaimedCacheBytes: result.reclaimedCacheBytes || 0 });
  } finally { if (apply) storageCleanupInProgress = false; }
}));

app.get('/api/youtube/extractor/status', asyncH(async (_req, res) => {
  res.json(await ytdlp.getExtractorDiagnostics());
}));
let extractorTestRunning = false;
app.post('/api/youtube/extractor/test', asyncH(async (req, res) => {
  if (extractorTestRunning) return res.status(409).json({ error: 'Extractor test is already running' });
  extractorTestRunning = true;
  try {
    res.json({ candidates: await ytdlp.testExtractorPlayback(req.body?.url || 'https://www.youtube.com/watch?v=jNQXAC9IVRw') });
  } finally { extractorTestRunning = false; }
}));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    release: { revision: RELEASE_REVISION, platform: process.platform },
    instanceId: SERVER_INSTANCE_ID,
    startedAt: SERVER_STARTED_AT,
    restartAvailable: process.env.XPC_SERVICE_NAME === LAUNCHD_SERVICE_NAME,
    activeJobs: activeBackgroundJobCount(),
    activeStreams: stream.activeStreamCount(),
    activeAudioStreams: stream.activeAudioCount(),
    activeBrowserSessions: browserRenderer.activeSessionCount(),
    activeRealChromeSessions: realChromeRenderer.activeSessionCount(),
    apneBackgroundCheck: apneBackgroundCheck.status(),
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

app.post("/api/app/restart", requireMoneyAccess, asyncH(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (process.env.XPC_SERVICE_NAME !== LAUNCHD_SERVICE_NAME) {
    return res.status(503).json({ error: "App restart is available only when YT Streamer is supervised by launchd." });
  }
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required." });
  if (!req.is("application/json") || req.body?.confirm !== "restart-app") {
    return res.status(400).json({ error: "Restart confirmation is required." });
  }
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
app.get("/money", requireMoneyAccess, (_req, res) => {
  res.sendFile(path.join(config.publicDir, "money.html"));
});
app.get("/api/money-dashboard", requireMoneyAccess, asyncH(async (_req, res) => {
  res.json(await moneyDashboard.dashboardData());
}));

// Private, read-only Tesla telemetry dashboard. The MQTT capability is read
// server-side and only rendered after the existing owner-only dashboard gate.
app.get("/tesla", asyncH(async (req, res) => {
  if (!(await moneyDashboard.authorize(req))) {
    return moneyDashboard.sendUnauthorizedPage(res, "Tesla dashboard");
  }
  const { token } = await moneyDashboard.accessToken();
  moneyDashboard.setAccessCookie(req, res, token);
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#090b0d"><title>Tesla · YT Streamer</title>
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#090b0d;color:#f4f6f6;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.bar{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:#111416;border-bottom:1px solid #242a2e}.bar a{color:#f4f6f6;text-decoration:none}.label{font-size:11px;letter-spacing:.13em;color:#929b9e;text-transform:uppercase}iframe{display:block;width:100%;height:calc(100% - 48px);border:0;background:#090b0d}</style></head>
<body><header class="bar"><a href="/" rel="noreferrer">‹ &nbsp;YT Streamer</a><span class="label">Tesla · Live telemetry</span></header><iframe title="Read-only Tesla live dashboard" referrerpolicy="no-referrer" src="/tesla/live"></iframe></body></html>`);
}));

async function authorizeTeslaProxy(req, res) {
  if (!(await moneyDashboard.authorize(req))) {
    res.status(401).json({ error: "Tesla dashboard access required." });
    return null;
  }
  const configDir = process.env.TESLA_PASSIVE_CONFIG
    || path.join(process.env.HOME || "/Users/amesh", ".config", "tesla-chatgpt-plugin");
  let capability;
  try {
    capability = (await fs.readFile(path.join(configDir, "passive-endpoint-path"), "utf8")).trim();
  } catch {
    res.status(503).json({ error: "Tesla dashboard is not configured on this server." });
    return null;
  }
  if (!/^[A-Za-z0-9]{40,}$/.test(capability)) {
    res.status(503).json({ error: "Tesla dashboard configuration is invalid." });
    return null;
  }
  const upstreamPath = req.path.endsWith("/api/snapshot") ? "api/snapshot" : "";
  return `http://127.0.0.1:8093/${capability}/${upstreamPath}`;
}

app.get("/tesla/live", asyncH(async (req, res) => {
  const url = await authorizeTeslaProxy(req, res);
  if (!url) return;
  const upstream = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  res.status(upstream.status);
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.type(upstream.headers.get("content-type") || "text/html");
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

app.get("/tesla/live/api/snapshot", asyncH(async (req, res) => {
  const url = await authorizeTeslaProxy(req, res);
  if (!url) return;
  const upstream = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  res.status(upstream.status);
  res.set("Cache-Control", "no-store");
  res.type(upstream.headers.get("content-type") || "application/json");
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

let teslaMcpRequestId = 0;
async function teslaMcpRequest(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++teslaMcpRequestId, method, params }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("Tesla service unavailable.");
  let payload;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data: ")).at(-1)?.slice(6);
    if (!data) throw new Error("Tesla service returned an empty response.");
    payload = JSON.parse(data);
  } else {
    payload = JSON.parse(raw);
  }
  if (payload.error) throw new Error(payload.error.message || "Tesla service request failed.");
  return payload.result;
}

app.post("/tesla/live/api/pull-over", asyncH(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required." });
  if (!(await moneyDashboard.authorize(req))) return res.status(401).json({ error: "Tesla dashboard access required." });
  const execute = req.body?.execute === true;
  const expectedLatitude = req.body?.expected_target_latitude;
  const expectedLongitude = req.body?.expected_target_longitude;
  if (execute && req.body?.confirm !== "send-pull-over-navigation") {
    return res.status(400).json({ error: "Explicit navigation confirmation required.", navigation_sent: false });
  }
  if (execute && (!Number.isFinite(expectedLatitude) || !Number.isFinite(expectedLongitude))) {
    return res.status(400).json({ error: "A reviewed pull-over point is required. Preview again before sending navigation.", navigation_sent: false });
  }
  const configDir = process.env.TESLA_PASSIVE_CONFIG
    || path.join(process.env.HOME || "/Users/amesh", ".config", "tesla-chatgpt-plugin");
  let capability;
  try {
    capability = (await fs.readFile(path.join(configDir, "endpoint-path"), "utf8")).trim();
  } catch {
    return res.status(503).json({ error: "Tesla navigation service is not configured.", navigation_sent: false });
  }
  if (!/^[A-Za-z0-9]{40,}$/.test(capability)) {
    return res.status(503).json({ error: "Tesla navigation service configuration is invalid.", navigation_sent: false });
  }
  const endpoint = `http://127.0.0.1:8092/${capability}/mcp`;
  try {
    await teslaMcpRequest(endpoint, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "yt-streamer-tesla-dashboard", version: "1.0" },
    });
    const result = await teslaMcpRequest(endpoint, "tools/call", {
      name: "tesla_pull_over",
      arguments: execute ? {
        execute: true,
        expected_target_latitude: expectedLatitude,
        expected_target_longitude: expectedLongitude,
      } : {},
    });
    const toolText = result?.content?.find((part) => part.type === "text")?.text;
    if (result?.isError) {
      if (execute) {
        return res.status(502).json({
          error: "The navigation result is unknown. Check the Tesla screen before trying again.",
          outcome_unknown: true,
        });
      }
      return res.status(422).json({ error: toolText || "Tesla pull-over request failed.", navigation_sent: false });
    }
    if (result?.structuredContent) return res.json(result.structuredContent);
    if (toolText) {
      try { return res.json(JSON.parse(toolText)); } catch {}
    }
    return res.status(502).json({ error: "Tesla service returned an unreadable pull-over plan.", navigation_sent: false });
  } catch {
    return res.status(502).json({
      error: execute
        ? "The navigation result is unknown. Check the Tesla screen before trying again."
        : "Could not create a pull-over preview. No navigation command was sent.",
      outcome_unknown: execute,
      navigation_sent: false,
    });
  }
}));

app.post("/api/money-dashboard", requireMoneyAccess, asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required." });
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

app.patch("/api/apne-daily/shows/:id", asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required." });
  res.json(await apneDaily.renameShow(req.params.id, req.body || {}));
}));

app.delete("/api/apne-daily/shows/:id", asyncH(async (req, res) => {
  const removed = await apneDaily.removeShow(req.params.id);
  if (!removed) return res.status(404).json({ error: "APNE Daily show not found." });
  res.json({ ok: true });
}));

app.post("/api/apne-daily/shows/:id/episodes/:dateKey/check-source", asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required." });
  res.json(await apneDaily.checkEpisodeSource(req.params.id, req.params.dateKey, {
    force: req.body?.force === true,
  }));
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

app.patch("/api/watch-history/:id/progress", asyncH(async (req, res) => {
  const entry = await store.updateWatchProgress(req.params.id, req.body || {});
  if (!entry) return res.status(404).json({ error: "history entry not found" });
  res.json(entry);
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
  try { res.json(await ytdlp.getInfo(url)); }
  catch (error) {
    const saved = await findSavedPlayback(url);
    if (!saved) throw error;
    res.json({ id: saved.id, title: saved.title, duration: saved.duration,
      isLive: false, webpage_url: url, savedFallback: true });
  }
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
function processedCdnResolutions(item) {
  const available = Array.isArray(item?.resolutions) ? item.resolutions.map(Number).filter(Number.isFinite) : [];
  const maxHeight = Math.max(240, Number(config.prepared?.maxHeight) || 480);
  const selected = available.filter((height) => height <= maxHeight).sort((a, b) => b - a);
  if (selected.length) return selected;
  return available.length ? [Math.min(...available)] : [];
}

app.get("/api/legacy-library/formats", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  res.json(await processedLibrary.formats(url));
}));

app.get("/api/legacy-library", asyncH(async (req, res) => {
  const items = await processedLibrary.list();
  const enriched = await Promise.all(items.map(async (item) => {
    const cdn = await processedDashCache.status(item.id).catch(() => ({ status: "not-ready" }));
    return { ...item, webcodecsCache: cdn };
  }));
  res.json(enriched);
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
          job.pct = Math.max(0, Math.min(65, Math.round((Number(pct) || 0) * 0.65)));
          job.message = message;
        },
      });
      job.pct = 65;
      job.message = "Preparing CDN/WebCodecs cache";
      try {
        await processedDashCache.prepare(item.id, {
          resolutions: processedCdnResolutions(item),
          onProgress: (pct, message) => {
            job.pct = Math.max(65, Math.min(100, 65 + Math.round((Number(pct) || 0) * 0.35)));
            job.message = message || "Preparing CDN/WebCodecs cache";
          },
        });
        item.webcodecsCache = await processedDashCache.status(item.id);
      } catch (cacheError) {
        // Keep the processed-library item usable through MJPEG even if the optional
        // pre-segmented WebCodecs cache could not be generated.
        item.webcodecsCache = { status: "error", error: cacheError.message };
        console.error("[processed-dash-cache]", cacheError.message);
      }
      job.status = "done";
      job.pct = 100;
      job.message = item.webcodecsCache?.status === "ready" ? "Ready · CDN cache prepared" : "Ready · MJPEG fallback";
      job.item = item;
    } catch (err) {
      job.status = "error";
      job.error = err.message;
      job.message = "Failed";
    }
  })();
}));

app.post("/api/legacy-library/:id/prepare-cdn", asyncH(async (req, res) => {
  const item = await processedLibrary.get(req.params.id);
  if (!item) return res.status(404).json({ error: "processed item not found" });
  const job = newJob();
  job.message = "Preparing CDN/WebCodecs cache";
  res.status(202).json({ jobId: job.id });

  (async () => {
    try {
      const index = await processedDashCache.prepare(item.id, {
        resolutions: processedCdnResolutions(item),
        onProgress: (pct, message) => {
          job.pct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
          job.message = message || "Preparing CDN/WebCodecs cache";
        },
      });
      job.status = "done";
      job.pct = 100;
      job.message = "CDN cache ready";
      job.item = {
        id: item.id,
        preparedAt: index.preparedAt,
        webcodecsCache: await processedDashCache.status(item.id),
      };
    } catch (error) {
      job.status = "error";
      job.error = error.message;
      job.message = "CDN cache failed";
    }
  })();
}));

app.get("/api/legacy-library/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown job" });
  res.json(job);
});

app.delete("/api/legacy-library/:id", asyncH(async (req, res) => {
  await Promise.all([
    processedLibrary.remove(req.params.id),
    processedDashCache.remove(req.params.id),
  ]);
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
    input: item.url, params, isLive: true, ...mjpegTransportOptions(req),
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
    input: url, params, isLive, ...mjpegTransportOptions(req), startAt: req.query.timestamp,
    userAgent: req.query.ua, referer: req.query.referer,
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

// ---- Experimental CyberDash-style DASH/fMP4 WebCodecs player ----
// Prepared processed-library cache: pre-encoded H.264/AAC fMP4 segments.
// This path does no per-play transcode and can be fetched far ahead like a small local CDN.
app.post("/api/experimental/cyberdash/prepared/start", asyncH(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const id = String(body.id || "").trim();
  if (!id) return res.status(400).json({ error: "processed item id required" });
  try {
    const prepared = await processedDashCache.start(id, {
      resolution: body.height ?? body.resolution ?? 0,
      playbackRate: body.playbackRate ?? 1,
      startAt: body.startAt ?? 0,
    });
    res.set("Cache-Control", "no-store");
    res.json({
      ...prepared,
      player: "processed-static-fmp4-v1",
    });
  } catch (error) {
    res.status(409).json({
      error: error.message || "prepared CDN cache unavailable",
      fallback: "mjpeg",
      prepared: false,
    });
  }
}));

app.get("/stream/processed-dash/:id/*", asyncH(async (req, res) => {
  const relative = req.params[0] || "";
  const filePath = processedDashCache.filePath(req.params.id, relative);
  if (!filePath) return res.status(404).type("text/plain").end("prepared segment not found");
  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).type("text/plain").end("prepared segment not found");
  }
  const name = path.basename(filePath);
  if (name.endsWith(".mpd")) res.type("application/dash+xml");
  else if (name.endsWith(".m4s")) res.type("video/iso.segment");
  else if (name.endsWith(".json")) res.type("application/json");
  res.set({
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Accel-Buffering": "no",
  });
  res.sendFile(filePath);
}));

app.post("/api/experimental/cyberdash/start", asyncH(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const url = String(body.url || "").trim();
  if (!url) return res.status(400).json({ error: "url required" });
  const maxHeight = requestedYouTubeMaxHeight(body.height);
  const fps = Math.max(5, Math.min(30, Number.parseInt(String(body.fps ?? 30), 10) || 30));
  const playbackRate = Math.max(1, Math.min(4, Number.parseFloat(String(body.playbackRate ?? 1)) || 1));
  const requestedStartAt = Math.max(0, Number.parseFloat(String(body.startAt ?? 0)) || 0);
  const { videoUrl, audioUrl, resolveCache, resolveMs, isLive, duration, title } = await resolveProxiedYouTubeStreams(url, maxHeight);
  if (isLive) {
    return res.status(409).json({
      error: "Live YouTube streams use MJPEG playback.",
      fallback: "mjpeg",
      isLive: true,
    });
  }
  const startAt = Number.isFinite(duration) && duration > 0
    ? Math.min(requestedStartAt, Math.max(0, duration - 2))
    : requestedStartAt;
  const session = await cyberdashDash.startYouTubeDashSession({
    videoInput: videoUrl,
    audioInput: audioUrl,
    sourceUrl: url,
    height: maxHeight,
    fps,
    startAt,
    playbackRate,
  });
  res.json({
    ...session,
    resolveCache,
    resolveMs,
    isLive: false,
    duration,
    title,
    player: "experimental-cyberdash-v1",
  });
}));

app.get("/api/experimental/cyberdash/:id/status", asyncH(async (req, res) => {
  const status = await cyberdashDash.getSessionStatus(req.params.id);
  if (!status) return res.status(404).json({ error: "session not found" });
  res.set("Cache-Control", "no-store");
  res.json(status);
}));

app.post("/api/experimental/cyberdash/:id/stop", asyncH(async (req, res) => {
  const stopped = await cyberdashDash.stopSession(req.params.id);
  if (!stopped) return res.status(404).json({ error: "session not found" });
  res.status(204).end();
}));

app.get("/stream/experimental/cyberdash/:id/:file", asyncH(async (req, res) => {
  const filePath = cyberdashDash.sessionFilePath(req.params.id, req.params.file);
  if (!filePath) return res.status(404).type("text/plain").end("experimental DASH file not found");
  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).type("text/plain").end("experimental DASH file not ready");
  }
  const name = String(req.params.file || "");
  if (name.endsWith(".mpd")) res.type("application/dash+xml");
  else if (name.endsWith(".m4s")) res.type("video/iso.segment");
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "X-Accel-Buffering": "no",
  });
  res.sendFile(filePath);
}));

// Optional VLC/Chromecast HLS: controls require a signed CF Access identity;
// receiver downloads only use a separate, scoped temporary ticket.
const castAuth = createCastAccess({
  issuer: process.env.CAST_ACCESS_ISSUER || "",
  audience: process.env.CAST_ACCESS_AUDIENCE || "",
});
const castPublicOrigin = process.env.CAST_PUBLIC_ORIGIN || "";
const castControlOrigin = process.env.CAST_CONTROL_ORIGIN || "";
const castService = createCastService({
  root: path.join(config.dataDir, "vlc-cast"),
  publicOrigin: castPublicOrigin,
  ffmpegPath: config.ffmpegPath,
  enabled: process.env.CAST_ENABLED === "1",
  resolveSource: async ({kind, id, url}) => {
    if (kind === "legacy") {
      const processed=await processedLibrary.get(id);
      if (!processed?.resolutions?.length) throw Object.assign(Error("Processed video unavailable"),{status:404});
      const allowed=processed.resolutions.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
      const resolution=allowed.find(h=>h>=480) || allowed.at(-1);
      const video=processedLibrary.videoPath(processed.id,resolution);
      const audio=processedLibrary.audioPath(processed.id);
      await fs.access(video);
      await fs.access(audio);
      return {video,audio,live:false};
    }
    let item;
    if (kind === "item") {
      const found = await store.findItem(id);
      if (!found) throw Object.assign(Error("Saved item not found"), {status:404});
      item=found.item;
    }
    if (item?.type === "file") {
      const input=await fs.realpath(item.url);
      const libraryRoot=await fs.realpath(config.libraryDir);
      const relative=path.relative(libraryRoot, input);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw Object.assign(Error("File outside saved library"), {status:403});
      await fs.access(input);
      return {video:input,live:false};
    }
    const ytUrl = kind === "youtube" ? url : item?.type === "youtube" ? item.url : "";
    if (ytUrl) {
      const {castYoutubeUrl} = await import("./lib/vlc-cast.js");
      if (!castYoutubeUrl(ytUrl)) throw Object.assign(Error("Only HTTPS YouTube cast URLs allowed"),{status:400});
      const resolved=await resolveProxiedYouTubeStreams(ytUrl, 480);
      return {video:resolved.videoUrl,audio:resolved.audioUrl,live:false};
    }
    throw Object.assign(Error("Cast currently supports saved files and YouTube; live streams are not supported"),{status:422});
  },
});
// Reclaim only stale scratch directories from crashed/previous sessions.
void castService.cleanupStaleScratch().catch(error=>{
  console.error("[cast-scratch-cleanup]",redactCastMediaPath(error.message));
});
async function requireCastControl(req,res,next) {
  castService.headers(res);
  if (!castService.available) return res.status(503).json({error:"VLC casting is disabled or missing configuration"});
  try {
    const origin = new URL(castControlOrigin);
    if (origin.protocol !== "https:" || origin.pathname !== "/" || req.hostname !== origin.hostname)
      return res.status(403).end();
    if (req.method !== "GET" && req.get("origin") !== origin.origin)
      return res.status(403).json({error:"Same-origin action required"});
    const owner=await castAuth(req);
    if (!owner) return res.status(401).json({error:"Cloudflare session could not be verified. Refresh Streamer and sign in there if prompted; no VLC code is needed."});
    req.castOwner=owner;
    return next();
  } catch {return res.status(401).json({error:"Cast authorization unavailable"});}
}
app.post("/api/cast/sessions", requireCastControl, asyncH(async(req,res)=>{
  res.status(201).json(await castService.create(req.body,req.castOwner));
}));
app.get("/api/cast/sessions/:id",requireCastControl,asyncH(async(req,res)=>{
  await castService.sweep(); // Do not report an expired/idle session as active.
  const state=castService.status(req.params.id,req.castOwner);
  if (!state) return res.status(404).end();
  res.json(state);
}));
app.delete("/api/cast/sessions/:id",requireCastControl,asyncH(async(req,res)=>{
  if (!castService.owned(req.params.id,req.castOwner))return res.status(404).end();
  await castService.stop(req.params.id);
  res.status(204).end();
}));
app.get("/cast/media/:id/:token/:file",asyncH((req,res)=>
  req.hostname === CAST_RECEIVER_HOST && CAST_RECEIVER_HOST
    ? castService.media(req,res)
    : res.status(404).end()));

// Browser-native APNE playback: serve only completed, registered APNE MP4s.
// Unlike /stream/item, this sends the original H.264/AAC file with HTTP byte
// ranges; iOS Safari/QuickTime use their native player, with no MJPEG or WebCodecs.
async function requireApneNativeAccess(req, res, next) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  const localHost = req.hostname === "127.0.0.1" || req.hostname === "localhost" || req.hostname === "[::1]";
  const localPeer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  // Local-only preview is disabled in production: Cloudflare's tunnel also
  // connects to this loopback service, so loopback alone is NOT authentication.
  if (process.env.APNE_NATIVE_LOOPBACK_PREVIEW === "1" && localHost && localPeer) return next();
  let origin;
  try { origin = new URL(castControlOrigin); } catch { return res.status(503).end(); }
  if (origin.protocol !== "https:" || req.hostname !== origin.hostname) return res.status(404).end();
  try {
    const owner = await castAuth(req);
    if (!owner) return res.status(401).type("text/plain").end("Cloudflare Access sign-in required");
    return next();
  } catch {
    return res.status(401).type("text/plain").end("Cloudflare Access authorization unavailable");
  }
}

// Dedicated cross-device APNE progress. Keep signed Cloudflare Access and same-
// origin write protections; do not mix household APNE episodes with YouTube history.
const apneWatchProgress = createApneProgressStore({ filePath: path.join(config.dataDir, "apne-watch-progress.json") });
app.get("/api/apne/progress", requireApneNativeAccess, asyncH(async (_req, res) => {
  res.json({ episodes: await apneWatchProgress.list() });
}));
app.get("/api/apne/progress/:showId/:dateKey", requireApneNativeAccess, asyncH(async (req, res) => {
  const entry = await apneWatchProgress.get(req.params.showId, req.params.dateKey);
  res.json({ progress: entry });
}));
app.post("/api/apne/progress/:showId/:dateKey/session", requireApneNativeAccess, asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required" });
  res.status(201).json(await apneWatchProgress.begin(req.params.showId,req.params.dateKey));
}));
app.patch("/api/apne/progress/:showId/:dateKey", requireApneNativeAccess, asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required" });
  res.json({ progress: await apneWatchProgress.update(req.params.showId,req.params.dateKey,req.body || {}) });
}));
app.post("/api/apne/progress/:showId/:dateKey/mark-watched", requireApneNativeAccess, asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({ error: "Same-origin request required" });
  res.json({ progress: await apneWatchProgress.mark(req.params.showId,req.params.dateKey,req.body?.watched) });
}));

async function apneNativeSavedItem(itemId) {
  if (!/^[a-f0-9]{16}$/.test(String(itemId || ""))) return null;
  const found = await store.findItem(itemId);
  if (found?.playlist?.meta?.kind !== "downloaded-files" ||
      found?.item?.type !== "file" || found.item.meta?.source !== "apnetv") return null;
  let filePath, libraryRoot;
  try {
    filePath = await fs.realpath(found.item.url);
    libraryRoot = await fs.realpath(config.libraryDir);
  } catch { return null; }
  const relative = path.relative(libraryRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      path.extname(filePath).toLowerCase() !== ".mp4") return null;
  const info = await fs.stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size <= 0) return null;
  return { filePath, item: found.item };
}

// Private APNE thumbnails: look up only exact saved metadata in the registered
// Downloaded Videos playlist. The existing native saved-file validator also
// enforces canonical library realpath containment, extension and file size.
async function apneThumbnailSavedEpisode(showId, dateKey) {
  const playlists = await store.listPlaylists();
  const candidates = playlists
    .filter((playlist) => playlist?.meta?.kind === "downloaded-files")
    .flatMap((playlist) => playlist.items || []);
  const match = candidates.find((item) =>
    item?.type === "file" && item.meta?.source === "apnetv" &&
    item.meta?.apneShowId === showId && item.meta?.apneEpisodeDate === dateKey);
  if (!match) return null;
  return apneNativeSavedItem(match.id);
}

const apneThumbnails = createApneThumbnailService({
  cacheDir: path.join(config.dataDir, "apne-thumbs"),
  ffmpegPath: config.ffmpegPath,
  resolveSaved: apneThumbnailSavedEpisode,
});
app.get("/apne/thumb/:showId/:dateKey.jpg", requireApneNativeAccess, asyncH(async (req, res) => {
  const result = await apneThumbnails.request(req.params.showId, req.params.dateKey);
  if (result.status === "invalid" || result.status === "missing")
    return res.status(404).end();
  if (result.status === "pending")
    return res.status(202).set("Retry-After", "2").end();
  if (result.status === "cooldown" || result.status === "busy")
    return res.status(503).set("Retry-After", "600").end();
  return res.type("image/jpeg").sendFile(result.file, {
    cacheControl: false,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}));

// Official episode artwork for APNE dates where the original files are
// cloud-offloaded or alternate video sources cannot be safely frame-decoded.
// Private authenticated, on-demand and strictly allowlisted; no MP4 hydration.
const apneOfficialArtwork = createApneOfficialArtwork({
  cacheDir: path.join(config.dataDir, "apne-official-artwork", "anupamaa"),
});
app.get("/apne/official-thumb/:showId/:dateKey.jpg", requireApneNativeAccess, asyncH(async (req, res) => {
  const result = await apneOfficialArtwork.request(req.params.showId,req.params.dateKey);
  if (result.status === "missing") return res.status(404).end();
  if (result.status === "pending") return res.status(202).set("Retry-After","2").end();
  if (result.status === "cooldown" || result.status === "busy") return res.status(503).set("Retry-After","600").end();
  return res.type("image/jpeg").sendFile(result.file, {
    cacheControl: false,
    headers: { "Cache-Control":"private, no-store, max-age=0", "X-Content-Type-Options":"nosniff", "Content-Disposition":"inline" },
  });
}));

// Phase C: read-only stills from a strictly bounded slice of UNSAVED HLS.
// Same signed Cloudflare policy as saved MP4 thumbnails and native playback.
const apneLiveThumbnails = createApneLiveThumbnailService({
  cacheDir: path.join(config.dataDir, "apne-thumbs-live"),
  ffmpegPath: config.ffmpegPath,
  canPreview: async (showId, dateKey) =>
    await apneDaily.hasConfiguredApneShow(showId) &&
    !(await apneThumbnailSavedEpisode(showId, dateKey)),
  resolveEpisode: apneDaily.resolveApneEpisodeByDate,
});
app.get("/apne/live-thumb/:showId/:dateKey.jpg", requireApneNativeAccess, asyncH(async (req, res) => {
  const result = await apneLiveThumbnails.request(req.params.showId, req.params.dateKey);
  if (result.status === "invalid" || result.status === "missing")
    return res.status(404).end();
  if (result.status === "pending")
    return res.status(202).set("Retry-After", "3").end();
  if (result.status === "cooldown" || result.status === "busy")
    return res.status(503).set("Retry-After", "900").end();
  return res.type("image/jpeg").sendFile(result.file, {
    cacheControl: false,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}));

app.get("/apne/watch/:itemId", requireApneNativeAccess, asyncH(async (req, res) => {
  const saved = await apneNativeSavedItem(req.params.itemId);
  if (!saved) return res.status(404).type("text/plain").end("Saved APNE episode not found");
  const title = String(saved.item.title || "APNE TV episode").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const videoUrl = "/apne/native-media/" + req.params.itemId + ".mp4";
  const showId = saved.item.meta?.apneShowId;
  const dateKey = saved.item.meta?.apneEpisodeDate;
  const trackable = validApneProgressEpisode(showId,dateKey);
  res.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self'; form-action 'none'; object-src 'none'");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title} — APNE TV</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101214;color:#f5f7fa;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1000px;margin:0 auto;padding:20px 14px 44px}h1{font-size:clamp(19px,4vw,28px);line-height:1.3;margin:22px 0 16px}video{display:block;width:100%;max-height:75vh;aspect-ratio:16/9;background:#000;border-radius:12px}.actions{display:flex;gap:16px;flex-wrap:wrap;margin-top:20px}a{color:#a9d2ff;text-decoration:none;font-weight:600}a:focus-visible{outline:2px solid #a9d2ff;outline-offset:5px}.hint{font-size:13px;color:#b4bdc7;line-height:1.5;margin-top:18px}
</style><script src="/apne-watch-progress.js" defer></script></head><body><main class="wrap"><h1>${title}</h1><video controls playsinline preload="metadata" x-webkit-airplay="allow" src="${videoUrl}" data-progress-show="${trackable ? showId : ''}" data-progress-date="${trackable ? dateKey : ''}">This device does not support MP4 playback.</video><div id="apneWatchProgress" role="status" aria-live="polite"></div><nav class="actions"><a href="${videoUrl}" target="_blank" rel="noopener noreferrer">Open direct MP4</a><a href="/?mode=apne" id="apneReturnToShows">Return to Shows</a><a href="/">YT Streamer home</a></nav><p class="hint">Native MP4 player · Use the player controls to seek, go fullscreen or use AirPlay where supported. A Cloudflare Access login is required on each remote browser.</p></main></body></html>`);
}));

app.get("/apne/native-media/:itemId.mp4", requireApneNativeAccess, asyncH(async (req, res) => {
  const saved = await apneNativeSavedItem(req.params.itemId);
  if (!saved) return res.status(404).type("text/plain").end("Saved APNE episode not found");
  res.type("video/mp4");
  res.sendFile(saved.filePath, {
    acceptRanges: true,
    cacheControl: false,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}));

// Browser-native, on-demand APNE HLS. This does not write episodes to the
// Downloaded Videos library or iCloud; only requested segments flow through.
const apneLiveRelay = createApneLiveRelay();
const apneMp4Relay = createApneMp4Relay();
const apneUnifiedManifests = new Map();
function apneManifestSession(manifest) {
  const current = Date.now();
  for (const [id, entry] of apneUnifiedManifests) if (entry.expires <= current) apneUnifiedManifests.delete(id);
  while (apneUnifiedManifests.size >= 12) apneUnifiedManifests.delete(apneUnifiedManifests.keys().next().value);
  const id = crypto.randomBytes(16).toString("hex");
  apneUnifiedManifests.set(id, {manifest, expires:current + 10 * 60000});
  return "/apne/live/manifest/" + id;
}
// Resolve source selection on the authenticated backend, so the UI never
// receives external streaming URLs or needs to choose between providers.
// Authenticated episode-page metadata: only saved IDs and job state, never local paths.
app.get("/api/apne/episode/:showId/:dateKey", requireApneNativeAccess, asyncH(async (req, res) => {
  const state = await apneDaily.episodePageState(req.params.showId, req.params.dateKey);
  if (state.download.itemId && !await apneNativeSavedItem(state.download.itemId)) {
    state.download = {status:"Not downloaded",itemId:null,detail:"Saved file is missing",error:null};
  }
  res.json(state);
}));
app.post("/api/apne/episode/:showId/:dateKey/download", requireApneNativeAccess, asyncH(async (req, res) => {
  if (!isSameOriginRequest(req)) return res.status(403).json({error:"Same-origin request required."});
  res.status(202).json(await apneDaily.startEpisodeDownload(req.params.showId,req.params.dateKey));
}));

app.get("/apne/live/source/:showId/:dateKey", requireApneNativeAccess, asyncH(async (req, res) => {
  // Use highest-quality available APNE source even on iPhone.
  // Low-bandwidth fallback must never silently downgrade the user to 192p.
  const provider = req.query.provider || "apne";
  if (!["apne","yodesi"].includes(provider) || Array.isArray(req.query.provider)) return res.status(400).json({error:"Invalid source"});
  const resolved = await apneDaily.resolveApneEpisodeByDate(req.params.showId,req.params.dateKey,{provider});
  if (resolved.embedUrls) return res.json({format:"embed",parts:resolved.embedUrls});
  if (resolved.mp4Url) return res.json({format:"mp4",src:apneMp4Relay.open(resolved)});
  const manifest = await apneLiveRelay.start(resolved);
  res.json({format:"hls",src:apneManifestSession(manifest)});
}));
app.get("/apne/live/manifest/:token", requireApneNativeAccess, (req, res) => {
  const entry = apneUnifiedManifests.get(req.params.token);
  if (!entry) return res.status(404).end();
  if (entry.expires <= Date.now()) {apneUnifiedManifests.delete(req.params.token);return res.status(410).end();}
  res.type("application/vnd.apple.mpegurl").send(entry.manifest);
});
app.get("/apne/live/mp4/:token", requireApneNativeAccess, asyncH(async (req, res) => apneMp4Relay.media(req,res)));

app.get("/apne/live/watch/:showId/:dateKey", requireApneNativeAccess, asyncH(async (req, res) => {
  const showId = String(req.params.showId || "");
  const dateKey = String(req.params.dateKey || "");
  if (!/^[a-z0-9-]{1,90}$/.test(showId) || !/^\d{4}-\d{2}-\d{2}(?:-e[1-9]\d{0,5})?$/.test(dateKey)) return res.status(404).end();
  const title = (showId.replace(/-/g, " ") + " — " + dateKey).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const unifiedSource = "/apne/live/source/" + showId + "/" + dateKey;
  res.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src https://www.blogger.com; worker-src blob:; object-src 'none'");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title} — APNE Live</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101214;color:#f5f7fa;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1000px;margin:0 auto;padding:20px 14px 44px}h1{font-size:clamp(19px,4vw,28px);line-height:1.3;margin:22px 0 16px}video,.apne-embed-stage{display:block;width:100%;max-height:75vh;aspect-ratio:16/9;background:#000;border-radius:12px}.apne-embed-stage{overflow:hidden}.apne-embed-stage[hidden],video[hidden]{display:none!important}.apne-embed-stage iframe{width:100%;height:100%;border:0;display:block}.apne-parts{display:flex;gap:12px;margin-top:12px}.apne-parts[hidden]{display:none}.apne-parts button{padding:12px 20px;border:1px solid #536074;background:#202835;color:#f5f7fa;border-radius:9px;font-weight:700;cursor:pointer}.apne-parts button[aria-pressed="true"]{border-color:#a9d2ff;background:#283952}.actions{display:flex;gap:16px;flex-wrap:wrap;margin-top:20px}a{color:#a9d2ff;text-decoration:none;font-weight:600}a:focus-visible{outline:2px solid #a9d2ff;outline-offset:5px}.hint{font-size:13px;color:#b4bdc7;line-height:1.5;margin-top:18px}#apneLiveStatus{font-size:14px;color:#b4bdc7;margin-top:14px}
.apne-options{margin:18px 0 4px;padding:15px;background:#19212e;border:1px solid #35445d;border-radius:12px}.apne-options h2{font-size:17px;margin:0 0 10px}.apne-option-buttons{display:flex;gap:10px;flex-wrap:wrap}.apne-option-buttons button,.apne-download-actions button{background:#283b54;border:1px solid #526e8d;color:white;border-radius:9px;padding:12px 16px;min-height:46px;font-weight:600;cursor:pointer}.apne-option-buttons button[aria-pressed="true"]{border-color:#a7cfff;background:#2d5479}.apne-option-buttons button:disabled,.apne-download-actions button:disabled{opacity:.65;cursor:wait}.apne-note{font-size:13px;line-height:1.5;color:#b6c5d9;margin:9px 0 0}.apne-download-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.apne-download-actions button[data-status="downloading"]{background:#72501d;border-color:#d3a44a}.apne-download-actions button[data-status="downloaded"]{background:#1b593e;border-color:#48a779}.apne-download-actions button[hidden]{display:none}.apne-download-state{margin-top:8px;font-size:14px;color:#d3deef}</style><script src="/apne-live-player.js" defer></script><script src="/apne-episode-ui.js" defer></script><script src="/apne-watch-progress.js" defer></script></head><body><main class="wrap"><h1>${title}</h1><video id="apneLiveVideo" controls playsinline preload="metadata" data-source="${unifiedSource}" data-progress-show="${showId}" data-progress-date="${dateKey}">This browser does not support video.</video><div id="apneEmbedStage" class="apne-embed-stage" hidden></div><div id="apnePartButtons" class="apne-parts" hidden></div><section id="apneEpisodeControls" class="apne-options" data-show-id="${showId}" data-date-key="${dateKey}" aria-label="Episode source and download controls"><h2>Video source</h2><div class="apne-option-buttons" role="group" aria-label="Choose video source"><button type="button" data-apne-provider="apne" aria-pressed="true">APNE / PlayApne</button><button type="button" data-apne-provider="yodesi" aria-pressed="false" hidden>YoDesi</button></div><p class="apne-note" id="apneSourceQuality">Highest available APNE quality. No automatic low-resolution fallback. Actual 720p depends on the provider.</p><div class="apne-download-actions"><button type="button" id="apneDownloadMac" data-status="ready">Download to Mac</button><button type="button" id="apneStreamMac" data-status="downloaded" hidden>Stream from Mac</button></div><p class="apne-download-state" id="apneDownloadState" aria-live="polite">Checking saved episodes…</p></section><p id="apneLiveStatus" role="status">Connecting to APNE…</p><div id="apneWatchProgress" role="status" aria-live="polite"></div><nav class="actions"><a href="/?mode=apne" id="apneReturnToShows">Return to Shows</a><a href="/">YT Streamer home</a></nav><p class="hint">Choose APNE or YoDesi to stream, or download APNE to your Mac. Downloads are also mirrored to iCloud. Requires your Cloudflare Access login.</p></main></body></html>`);
}));
app.get("/apne/live/playlist/:showId/:dateKey.m3u8", requireApneNativeAccess, asyncH(async (req, res) => {
  const resolved = await apneDaily.resolveApneEpisodeByDate(req.params.showId, req.params.dateKey);
  const manifest = await apneLiveRelay.start(resolved);
  res.set("Cache-Control", "private, no-store, max-age=0");
  res.type("application/vnd.apple.mpegurl").send(manifest);
}));
app.get("/apne/live/media/:session/:asset", requireApneNativeAccess, asyncH(async (req, res) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  return apneLiveRelay.media(req, res);
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
app.use("/api/retro-pc/remote",createRetroRemoteHTTP({authenticate:castAuth}));
app.get("/retro-pc/media/xp-pro-sp3-x86.iso", createXPMediaHandler({root:config.root,authenticate:castAuth}));
app.get("/retro-pc/media/blank-hdd.img", createBlankDiskHandler());
app.use(express.static(config.publicDir, { extensions: ["html"] }));
app.get("*", (req, res) => res.sendFile(path.join(config.publicDir, "index.html")));

await Promise.all([
  stream.cleanupStaleHlsFiles().catch((err) => console.error("[startup] hls cleanup -", err.message)),
  cyberdashDash.cleanupStaleDashFiles().catch((err) => console.error("[startup] cyberdash cleanup -", err.message)),
  realChromeRenderer.cleanupOrphans("startup").catch((err) => console.error("[startup] real chrome cleanup -", err.message)),
]);

httpServer = app.listen(config.port, config.host, () => {
  apneBackgroundCheck.start();
  console.log(`\n  YT Streamer webapp`);
  console.log(`  → http://${config.host}:${config.port}`);
  console.log(`  → library: ${config.libraryDir}`);
  console.log(`  → point your Cloudflare Tunnel at http://${config.host}:${config.port}\n`);
});
