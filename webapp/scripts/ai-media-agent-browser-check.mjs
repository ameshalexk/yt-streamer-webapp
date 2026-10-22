// Real Google Chrome coverage for the opt-in browser adapter and the existing
// YT Streamer player. Search results and media bytes are deterministic fixtures;
// all commands, pairing, state readback, and player rendering use real pages.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startLocalAgentRelay } from "./ai-agent-local-relay.mjs";

const WEBAPP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(WEBAPP_DIR, "src", "server.js");
const LIVE_YOUTUBE = process.argv.includes("--live");
const CHROME = process.env.MOBILE_TEST_CHROME || process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EVIDENCE_DIR = path.join(WEBAPP_DIR, "docs", "ai-media-agent-phase1-evidence", LIVE_YOUTUBE ? "live-youtube" : "browser-fixture");
const FIXTURE = {
  id: "jNQXAC9IVRw",
  title: "AI Media Agent Browser Test Fixture",
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  duration: 45,
  channelTitle: "Local fixture",
  thumbnail: null,
  isLive: false,
  isUpcoming: false,
};
const LEGACY_FIXTURE = {
  id: "L1VE0000001",
  title: "AI Media Agent Live MJPEG Fixture",
  url: "https://www.youtube.com/watch?v=L1VE0000001",
  duration: null,
  channelTitle: "Local fixture",
  thumbnail: null,
  isLive: true,
  isUpcoming: false,
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function makeVideoFixture() {
  const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=royalblue:s=320x180:r=1", "-frames:v", "1", "-q:v", "7", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { timeout: 12000, maxBuffer: 1000000 });
  assert.equal(result.status, 0, result.stderr?.toString() || "ffmpeg fixture generation failed");
  return result.stdout;
}

function makeAudioFixture() {
  const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "45", "-vn", "-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"], { timeout: 15000, maxBuffer: 3000000 });
  assert.equal(result.status, 0, result.stderr?.toString() || "ffmpeg audio fixture generation failed");
  return result.stdout;
}

function multipartFixture(jpeg, frames = 540) {
  const boundary = "aiagentphase1";
  const partHeader = Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  const parts = [];
  for (let index = 0; index < frames; index += 1) parts.push(partHeader, jpeg, Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function launchServer(port, dirs) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dirs.data,
    LIBRARY_DIR: dirs.library,
    APNE_ICLOUD_DIR: dirs.apne,
    YOUTUBE_OAUTH_TOKEN_FILE: path.join(dirs.data, "oauth.json"),
    REAL_CHROME_PROFILE_DIR: path.join(dirs.data, "real-chrome-profile"),
    CATALOG_COUNTRIES_URL: "http://127.0.0.1:1/disabled",
    CATALOG_COUNTRY_PLAYLIST_BASE_URL: "http://127.0.0.1:1/disabled",
  };
  delete env.XPC_SERVICE_NAME;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: WEBAPP_DIR, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  return { child, get stderr() { return stderr; } };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

async function waitForServer(server, origin) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`webapp exited before ready: ${server.stderr}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`webapp startup timed out: ${server.stderr}`);
}

async function pair(page, { relayPort, pairingToken, label }) {
  await page.locator("#aiAgentRelay").fill(String(relayPort));
  await page.locator("#aiAgentPairing").fill(pairingToken);
  await page.locator("#aiAgentLabel").fill(label);
  await page.locator("#aiAgentConnect").click();
  await page.waitForFunction(() => document.querySelector("#aiAgentStatus")?.textContent.startsWith("Paired "), null, { timeout: 10000 });
  const text = await page.locator("#aiAgentStatus").textContent();
  assert.match(text, /^Paired /, `tab should pair successfully: ${text}`);
}

async function runTargetedControls(controller, target, targetId, modeLabel) {
  await controller.locator("#aiAgentTarget").selectOption(targetId);
  await controller.locator("#aiAgentAction").selectOption("search_media");
  const query = LIVE_YOUTUBE ? (process.env.AI_AGENT_SEARCH_QUERY || "Me at the zoo") : "AI media agent browser test";
  await controller.locator("#aiAgentArg").fill(query);
  await controller.locator("#aiAgentSend").click();
  try {
    await controller.waitForFunction(() => {
      try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").accepted?.result?.results?.length > 0; } catch { return false; }
    }, null, { timeout: LIVE_YOUTUBE ? 95000 : 12000 });
  } catch {
    throw new Error(`${modeLabel}: search command did not return results: ${await controller.locator("#aiAgentResult").textContent()}`);
  }
  const results = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(results.accepted.device_id, targetId, `${modeLabel}: search must use selected target`);
  assert.equal(results.accepted.status, "completed");
  const mediaId = await controller.locator("#aiAgentMedia option").first().getAttribute("value");
  assert.ok(mediaId, `${modeLabel}: a selected search result must have a media ID`);
  await controller.locator("#aiAgentMedia").selectOption(mediaId);

  const serialization = await target.evaluate(async (selectedMediaId) => {
    const screen = document.querySelector("#screen");
    const oldClassName = screen.className;
    const oldReplayFn = replayFn;
    const oldStream = streamYoutubeSearchResult;
    const oldStop = stopPlayback;
    const order = [];
    replayFn = () => {};
    screen.classList.add("playing");
    streamYoutubeSearchResult = async () => {
      order.push("play-start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push("play-ready");
    };
    stopPlayback = () => order.push("stop");
    try {
      await Promise.all([
        YTStreamerMediaAgent.execute("play_media", { media_id: selectedMediaId }),
        YTStreamerMediaAgent.execute("stop", {}),
      ]);
      return order;
    } finally {
      streamYoutubeSearchResult = oldStream;
      stopPlayback = oldStop;
      replayFn = oldReplayFn;
      screen.className = oldClassName;
    }
  }, mediaId);
  assert.deepEqual(serialization, ["play-start", "play-ready", "stop"], `${modeLabel}: stop must wait for playback setup before stopping it`);

  await controller.locator("#aiAgentAction").selectOption("play_media");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return ["playing", "failed", "timeout_uncertain"].includes(JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").observed?.state?.playback_phase) || JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").observed?.status === "timeout_uncertain"; } catch { return false; }
  }, null, { timeout: 70000 });
  let output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.device_id, targetId, `${modeLabel}: play must use selected target`);
  assert.equal(output.accepted.status, "accepted");
  const playbackDiagnostic = await target.evaluate(() => ({
    snapshot: globalThis.YTStreamerMediaAgent.get_player_state(),
    screen: document.querySelector("#screen")?.className,
    badge: document.querySelector("#streamBadge")?.textContent,
    stats: activeCompat?.bufferedPlayer?.getStats?.(),
    streamNotice: document.querySelector("#streamNotice")?.textContent,
  }));
  assert.equal(output.observed?.state?.playback_phase, "playing", `${modeLabel}: report observed playback with player evidence; controller=${JSON.stringify(output)} target=${JSON.stringify(playbackDiagnostic)}`);
  assert.equal(output.observed?.state?.media_id, mediaId);
  const renderedAtPlay = output.observed.state.rendered_frames;
  assert.ok(renderedAtPlay >= 1, `${modeLabel}: playing requires rendered frame evidence`);

  await controller.locator("#aiAgentAction").selectOption("pause");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { const value = JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}"); return value.accepted?.state?.playback_phase === "paused"; } catch { return false; }
  }, null, { timeout: 8000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.device_id, targetId);
  assert.equal(output.accepted.state.playback_phase, "paused");
  assert.equal(output.accepted.state.paused, true);

  await controller.locator("#aiAgentAction").selectOption("resume");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { const value = JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}"); return value.observed?.state?.playback_phase === "playing" || value.observed?.status === "timeout_uncertain"; } catch { return false; }
  }, null, { timeout: 70000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.device_id, targetId);
  assert.equal(output.observed?.state?.playback_phase, "playing", `${modeLabel}: resume must be confirmed from current player state`);
  assert.ok(output.observed.state.rendered_frames > renderedAtPlay, `${modeLabel}: resume must advance rendered frames`);
  await controller.locator("#aiAgentAction").selectOption("get_player_state");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").accepted?.state?.playback_phase === "playing"; } catch { return false; }
  }, null, { timeout: 8000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.state.playback_phase, "playing");
  assert.ok(output.accepted.state.rendered_frames > renderedAtPlay, `${modeLabel}: resume must advance rendered frames`);

  await controller.locator("#aiAgentAction").selectOption("stop");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").accepted?.state?.playback_phase === "idle"; } catch { return false; }
  }, null, { timeout: 8000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.device_id, targetId);
  assert.equal(output.accepted.state.playback_phase, "idle");
  const unrelated = await target.evaluate(() => globalThis.YTStreamerMediaAgent.get_player_state());
  assert.equal(unrelated.playback_phase, "idle", `${modeLabel}: selected target should be stopped after test`);
  return { resultCount: results.accepted.result.results.length, play: "observed playing", pause: "observed paused", resume: "observed playing with frame progression", stop: "observed idle" };
}

async function runLegacyMjpegControls(controller, target, targetId) {
  await controller.locator("#aiAgentTarget").selectOption(targetId);
  await controller.locator("#aiAgentAction").selectOption("search_media");
  await controller.locator("#aiAgentArg").fill("legacy live fixture");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").accepted?.result?.results?.length > 0; } catch { return false; }
  }, null, { timeout: 12000 });
  const mediaId = await controller.locator("#aiAgentMedia option").first().getAttribute("value");
  assert.equal(mediaId, LEGACY_FIXTURE.id);
  await controller.locator("#aiAgentMedia").selectOption(mediaId);
  await controller.locator("#aiAgentAction").selectOption("play_media");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").observed?.state?.playback_phase === "playing"; } catch { return false; }
  }, null, { timeout: 12000 });
  let output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.device_id, targetId);
  const liveState = await target.evaluate(() => ({
    state: YTStreamerMediaAgent.get_player_state(),
    screen: document.querySelector("#screen")?.className,
    badge: document.querySelector("#streamBadge")?.className,
    frame: { width: document.querySelector("#mjpeg")?.naturalWidth, height: document.querySelector("#mjpeg")?.naturalHeight },
  }));
  assert.equal(liveState.state.mode, "mjpeg", `legacy fallback should be active: ${JSON.stringify(liveState)}`);
  assert.equal(liveState.state.playback_phase, "playing", `legacy fallback readback should confirm the displayed frame: ${JSON.stringify(liveState)}`);
  assert.match(liveState.badge, /\blive\b/);
  assert.ok(liveState.frame.width > 0 && liveState.frame.height > 0);

  await controller.locator("#aiAgentAction").selectOption("pause");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").accepted?.state?.playback_phase === "paused"; } catch { return false; }
  }, null, { timeout: 8000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.state.playback_phase, "paused");

  await controller.locator("#aiAgentAction").selectOption("resume");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").observed?.state?.playback_phase === "playing"; } catch { return false; }
  }, null, { timeout: 12000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.observed.state.mode, "mjpeg");
  assert.equal(output.observed.state.playback_phase, "playing");

  await controller.locator("#aiAgentAction").selectOption("stop");
  await controller.locator("#aiAgentSend").click();
  await controller.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("#aiAgentResult")?.textContent || "{}").accepted?.state?.playback_phase === "idle"; } catch { return false; }
  }, null, { timeout: 8000 });
  output = JSON.parse(await controller.locator("#aiAgentResult").textContent());
  assert.equal(output.accepted.device_id, targetId);
  assert.equal(output.accepted.state.playback_phase, "idle");
  return { mode: "legacy MJPEG", play: "observed displayed frame", pause: "observed paused", resume: "observed displayed frame", stop: "observed idle" };
}

async function responsiveEvidence(page, mode, evidence) {
  const viewports = [
    { name: "320x740", width: 320, height: 740, screenshot: true },
    { name: "375x812", width: 375, height: 812 },
    { name: "390x844", width: 390, height: 844, screenshot: true },
    { name: "430x932", width: 430, height: 932 },
    { name: "iPad 1024x768", width: 1024, height: 768, screenshot: true },
    { name: "mobile landscape 844x390", width: 844, height: 390, screenshot: true },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const measurements = await page.evaluate(() => {
      const panel = document.querySelector("#aiAgentDevPanel");
      const rect = panel?.getBoundingClientRect();
      const touchTargets = [...(panel?.querySelectorAll("input,select,button,summary") || [])]
        .filter((el) => !el.hidden && el.getClientRects().length)
        .map((el) => ({ id: el.id, height: Math.round(el.getBoundingClientRect().height) }));
      return {
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        panel: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        touchTargets,
      };
    });
    assert.ok(measurements.panel, `${mode} ${viewport.name}: panel is present`);
    assert.ok(measurements.panel.left >= 0 && measurements.panel.right <= viewport.width, `${mode} ${viewport.name}: panel fits viewport`);
    assert.ok(measurements.document <= viewport.width, `${mode} ${viewport.name}: no document horizontal overflow (${measurements.document}px > ${viewport.width}px)`);
    assert.ok(measurements.body <= viewport.width, `${mode} ${viewport.name}: no body horizontal overflow (${measurements.body}px > ${viewport.width}px)`);
    assert.ok(measurements.touchTargets.every((item) => item.height >= 44), `${mode} ${viewport.name}: touch targets meet 44px minimum`);
    evidence.push({ mode, size: viewport.name, ...measurements, touchTargetMinimum: Math.min(...measurements.touchTargets.map((item) => item.height)) });
    if (viewport.screenshot) await page.locator("#aiAgentDevPanel").screenshot({ path: path.join(EVIDENCE_DIR, `${mode}-${viewport.width}x${viewport.height}.png`) });
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-ai-agent-phase1-"));
const dirs = { data: path.join(root, "data"), library: path.join(root, "library"), apne: path.join(root, "apne") };
await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
await fs.mkdir(EVIDENCE_DIR, { recursive: true });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const ownerToken = crypto.randomBytes(32).toString("base64url");
const pairingToken = crypto.randomBytes(32).toString("base64url");
let server;
let relay;
let browser;
const evidence = [];

try {
  const jpeg = LIVE_YOUTUBE ? null : makeVideoFixture();
  const mp3 = LIVE_YOUTUBE ? null : makeAudioFixture();
  const multipart = LIVE_YOUTUBE ? null : multipartFixture(jpeg);
  server = launchServer(port, dirs);
  await waitForServer(server, origin);
  relay = await startLocalAgentRelay({ ownerToken, pairingToken, browserOrigin: origin, timeoutMs: 95000, ttlMs: 7000 });
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  async function openTarget(label, uiMode, { forceLegacy = false } = {}) {
    const page = await context.newPage();
    if (forceLegacy) await page.addInitScript(() => {
      Object.defineProperty(window, "MediaSource", { configurable: true, value: undefined });
      Object.defineProperty(window, "ManagedMediaSource", { configurable: true, value: undefined });
    });
    if (!LIVE_YOUTUBE) {
      await page.route("**/api/youtube/search**", async (route) => {
        const query = new URL(route.request().url()).searchParams.get("q") || "";
        const item = query.includes("legacy") ? LEGACY_FIXTURE : FIXTURE;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ query, items: [item] }) });
      });
      await page.route("**/stream/youtube**", async (route) => route.fulfill({ status: 200, headers: { "content-type": `multipart/x-mixed-replace; boundary=${multipart.boundary}`, "x-mjpeg-fps": "12", "cache-control": "no-store" }, body: multipart.body }));
      await page.route("**/stream/audio/youtube**", async (route) => route.fulfill({ status: 200, headers: { "content-type": "audio/mpeg", "cache-control": "no-store" }, body: mp3 }));
    }
    await page.goto(`${origin}/?ai_agent_dev=1&ui=${uiMode}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof globalThis.YTStreamerMediaAgent?.execute === "function", null, { timeout: 10000 });
    if (uiMode === "new") await page.waitForFunction(() => document.documentElement.dataset.ui === "new", null, { timeout: 15000 });
    await pair(page, { relayPort: new URL(relay.origin).port, pairingToken, label });
    return page;
  }

  const targetClassic = await openTarget("Target classic", "classic");
  const targetNew = await openTarget("Target experimental", "new");
  const targetLegacy = LIVE_YOUTUBE ? null : await openTarget("Legacy MJPEG target", "classic", { forceLegacy: true });
  const decoy = await openTarget("Unselected decoy", "classic");
  const controllerClassic = await context.newPage();
  await controllerClassic.goto(`${origin}/?ai_agent_dev=1&ui=classic`, { waitUntil: "domcontentloaded" });
  const controllerNew = await context.newPage();
  await controllerNew.goto(`${origin}/?ai_agent_dev=1&ui=new`, { waitUntil: "domcontentloaded" });
  await controllerNew.waitForFunction(() => document.documentElement.dataset.ui === "new", null, { timeout: 15000 });

  for (const controller of [controllerClassic, controllerNew]) {
    await controller.locator("#aiAgentRelay").fill(String(new URL(relay.origin).port));
    await controller.locator("#aiAgentOwner").fill(ownerToken);
    await controller.locator("#aiAgentRefresh").click();
    try {
      const expectedDevices = LIVE_YOUTUBE ? 3 : 4;
      await controller.waitForFunction((count) => document.querySelectorAll("#aiAgentTarget option").length === count, expectedDevices, { timeout: 8000 });
    } catch {
      const state = await controller.locator("#aiAgentResult").textContent();
      const options = await controller.locator("#aiAgentTarget").evaluate((element) => [...element.options].map((item) => item.textContent));
      throw new Error(`device refresh failed (${options.length} options): ${state}`);
    }
  }
  const devices = await relay.registry.list("owner");
  const classicDevice = devices.find((item) => item.label === "Target classic");
  const newDevice = devices.find((item) => item.label === "Target experimental");
  const legacyDevice = devices.find((item) => item.label === "Legacy MJPEG target");
  const decoyDevice = devices.find((item) => item.label === "Unselected decoy");
  assert.ok(classicDevice && newDevice && decoyDevice && (LIVE_YOUTUBE || legacyDevice), "all explicitly paired browser sessions should be listed");
  assert.equal(await targetClassic.evaluate(() => document.documentElement.dataset.ui || "classic"), "classic");
  assert.equal(await targetNew.evaluate(() => document.documentElement.dataset.ui), "new");

  const classicActions = await runTargetedControls(controllerClassic, targetClassic, classicDevice.device_id, "classic player / controller");
  const newActions = LIVE_YOUTUBE ? { skipped: "experimental player flow covered by the deterministic browser check" } : await runTargetedControls(controllerNew, targetNew, newDevice.device_id, "experimental player / controller");
  const legacyActions = targetLegacy ? await runLegacyMjpegControls(controllerClassic, targetLegacy, legacyDevice.device_id) : { skipped: "live YouTube test covers buffered MJPEG; legacy fallback is covered in the deterministic browser check" };
  const decoyState = await decoy.evaluate(() => globalThis.YTStreamerMediaAgent.get_player_state());
  assert.equal(decoyState.playback_phase, "idle", "commands must leave the unselected browser session idle");
  assert.equal(decoyState.media_id, "");

  await responsiveEvidence(controllerClassic, "classic", evidence);
  await responsiveEvidence(controllerNew, "experimental", evidence);
  const report = {
    tested_at: new Date().toISOString(),
    browser: `Google Chrome ${browser.version()}`,
    browser_mode: LIVE_YOUTUBE ? "headless real Chrome; live yt-dlp YouTube search and YT Streamer stream; no real iPhone Safari" : "headless real Chrome via Playwright; synthetic local media fixture; no real iPhone Safari",
    player: "existing YT Streamer buffered MJPEG player",
    selected_targets: { classic: classicDevice.device_id, experimental: newDevice.device_id, legacy_mjpeg: legacyDevice?.device_id || null, unselected_decoy: decoyDevice.device_id },
    flows: { classic: classicActions, experimental: newActions, legacy_mjpeg: legacyActions, unselected_decoy: "remained idle" },
    responsive: evidence,
  };
  const reportPath = path.join(EVIDENCE_DIR, "browser-check.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ browser: report.browser, flows: report.flows, responsiveSizes: [...new Set(evidence.map((item) => item.size))], reportPath: path.relative(WEBAPP_DIR, reportPath), screenshots: (await fs.readdir(EVIDENCE_DIR)).filter((name) => name.endsWith(".png")) }, null, 2));
  await context.close();
} finally {
  await browser?.close().catch(() => {});
  await relay?.close().catch(() => {});
  await stopServer(server);
  await fs.rm(root, { recursive: true, force: true });
}
