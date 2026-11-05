// Local fixture browser test for shared CI. No production access or account data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCyberdashDashArgs, parseDashManifest } from "../src/lib/cyberdash-dash.js";

const base = "dfc719cf50d22c794e700d9e514d2fba546520ca";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pub = path.join(root, "webapp/public");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "yt-smart-adaptive-"));
const ff = (...args) => execFileSync(process.env.FFMPEG_PATH || "ffmpeg",
  ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 45000 });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const variants = ["app.js", "index.html", "auto-quality.js", "buffered-mjpeg.js", "cyberdash-embedded.mjs",
  "playback-recovery.js", "playback-diagnostics.js"];
const old = new Map(variants.map(file => [file,
  execFileSync("git", ["show", base + ":webapp/public/" + file], { cwd: root })]));
const starts = [], sessions = new Map();
const engines = process.argv.includes("--mjpeg-only") ? ["mjpeg"] : ["mjpeg", "webcodecs"];
let nextId = 0;
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
const reply = (res, data, type = "application/json") => {
  if (res.destroyed) return;
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};
let server, browser;
try {
  const input = path.join(temp, "source.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "15", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", input);
  const dash = new Map();
  for (const fps of engines.includes("webcodecs") ? [15, 24] : []) {
    const dir = path.join(temp, String(fps));
    await fs.mkdir(dir);
    const manifestPath = path.join(dir, "manifest.mpd");
    const args = buildCyberdashDashArgs({ videoInput: input, fps, height: 480,
      encoder: "libx264", initialBurstSupported: false, manifestPath });
    args.splice(args.indexOf("-readrate"), 2);
    args.splice(args.indexOf("-c:v"), 0, "-preset", "ultrafast");
    ff(...args);
    const manifest = parseDashManifest(await fs.readFile(manifestPath, "utf8"));
    const files = new Map(await Promise.all((await fs.readdir(dir)).map(async name => [name, await fs.readFile(path.join(dir, name))])));
    const tracks = Object.fromEntries(["video", "audio"].map(kind => [kind,
      [...files.keys()].filter(name => name.startsWith(`chunk-${manifest[kind].id}-`)).sort()]));
    dash.set(fps, { manifest, files, tracks });
  }
  const jpeg = new Map(["red", "blue"].map(color => [color, ff("-f", "lavfi", "-i",
    `color=c=${color}:s=320x180:r=1`, "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1")]));
  server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/api/experimental/cyberdash/start") {
        let body = "";
        for await (const bytes of req) body += bytes;
        const { fps, startAt } = JSON.parse(body);
        const id = "fixture-" + ++nextId;
        starts.push({ engine: "webcodecs", fps, startAt });
        sessions.set(id, dash.get(Number(fps)) || dash.get(15));
        if (fps === 24) await sleep(1100);
        reply(res, { id, duration: 100, resolveMs: 0 });
        return;
      }
      const status = u.pathname.match(/^\/api\/experimental\/cyberdash\/([^/]+)\/(status|stop)$/);
      if (status) {
        const [, id, action] = status;
        if (action === "stop") { sessions.delete(id); reply(res, { stopped: true }); return; }
        const { manifest, tracks } = sessions.get(id) || dash.get(15);
        reply(res, { manifestReady: true, manifest,
          init: { video: `init-${manifest.video.id}.m4s`, audio: `init-${manifest.audio.id}.m4s` },
          available: tracks, done: false });
        return;
      }
      const fragment = u.pathname.match(/^\/stream\/experimental\/cyberdash\/([^/]+)\/([^/]+)$/);
      if (fragment) {
        const bytes = sessions.get(fragment[1])?.files.get(fragment[2]);
        if (!bytes) { res.writeHead(404).end(); return; }
        reply(res, bytes, "video/iso.segment");
        return;
      }
      if (u.pathname === "/fixture-mjpeg") {
        const fps = Number(u.searchParams.get("fps"));
        starts.push({ engine: "mjpeg", fps, startAt: Number(u.searchParams.get("at")) });
        if (fps === 24) await sleep(1100);
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=fixture", "cache-control": "no-store" });
        const bytes = jpeg.get(fps === 24 ? "blue" : "red");
        const part = Buffer.concat([Buffer.from(`--fixture\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`),
          bytes, Buffer.from("\r\n")]);
        const tick = () => { if (!res.writableNeedDrain) res.write(part); };
        const timer = setInterval(tick, 1000 / fps);
        res.on("close", () => clearInterval(timer));
        for (let i = 0; i < fps * 4; i++) tick();
        return;
      }
      if (u.pathname.startsWith("/api/")) {
        if (req.method === "POST") for await (const ignored of req) { /* drain */ }
        reply(res, u.pathname === "/api/playlists" ? [] : { ok: true, playlists: [], items: [], sessions: [], data: [] });
        return;
      }
      const file = u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname.slice(1));
      const full = path.resolve(pub, file);
      if (!full.startsWith(pub + path.sep)) { res.writeHead(403).end(); return; }
      const contents = req.headers.cookie?.includes("fixtureBaseline=1") && old.has(file) ? old.get(file) : await fs.readFile(full);
      reply(res, contents, mime[path.extname(file)] || "application/octet-stream");
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    executablePath: process.env.MOBILE_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const results = [];
  for (const engine of engines) {
    for (const baseline of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: "fixtureBaseline", value: baseline ? "1" : "0", url: origin }]);
      await context.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      const fixtureEvents = [];
      const fixtureRequests = [];
      const mode = engine + " / " + (baseline ? "baseline" : "v3");
      console.log("Testing " + mode);
      page.on("pageerror", err => errors.push(err.message));
      page.on("request", request => {
        const url = new URL(request.url());
        if (fixtureRequests.length >= 32) return;
        if (url.pathname.includes("cyberdash") || url.pathname.includes("fixture-mjpeg")) fixtureRequests.push(url.pathname);
        if (url.pathname === "/api/playback-event") {
          const event = request.postDataJSON();
          if (fixtureEvents.length < 32) fixtureEvents.push([event.event, event.reason, event.message, event.errorName]);
        }
      });
      await page.goto(origin + "/?ui=classic", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof stopPlayback === "function" && window.YtAutoQuality);
      await page.evaluate((engine) => {
        beginNewPlaybackQuality();
        soundOn = false;
        const meta = { seekable: true, duration: 100, bufferedMjpeg: true };
        replayFn = (startAt = 0) => engine === "mjpeg"
          ? playBufferedMjpegStream({ mjpegUrl: "/fixture-mjpeg?at=" + startAt + "&fps=" + document.querySelector("#ctlFps").value },
            "Fixture", { ...meta, startAt })
          : playCyberdashStream("https://fixture.invalid/video", "Fixture", { ...meta, startAt });
        replayFn(15);
      }, engine);
      await page.waitForFunction(() => diagnosticsStats?.renderedFrames > 5, null, { timeout: 18000 }).catch(async (error) => {
        const state = await page.evaluate(() => ({ badge: document.querySelector("#streamBadge")?.textContent,
          now: getStreamCurrentTime(), stats: diagnosticsStats, videoDecoder: typeof VideoDecoder,
          audioDecoder: typeof AudioDecoder, screen: document.querySelector("#screen")?.className }));
        throw new Error(mode + " did not start: " + JSON.stringify({ state, errors, fixtureEvents, fixtureRequests }), { cause: error });
      });
      const attemptBefore = await page.evaluate(() => streamAttempt);
      const requestIndex = starts.length;
      const measurement = await page.evaluate(({ engine, baseline }) => {
        const canvas = document.querySelector(engine === "mjpeg" ? "#mjpegCanvas" : "#cyberdashCanvas");
        const pixel = () => [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data].join(",");
        const beforeAttempt = streamAttempt;
        const start = performance.now();
        const resumeAt = getStreamCurrentTime();
        const stats = { ...diagnosticsStats, transport: engine };
        // Force one approved decision to measure the same transition on both builds.
        const decision = baseline
          ? autoQualityController._switch("high", "stable-headroom", stats, Date.now())
          : autoQualityController.switchTo("high", "stable-headroom", performance.now());
        if (!requestAutoQualityTier(decision, stats)) throw Error("Forced switch was refused");
        return new Promise((resolve, reject) => {
          let blankSamples = 0, retainedSamples = 0, changedAt = null;
          const tick = () => {
            const now = performance.now();
            const changed = streamAttempt > beforeAttempt;
            if (changed) changedAt ??= now;
            // Before the delayed response there cannot be a replacement frame.
            if (changedAt != null && now - changedAt < 750) {
              if (!canvas.getClientRects().length || pixel().startsWith("0,0,0,")) blankSamples++;
              else retainedSamples++;
            }
            if (changed && diagnosticsStats?.renderedFrames > 2) {
              resolve({ resumeAt, blankSamples, retainedSamples,
                renderedMs: Math.round(now - start),
                driftMs: diagnosticsStats.lastAvDriftMs ?? null });
            } else if (now - start > 16000) reject(Error("Replacement frames never arrived"));
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }, { engine, baseline });
      assert.ok(starts.slice(requestIndex).some(s => s.engine === engine && s.fps === 24
        && Math.abs(s.startAt - measurement.resumeAt) < 0.4), "replacement must resume at the current position");
      assert.ok((await page.evaluate(() => streamAttempt)) > attemptBefore);
      if (!baseline) {
        assert.equal(measurement.blankSamples, 0, engine + " retained canvas must stay visible");
        assert.ok(measurement.retainedSamples > 10, engine + " must hold the prior frame during delayed replacement");
      }
      await page.evaluate(() => stopPlayback());
      assert.deepEqual(errors, []);
      const result = { engine, controller: baseline ? "baseline" : "v3", ...measurement };
      results.push(result);
      console.log(JSON.stringify(result));
      await context.close();
    }
  }
  console.log(JSON.stringify({ fixture: "loopback; delayed JPEG and generated fMP4; forced tier switch; muted",
    baseline: base, results }, null, 2));
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.rm(temp, { recursive: true, force: true });
}
