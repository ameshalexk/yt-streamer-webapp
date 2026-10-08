#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");
const qaDir = path.join(repoRoot, ".local-ui-v3", "QA");
const chromeCandidates = [
  process.env.UI_V3_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
].filter(Boolean);
const screenshotFiles = [];
const failures = [];
const notes = [];
const serverLog = [];
const browserLog = [];
const fixtureApiLog = [];
let server;
let browser;
let tempRoot;
let port;

function redact(text) {
  return String(text).replace(/([?&](?:token|access_token|refresh_token|key|api_key|code)=)[^&#\s]*/gi, "$1[redacted]");
}

function appendBounded(target, value, limit = 250) {
  target.push(redact(value).slice(0, 1600));
  if (target.length > limit) target.splice(0, target.length - limit);
}

function check(name, callback) {
  return Promise.resolve().then(callback).then(() => {
    console.log(`PASS ${name}`);
  }).catch((error) => {
    failures.push({ name, error: redact(error?.stack || error?.message || error) });
    console.error(`FAIL ${name}: ${redact(error?.message || error)}`);
  });
}

async function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      await fs.access(candidate);
      const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
      const version = `${result.stdout || ""}${result.stderr || ""}`.trim();
      if (result.status === 0 && /Google Chrome/i.test(version)) return { path: candidate, version };
    } catch {}
  }
  throw new Error("Google Chrome was not found. Set UI_V3_CHROME_PATH to an installed Google Chrome executable; this check does not substitute Chromium or Safari.");
}

async function freePort() {
  const net = await import("node:net");
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const value = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return value;
}

async function waitForHealth(url, child) {
  const until = Date.now() + 20_000;
  let lastError;
  while (Date.now() < until) {
    if (child.exitCode != null) throw new Error(`Isolated app server exited (${child.exitCode}). ${serverLog.join("").slice(-2500)}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Isolated app server did not become ready: ${lastError?.message || "timeout"}. ${serverLog.join("").slice(-2500)}`);
}

async function makeMediaFixture() {
  const file = path.join(tempRoot, "ui-v3-generated-test-pattern.mp4");
  const ffmpeg = process.env.UI_V3_FFMPEG_PATH || "ffmpeg";
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=44100",
    "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    notes.push(`Local media playback fixture unavailable (ffmpeg status ${result.status}); identity, source-attribute, and request invariance checks still run. ${redact(result.stderr || "")}`);
    return null;
  }
  return file;
}

async function visible(page, selector) {
  return page.locator(selector).evaluate(element => !element.hidden && getComputedStyle(element).display !== "none");
}

async function selectNewUI(page) {
  if (await page.locator("html").getAttribute("data-ui") !== "new") {
    await page.locator("#uiSwitch [data-ui-mode='new']").click();
    await page.waitForFunction(() => document.documentElement.dataset.ui === "new");
  }
}

async function viewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
}

async function screenshot(page, name) {
  const file = path.join(qaDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  screenshotFiles.push(path.basename(file));
}

function fixtureApi(pathname) {
  if (pathname === "/api/health") return { activeStreams: 0, uptime: 0 };
  if (pathname.startsWith("/api/sessions")) return { realChrome: [], browser: [], counts: { browserSessions: 0, realChromeSessions: 0, audioStreams: 0 } };
  if (pathname === "/api/apne-daily") return { today: "", shows: [] };
  if (pathname === "/api/youtube-auth/status") return { configured: false, connected: false };
  if (pathname === "/api/browser/audio-sources" || pathname === "/api/desktop/sources") return { audio: [] };
  if (pathname === "/api/catalog/channels") return { channels: [], total: 0 };
  if (["/api/playlists", "/api/saved-embeds", "/api/legacy-library", "/api/legacy-library/playlists", "/api/watch-history", "/api/browser-history", "/api/catalog"].includes(pathname)) return [];
  return {};
}

async function installFixtureRoutes(context, { mediaFile = null, externalDashboards = false } = {}) {
  await context.route("**/*", async route => {
    const parsed = new URL(route.request().url());
    const pathname = parsed.pathname;
    if (pathname.startsWith("/api/")) {
      appendBounded(fixtureApiLog, `${route.request().method()} ${pathname}`, 1000);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureApi(pathname)) });
      return;
    }
    if (mediaFile && pathname.startsWith("/__ui_v3_fixture_media__/")) {
      await route.fulfill({ status: 200, contentType: "video/mp4", path: mediaFile, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
      return;
    }
    if (externalDashboards && (pathname === "/tesla" || pathname === "/money")) {
      const name = pathname.slice(1);
      await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Fixture ${name}</title><main data-ui-v3-fixture="${name}">External dashboard navigation fixture</main>` });
      return;
    }
    await route.continue();
  });
}

async function main() {
  await fs.mkdir(qaDir, { recursive: true });
  for (const name of [
    "desktop-classic-after-toggle.png", "desktop-new.png", "tesla-1280x720.png", "tesla-driver-1280x720.png",
    "tesla-passenger-1500x850.png", "phone-390x844.png", "phone-auto-driver-390x844.png", "tv-1920x1080.png",
    "desktop-fullscreen-return.png", "ui-v3-browser-report.json", "ui-v3-browser.log",
  ]) await fs.rm(path.join(qaDir, name), { force: true });
  const chrome = await findChrome();
  console.log(`Google Chrome: ${chrome.version}`);
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yt-streamer-ui-v3-qa-"));
  const isolated = {
    data: path.join(tempRoot, "data"),
    library: path.join(tempRoot, "library"),
    apne: path.join(tempRoot, "apne-icloud"),
  };
  await Promise.all(Object.values(isolated).map(directory => fs.mkdir(directory, { recursive: true })));
  port = await freePort();
  const serverEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    TMPDIR: tempRoot,
    LANG: process.env.LANG || "en_US.UTF-8",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: isolated.data,
    LIBRARY_DIR: isolated.library,
    APNE_ICLOUD_DIR: isolated.apne,
    YOUTUBE_OAUTH_TOKEN_FILE: path.join(isolated.data, "youtube-oauth.json"),
    DESKTOP_STREAM_ENABLED: "0",
    DESKTOP_INPUT_ENABLED: "0",
    NODE_ENV: "test",
  };
  server = spawn(process.execPath, ["src/server.js"], { cwd: appRoot, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => appendBounded(serverLog, chunk.toString()));
  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin, server);

  const mediaFile = await makeMediaFixture();
  browser = await chromium.launch({
    executablePath: chrome.path,
    headless: true,
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests = [];
  let mainNavigations = 0;
  page.on("request", request => {
    if (requests.length < 2000) requests.push({ method: request.method(), url: redact(request.url()) });
  });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) mainNavigations += 1; });
  page.on("console", message => {
    if (message.type() === "error") appendBounded(browserLog, `console.error ${message.text()}`);
  });
  page.on("pageerror", error => appendBounded(browserLog, `pageerror ${error.stack || error.message}`));
  // All browser API responses and external dashboards are local fixtures. No live APNE, Tesla, or Money API is reached.
  await installFixtureRoutes(context, { mediaFile, externalDashboards: true });

  await check("isolated backend serves actual app static assets with empty fixture state", async () => {
    const response = await page.goto(origin, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await page.locator("#uiSwitch [data-ui-mode='classic']").waitFor();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("online"));
    await page.waitForFunction(() => window.YTStreamerModernUI && document.querySelector("#screen"));
    assert.equal(await page.locator("html").getAttribute("data-ui"), null, "fresh browser defaults to Classic");
    assert.equal(await visible(page, "#uiSwitch"), true);
  });

  await check("actual modern init succeeds; Classic round trip preserves the shared player and media", async () => {
    const stableSelectors = ["#screen", "#video", "#audio", "#mjpeg", "#mjpegCanvas", "#cyberdashCanvas", "#pauseFrame"];
    await page.evaluate(selectors => {
      window.__uiV3Identity = Object.fromEntries(selectors.map(selector => [selector, document.querySelector(selector)]));
      window.__uiV3ScreenParent = document.querySelector("#screen").parentElement;
    }, stableSelectors);
    assert.equal(await page.evaluate(() => window.YTStreamerModernUI.init()), true);
    // Calling init a second time must be idempotent; then the real switch owns the class/attribute.
    await page.locator("#uiSwitch [data-ui-mode='new']").click();
    await page.waitForFunction(() => document.documentElement.dataset.ui === "new");
    await page.waitForSelector(".modern-intro");
    const duplicateIntroCount = await page.locator(".modern-intro").count();
    assert.equal(duplicateIntroCount, 1, "initialization is idempotent");
    assert.equal(await page.locator("html").getAttribute("data-ui"), "new");

    if (mediaFile) {
      const mediaUrl = `${origin}/__ui_v3_fixture_media__/${path.basename(mediaFile)}`;
      // Serve generated media only through this browser-context route; it is never added to the app library.
      await context.route("**/__ui_v3_fixture_media__/**", async route => {
        await route.fulfill({ status: 200, contentType: "video/mp4", path: mediaFile, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
      });
      await page.evaluate(async url => {
        const video = document.querySelector("#video");
        const audio = document.querySelector("#audio");
        video.src = url;
        audio.src = url;
        video.loop = true;
        audio.loop = true;
        await Promise.all([video, audio].map(element => new Promise((resolve, reject) => {
          if (element.readyState >= 2) return resolve();
          element.addEventListener("loadeddata", resolve, { once: true });
          element.addEventListener("error", () => reject(new Error(`fixture media failed (${element.error?.code || "unknown"})`)), { once: true });
        })));
      }, mediaUrl);
    }

    const mediaBefore = await page.evaluate(selectors => ({
      identitiesPreserved: selectors.every(selector => document.querySelector(selector) === window.__uiV3Identity[selector]),
      screenParentPreserved: document.querySelector("#screen").parentElement === window.__uiV3ScreenParent,
      sources: Object.fromEntries(["#video", "#audio"].map(selector => [selector, document.querySelector(selector).getAttribute("src")])),
    }), stableSelectors);
    assert.equal(mediaBefore.identitiesPreserved, true, "all screen/video/audio/canvas nodes remain the same DOM nodes");
    assert.equal(mediaBefore.screenParentPreserved, true, "screen is not reparented");
    const navigationCountBeforeSwitches = mainNavigations;
    await page.locator("#uiSwitch [data-ui-mode='classic']").click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ui"));
    const afterPausedReturn = await page.evaluate(() => ({
      sources: [document.querySelector("#video").getAttribute("src"), document.querySelector("#audio").getAttribute("src")],
      paused: [document.querySelector("#video").paused, document.querySelector("#audio").paused],
    }));
    assert.deepEqual(afterPausedReturn.sources, mediaBefore.sources ? [mediaBefore.sources["#video"], mediaBefore.sources["#audio"]] : [null, null]);
    assert.deepEqual(afterPausedReturn.paused, [true, true], "paused intent remains paused");
    assert.equal(await page.locator(".modern-intro").count(), 0, "Classic removes temporary New-only presentation nodes");
    assert.equal(await page.locator(".modern-now-playing").count(), 0, "Classic has no New-only player proxy");

    if (mediaFile) {
      await page.evaluate(async () => { await Promise.all([document.querySelector("#video").play(), document.querySelector("#audio").play()]); });
      await page.waitForFunction(() => !document.querySelector("#video").paused && !document.querySelector("#audio").paused);
      const startTimes = await page.evaluate(() => [document.querySelector("#video").currentTime, document.querySelector("#audio").currentTime]);
      const apiRequestCountBefore = fixtureApiLog.length;
      await page.locator("#uiSwitch [data-ui-mode='new']").click();
      await page.waitForFunction(() => document.documentElement.dataset.ui === "new");
      await page.locator("#uiSwitch [data-ui-mode='classic']").click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute("data-ui"));
      const playingAfter = await page.evaluate(() => ({
        paused: [document.querySelector("#video").paused, document.querySelector("#audio").paused],
        times: [document.querySelector("#video").currentTime, document.querySelector("#audio").currentTime],
        sources: [document.querySelector("#video").getAttribute("src"), document.querySelector("#audio").getAttribute("src")],
      }));
      assert.deepEqual(playingAfter.paused, [false, false], "playing intent survives New then Classic");
      assert.deepEqual(playingAfter.sources, [mediaBefore.sources["#video"], mediaBefore.sources["#audio"]]);
      assert(playingAfter.times.every((time, index) => time >= startTimes[index]), "playback position is not rewound");
      assert.equal(fixtureApiLog.length, apiRequestCountBefore, "UI switching adds no API or stream calls");
    } else {
      notes.push("Paused and playing media continuity could not run because the local ffmpeg fixture was unavailable.");
    }
    await screenshot(page, "desktop-classic-after-toggle");
    await page.locator("#uiSwitch [data-ui-mode='new']").click();
    await page.waitForFunction(() => document.documentElement.dataset.ui === "new");
    assert.equal(mainNavigations, navigationCountBeforeSwitches, "UI changes use the same document with no reload");
    await screenshot(page, "desktop-new");
  });

  await check("all in-app view navigation remains reachable in New UI; Tesla and Money are fixture intercepted", async () => {
    await selectNewUI(page);
    const views = [
      ["browse", "#channelsView"], ["recommended", "#recommendationsView"], ["browser", "#browserView"],
      ["library", "#legacyLibraryView"], ["apne", "#apneDailyView"], ["watch", "#layout"],
    ];
    for (const [mode, selector] of views) {
      await page.locator(`.mode-tabs [data-mode='${mode}']`).click();
      await page.waitForTimeout(120);
      assert.equal(await visible(page, selector), true, `${mode} view is visible`);
    }
    for (const [mode, fixtureName] of [["tesla", "tesla"], ["money", "money"]]) {
      const popupPromise = page.waitForEvent("popup");
      await page.locator(`.mode-tabs [data-mode='${mode}']`).click();
      const popup = await popupPromise;
      await popup.waitForURL(url => new URL(url).pathname === `/${fixtureName}`);
      await popup.waitForLoadState("domcontentloaded");
      assert.equal(await popup.locator(`[data-ui-v3-fixture='${fixtureName}']`).count(), 1, `popup ${popup.url()} displays its local fixture`);
      await popup.close();
    }
    assert.equal(requests.some(request => request.method !== "GET" && /\/tesla|\/money/i.test(request.url)), false, "external nav fixtures issued no commands");
    await page.locator(".mode-tabs [data-mode='watch']").click();
  });

  await check("layout, quick-side preferences, device geometry, reduced motion, and fullscreen", async () => {
    await selectNewUI(page);
    await page.locator(".mode-tabs [data-mode='watch']").click();
    const select = page.locator("#modernDeviceLayout");
    await select.waitFor({ state: "visible" });
    await viewport(page, 1920, 1080);
    await select.selectOption("tesla");
    await page.waitForFunction(() => document.documentElement.dataset.deviceLayout === "tesla");
    const quickButtons = page.locator(".modern-quick-dock > button");
    await page.locator("button[data-quick-side='driver']").click();
    assert.equal(await page.locator("html").getAttribute("data-quick-side"), "driver", "Tesla starts from the driver-side placement");
    const boxes = await quickButtons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, y: r.y }; }));
    assert(boxes.length >= 2, "quick dock buttons exist");
    assert(boxes.every(box => box.width >= 56 && box.height >= 56), `Tesla quick targets are at least 56px: ${JSON.stringify(boxes)}`);

    await viewport(page, 1280, 720);
    await page.waitForFunction(() => document.documentElement.dataset.deviceLayout === "tesla");
    const tesla720 = await quickButtons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
    assert(tesla720.every(box => box.width >= 56 && box.height >= 56), "Tesla 1280x720 targets stay >=56px");
    await screenshot(page, "tesla-driver-1280x720");
    await viewport(page, 1500, 850);
    const tesla850 = await quickButtons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
    assert(tesla850.every(box => box.width >= 56 && box.height >= 56), "Tesla 1500x850 targets stay >=56px");
    const driverAt1500 = await quickButtons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, width: r.width }; }));
    const driverCenter = driverAt1500.reduce((sum, box) => sum + box.x + box.width / 2, 0) / driverAt1500.length;
    await page.locator("button[data-quick-side='passenger']").click();
    const passengerBoxes = await quickButtons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, width: r.width }; }));
    const passengerCenter = passengerBoxes.reduce((sum, box) => sum + box.x + box.width / 2, 0) / passengerBoxes.length;
    assert(passengerCenter > driverCenter + 10, "passenger side relocates quick actions across the screen");
    await screenshot(page, "tesla-passenger-1500x850");

    await select.selectOption("auto");
    await page.waitForFunction(() => document.documentElement.dataset.deviceLayout === "auto");
    await page.locator("button[data-quick-side='driver']").click();
    assert.equal(await page.locator("html").getAttribute("data-quick-side"), "driver", "phone test resets to Driver side");
    await viewport(page, 390, 844);
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    const phoneGeometry = await page.evaluate(() => ({
      layout: document.documentElement.dataset.deviceLayout,
      side: document.documentElement.dataset.quickSide,
      overflow: document.documentElement.scrollWidth > innerWidth,
      switch: document.querySelector("#uiSwitch").getBoundingClientRect().toJSON(),
      dock: [...document.querySelectorAll(".modern-quick-dock > button")].map(node => node.getBoundingClientRect().toJSON()),
    }));
    assert.equal(phoneGeometry.layout, "auto", "phone viewport uses Auto layout");
    assert.equal(phoneGeometry.side, "driver", "phone viewport uses Driver placement");
    assert.equal(phoneGeometry.overflow, false, "phone viewport has no horizontal page overflow");
    assert(phoneGeometry.switch.width > 0 && phoneGeometry.switch.right <= 390, "phone UI switch remains on-screen");
    assert(phoneGeometry.dock.length >= 2 && phoneGeometry.dock.every(box => box.height >= 56), "phone quick actions retain forgiving tap height");
    const phoneDockReachable = phoneGeometry.dock.every(box => box.y >= 0 && box.bottom <= 844);
    if (!phoneDockReachable) notes.push("Phone 390x844 Auto/Driver: quick actions extend below the initial viewport; vertical scrolling is required to reach all dock actions.");
    else notes.push("Phone 390x844 Auto/Driver: every quick action is reachable in the initial viewport.");
    await screenshot(page, "phone-auto-driver-390x844");

    const tv = await browser.newContext({ viewport: { width: 1920, height: 1080 }, userAgent: "Mozilla/5.0 (BRAVIA; SonyDTV) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });
    await installFixtureRoutes(tv);
    const tvPage = await tv.newPage();
    await tvPage.goto(origin, { waitUntil: "domcontentloaded" });
    await tvPage.locator("#uiSwitch [data-ui-mode='new']").click();
    await tvPage.waitForFunction(() => document.documentElement.dataset.deviceLayout === "tv");
    const tvTargets = await tvPage.locator(".mode-tab").evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== "none").map(node => node.getBoundingClientRect().height));
    assert(tvTargets.every(height => height >= 56), `TV navigation targets >=56px, got ${tvTargets}`);
    await screenshot(tvPage, "tv-1920x1080");
    await tv.close();

    const motion = await page.locator(".mode-tab").first().evaluate(node => getComputedStyle(node).transitionDuration.split(",").map(value => parseFloat(value) || 0));
    assert(motion.every(seconds => seconds <= 0.01), `reduced motion is respected (${motion})`);
    await page.locator("#uiSwitch [data-ui-mode='new']").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("html").getAttribute("data-ui"), "new", "keyboard activates New UI");
    const focusStyle = await page.locator("#uiSwitch [data-ui-mode='new']").evaluate(node => ({ active: document.activeElement === node, outlineWidth: parseFloat(getComputedStyle(node).outlineWidth) }));
    assert(focusStyle.active && focusStyle.outlineWidth >= 2, "keyboard focus remains visible");
    await page.evaluate(() => document.querySelector("#screen").requestFullscreen());
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector("#screen"));
    assert.equal(await visible(page, ".modern-quick-dock"), false, "quick actions hide while the shared screen is fullscreen");
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    await screenshot(page, "desktop-fullscreen-return");
  });

  await check("per-browser mode and quick placement preferences persist without leaking between contexts", async () => {
    const first = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await installFixtureRoutes(first);
    const firstPage = await first.newPage();
    await firstPage.goto(origin, { waitUntil: "domcontentloaded" });
    await firstPage.locator("#uiSwitch [data-ui-mode='new']").click();
    await firstPage.locator("#modernDeviceLayout").selectOption("tesla");
    await firstPage.locator("[data-quick-side='passenger']").click();
    await firstPage.reload({ waitUntil: "domcontentloaded" });
    await firstPage.waitForFunction(() => document.documentElement.dataset.ui === "new");
    assert.equal(await firstPage.locator("#modernDeviceLayout").inputValue(), "tesla");
    assert.equal(await firstPage.locator("button[data-quick-side='passenger']").getAttribute("aria-pressed"), "true");
    const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await installFixtureRoutes(second);
    const secondPage = await second.newPage();
    await secondPage.goto(origin, { waitUntil: "domcontentloaded" });
    await secondPage.waitForFunction(() => window.YTStreamerModernUI);
    assert.equal(await secondPage.locator("html").getAttribute("data-ui"), null, "a separate browser context defaults to Classic");
    assert.equal(await secondPage.evaluate(() => localStorage.getItem("ytStreamerModernQuickSide")), null, "device quick-side preference does not leak");
    await first.close();
    await second.close();
  });

  await check("missing modern script, throwing initializer, and failed CSS remain recoverable in actual Chrome", async () => {
    for (const fault of ["missing-script", "throw-init", "failed-css"]) {
      const faultContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await installFixtureRoutes(faultContext);
      if (fault === "missing-script") await faultContext.route("**/modern-ui.js*", route => route.abort());
      if (fault === "failed-css") await faultContext.route("**/modern-ui.css*", route => route.abort());
      if (fault === "throw-init") await faultContext.route("**/modern-ui.js*", route => route.fulfill({
        status: 200, contentType: "application/javascript",
        body: "window.YTStreamerModernUI={init(){throw new Error('fixture init failure')}};window.dispatchEvent(new CustomEvent('yt-streamer-modern-ready',{detail:window.YTStreamerModernUI}));",
      }));
      await faultContext.addInitScript(() => localStorage.setItem("ytStreamerUiMode", "new"));
      const faultPage = await faultContext.newPage();
      await faultPage.goto(`${origin}/?ui=new`, { waitUntil: "domcontentloaded" });
      await faultPage.waitForSelector("#uiSwitch [data-ui-mode='classic']");
      await faultPage.waitForTimeout(250);
      assert.equal(await faultPage.locator("html").getAttribute("data-ui"), null, `${fault} falls back to Classic`);
      assert.equal(await visible(faultPage, "#layout"), true, `${fault} leaves the existing app usable`);
      assert.equal(await visible(faultPage, "#uiSwitch"), true, `${fault} leaves the recovery toggle available`);
      await faultContext.close();
    }
  });

  if (browserLog.length) notes.push(`Browser console/page errors captured: ${browserLog.length}; see local QA log.`);
  await fs.writeFile(path.join(qaDir, "ui-v3-browser.log"), [
    `Chrome ${chrome.version}`,
    `Origin ${origin}`,
    `Isolated fixture state ${tempRoot}`,
    "External Tesla/Money destinations were intercepted with local fixture documents.",
    `Fixture API responses: ${fixtureApiLog.length}; all browser API requests were served in-browser.`,
    ...notes.map(note => `LIMITATION ${note}`),
    ...browserLog,
    ...serverLog.map(line => `SERVER ${line.trim()}`),
  ].join("\n") + "\n");
  if (failures.length) throw new Error(`${failures.length} browser check(s) failed; details are in the run output and local QA log.`);
  await fs.writeFile(path.join(qaDir, "ui-v3-browser-report.json"), JSON.stringify({
    result: "passed", chrome: chrome.version, viewportCoverage: ["1920x1080 desktop", "1280x720 Tesla Driver default", "1500x850 Tesla Driver/Passenger geometry", "390x844 phone Auto/Driver", "1920x1080 TV/Bravia UA"],
    screenshotFiles, notes,
  }, null, 2) + "\n");
  console.log(`QA artifacts: ${qaDir}`);
  for (const note of notes) console.log(`LIMITATION ${note}`);
}

try {
  await main();
} catch (error) {
  failures.push({ name: "browser harness", error: redact(error?.stack || error?.message || error) });
  console.error(`FATAL ${redact(error?.message || error)}`);
  try {
    await fs.mkdir(qaDir, { recursive: true });
    await fs.writeFile(path.join(qaDir, "ui-v3-browser.log"), [
      ...failures.map(failure => `FAIL ${failure.name}\n${failure.error}`),
      ...serverLog.map(line => `SERVER ${line.trim()}`),
      ...browserLog,
    ].join("\n") + "\n");
  } catch {}
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode == null) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit").catch(() => {}), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (server.exitCode == null) server.kill("SIGKILL");
  }
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

if (failures.length) process.exitCode = 1;
