// YT Streamer webapp — single-origin Node server: serves the SPA, REST API, and MJPEG streams.
// Designed to sit behind a Cloudflare Tunnel on your custom domain. No auth (single user).
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import * as store from "./lib/store.js";
import * as ytdlp from "./lib/ytdlp.js";
import * as stream from "./lib/stream.js";
import * as catalog from "./lib/catalog.js";
import * as processedLibrary from "./lib/processed-library.js";
import * as youtubeOAuth from "./lib/youtube-oauth.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// In-memory download job tracker (single user, ephemeral is fine).
const jobs = new Map();
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

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("[api]", req.method, req.path, "-", err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, activeStreams: stream.activeStreamCount(), time: Date.now() });
});

// ---------------------------------------------------------------------------
// Playlists CRUD
// ---------------------------------------------------------------------------
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
// MJPEG streaming endpoints
// ---------------------------------------------------------------------------
// Stream a saved item by id (resolves type: m3u8 | youtube | file).
app.get("/stream/item/:itemId", asyncH(async (req, res) => {
  const found = await store.findItem(req.params.itemId);
  if (!found) return res.status(404).json({ error: "item not found" });
  const { item } = found;
  const params = stream.normalizeParams(req.query);

  if (item.type === "youtube") {
    const { videoUrl, audioUrl } = await ytdlp.getStreamUrls(item.url, config.download.maxHeight);
    return stream.streamMjpeg(req, res, { input: videoUrl, audioInput: audioUrl, params, isLive: false, paceInput: true, startAt: req.query.timestamp });
  }
  if (item.type === "file") {
    // Guard: only stream files that live inside the library dir.
    const resolved = path.resolve(item.url);
    if (!resolved.startsWith(path.resolve(config.libraryDir))) {
      return res.status(403).json({ error: "file outside library" });
    }
    try { await fs.access(resolved); } catch { return res.status(404).json({ error: "file missing" }); }
    return stream.streamMjpeg(req, res, { input: resolved, params, isLive: false, startAt: req.query.timestamp });
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
  });
}));

// Stream a YouTube url directly (extract then transcode), without saving.
app.get("/stream/youtube", asyncH(async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "url required" });
  const params = stream.normalizeParams(req.query);
  const { videoUrl, audioUrl } = await ytdlp.getStreamUrls(url, config.download.maxHeight);
  return stream.streamMjpeg(req, res, { input: videoUrl, audioInput: audioUrl, params, isLive: false, paceInput: true, startAt: req.query.timestamp });
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
    const { videoUrl } = await ytdlp.getStreamUrls(item.url, config.download.maxHeight);
    return stream.streamTS(req, res, { input: videoUrl, params, isLive: false, paceInput: true, startAt: req.query.timestamp });
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
  const { videoUrl } = await ytdlp.getStreamUrls(url, config.download.maxHeight);
  return stream.streamTS(req, res, { input: videoUrl, params, isLive: false, paceInput: true, startAt: req.query.timestamp });
}));

// ---- Audio (separate mp3 stream — legacy MJPEG path) ----
app.get("/stream/audio/item/:itemId", asyncH(async (req, res) => {
  const found = await store.findItem(req.params.itemId);
  if (!found) return res.status(404).json({ error: "item not found" });
  const { item } = found;
  if (item.type === "youtube") {
    const { videoUrl, audioUrl } = await ytdlp.getStreamUrls(item.url, config.download.maxHeight);
    return stream.streamAudio(req, res, { input: audioUrl || videoUrl, startAt: req.query.timestamp });
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
  const { videoUrl, audioUrl } = await ytdlp.getStreamUrls(url, config.download.maxHeight);
  return stream.streamAudio(req, res, { input: audioUrl || videoUrl, startAt: req.query.timestamp });
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

app.listen(config.port, config.host, () => {
  console.log(`\n  YT Streamer webapp`);
  console.log(`  → http://${config.host}:${config.port}`);
  console.log(`  → library: ${config.libraryDir}`);
  console.log(`  → point your Cloudflare Tunnel at http://${config.host}:${config.port}\n`);
});
