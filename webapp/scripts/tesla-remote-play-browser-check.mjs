// Fixture-only browser integration check. This serves the real site and player
// files locally, with fixture owner APIs and no access to a real console.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(WEBAPP, "public");
const PLAYER = path.join(WEBAPP, "tesla-remote-play");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
const USER_AGENTS = {
  desktop: undefined,
  tesla: "Mozilla/5.0 (X11; Linux x86_64; Tesla Model Y) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".gz")) return "application/gzip";
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    if (pathname === "/api/tesla-remote-play/status") {
      response.end(JSON.stringify({ available: true, configured: true }));
    } else if (pathname === "/api/tesla-remote-play/console" && request.method === "GET") {
      response.end(JSON.stringify({
        host: "192.168.50.250",
        registration: { registKey: "0".repeat(32), morning: "1".repeat(32) },
      }));
    } else if (pathname === "/api/tesla-remote-play/console" && request.method === "PUT") {
      response.statusCode = 204;
      response.end();
    } else {
      response.end("{}");
    }
    return;
  }

  let root = PUBLIC;
  let relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (pathname.startsWith("/tesla-remote-play/")) {
    root = PLAYER;
    relative = pathname.slice("/tesla-remote-play/".length) || "index.html";
    if (relative.startsWith("vendor/")) relative = relative.slice("vendor/".length);
    if (!relative.startsWith("vendor/") && ["chiaki.js", "chiaki.wasm", "NOTICE.txt", "AGPL_SOURCE_OFFER.md", "chiaki-ng-web-source.tar.gz"].includes(relative)) {
      relative = path.join("vendor", "chiaki-ng-web", relative);
    }
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
  }

  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.setHeader("Content-Type", contentType(file));
    response.setHeader("Cache-Control", file.endsWith(".wasm") || file.endsWith(".js") ? "public, max-age=300" : "no-store");
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const failures = [];
const measurements = [];
const evidenceDir = process.env.TESLA_REMOTE_PLAY_EVIDENCE_DIR
  ? path.resolve(process.env.TESLA_REMOTE_PLAY_EVIDENCE_DIR) : null;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

try {
  for (const [device, userAgent] of Object.entries(USER_AGENTS)) {
    const context = await browser.newContext({
      viewport: VIEWPORTS[0],
      ...(userAgent ? { userAgent } : {}),
      isMobile: device === "tesla",
      hasTouch: device === "tesla",
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const requestFullscreen = Element.prototype.requestFullscreen;
      window.fullscreenHarness = { mode: "native", requests: 0, supported: Boolean(requestFullscreen) };
      Object.defineProperty(Element.prototype, "requestFullscreen", {
        configurable: true,
        value(options) {
          window.fullscreenHarness.requests++;
          if (window.fullscreenHarness.mode === "unavailable") return undefined;
          if (window.fullscreenHarness.mode === "denied") return Promise.reject(new Error("fullscreen denied"));
          return requestFullscreen
            ? requestFullscreen.call(this, options)
            : Promise.reject(new Error("fullscreen unsupported"));
        },
      });
      window.fullscreenHarness.wrapper = Element.prototype.requestFullscreen;
    });
    page.on("pageerror", (error) => failures.push(`${device}: ${error.message}`));
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
        failures.push(`${device} HTTP ${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    page.routeWebSocket("**/tesla-remote-play/posix-net", (socket) => socket.close());

    for (const mode of ["classic", "new"]) {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/?ui=${mode}`, { waitUntil: "domcontentloaded" });
        const nav = page.locator("#teslaRemotePlayTab");
        if (viewport.width <= 1100) await page.locator("#menuToggle").click();
        await nav.waitFor({ state: "visible", timeout: 15000 }).catch(async (error) => {
          const status = await page.evaluate(async () => (await fetch("/api/tesla-remote-play/status")).text());
          const details = await page.evaluate(() => ({ hidden: document.querySelector("#teslaRemotePlayTab")?.hidden, script: [...document.scripts].some((script) => script.src.includes("tesla-remote-play-nav")) }));
          throw new Error(`${error.message}; fixture status=${status}; nav=${JSON.stringify(details)}; browser errors=${failures.join(" | ")}`);
        });
        if (mode === "new") await page.waitForFunction(() => document.documentElement.dataset.ui === "new", null, { timeout: 10000 });
        else await page.waitForFunction(() => document.documentElement.dataset.ui !== "new", null, { timeout: 10000 });

        const siteWidth = await page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(siteWidth.scroll <= siteWidth.client + 2, `${device} ${mode} site overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(siteWidth)}`);

        const navTarget = await nav.boundingBox();
        assert.ok(navTarget.width >= 44 && navTarget.height >= 44, `${device} ${mode} Remote Play tab is smaller than 44px`);
        await nav.click();
        await page.waitForURL("**/tesla-remote-play/?returnTo=**", { timeout: 10000 });
        await page.locator("#connect").waitFor({ state: "visible", timeout: 10000 });
        const access = await page.evaluate(() => ({
          isolated: crossOriginIsolated,
          shared: typeof SharedArrayBuffer === "function",
        }));
        assert.deepEqual(access, { isolated: true, shared: true }, `${device} ${mode} player isolation`);

        const back = page.locator(".back");
        const backTarget = await back.getAttribute("href");
        assert.ok(backTarget === "/" || backTarget === "/?mode=browse&ui=" + mode, `Unexpected player return target: ${backTarget}`);

        await page.waitForFunction(() => !document.querySelector("#connect")?.disabled, null, { timeout: 5000 }).catch(async () => {
          throw new Error(`Fixture player did not become ready: ${await page.locator("#state").innerText()} · ${await page.locator("#help").innerText()}`);
        });
        await page.locator("#connect").click();
        await page.locator("#player").waitFor({ state: "visible", timeout: 5000 });
        assert.equal(await page.locator("#quality").isVisible(), true, `${device} ${mode} quality visible alongside active player`);
        await page.waitForFunction(() => window.__chiakiWasmReady === 1, null, { timeout: 30000 });
        const playerWidth = await page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll("body *")].map((node) => ({
            tag: node.tagName, id: node.id, className: typeof node.className === "string" ? node.className : "",
            left: Math.round(node.getBoundingClientRect().left), right: Math.round(node.getBoundingClientRect().right),
          })).filter((node) => node.right > document.documentElement.clientWidth + 1 || node.left < -1).slice(-8),
        }));
        assert.ok(playerWidth.scroll <= playerWidth.client + 2, `${device} ${mode} player overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(playerWidth)}`);

        const touchTargets = await page.locator(".back, #connect, #wake, #liveDisconnect, #fullscreen, #quality, #audioToggle, #pairing summary").evaluateAll((nodes) => nodes
          .filter((node) => node.offsetParent !== null)
          .map((node) => ({ id: node.id || node.className, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        for (const target of touchTargets) {
          assert.ok(target.width >= 44 && target.height >= 44, `${device} ${mode} target below 44px at ${viewport.width}×${viewport.height}: ${JSON.stringify(target)}`);
        }
        const playerPadding = await page.locator(".shell").evaluate((node) => ({
          top: parseFloat(getComputedStyle(node).paddingTop),
          right: parseFloat(getComputedStyle(node).paddingRight),
          bottom: parseFloat(getComputedStyle(node).paddingBottom),
          left: parseFloat(getComputedStyle(node).paddingLeft),
        }));
        assert.ok(playerPadding.top >= 4 && playerPadding.right >= 16 && playerPadding.bottom >= 20 && playerPadding.left >= 16,
          `${device} ${mode} player safe-area padding: ${JSON.stringify(playerPadding)}`);
        await page.evaluate(() => {
          for (const [side, value] of Object.entries({ top: "12px", right: "8px", bottom: "20px", left: "8px" })) {
            document.documentElement.style.setProperty(`--safe-${side}`, value);
          }
        });
        const qualities = await page.locator("#quality option").evaluateAll((options) => options.map((option) => option.value));
        assert.deepEqual([...qualities].sort(), ["1080", "540", "720"], `${device} ${mode} quality options`);
        assert.equal(await page.locator("#qualityBefore").inputValue(), "720", `${device} ${mode} default quality`);
        assert.equal(await page.locator("#quality").inputValue(), "720", `${device} ${mode} active-player default quality`);
        const fullscreen = page.locator("#fullscreen");
        assert.equal(await fullscreen.evaluate(el => el.closest(".video-stage")?.id), "",
          `${device} ${mode} fullscreen button must be inside the video viewport`);
        const waitForNativeFullscreen = (expected) => page.waitForFunction((target) => {
          return (document.fullscreenElement === document.querySelector(".video-stage")) === target;
        }, expected, { timeout: 5000 });
        await fullscreen.click();
        if (await page.evaluate(() => window.fullscreenHarness.supported)) {
          await waitForNativeFullscreen(true);
          assert.equal(await fullscreen.getAttribute("aria-pressed"), "true", `${device} ${mode} native fullscreen state`);
          assert.equal(await page.locator(".live-controls").isVisible(), false, `${device} ${mode} settings visible in native fullscreen`);
          const nativeStage = await page.locator(".video-stage").boundingBox();
          assert.ok(nativeStage.width >= viewport.width - 2 && nativeStage.height >= viewport.height - 2,
            `${device} ${mode} native video did not fill viewport: ${JSON.stringify(nativeStage)}`);
          await page.evaluate(() => document.exitFullscreen());
          await waitForNativeFullscreen(false);
          await page.locator("#player:not(.expanded-player)").waitFor({ state: "attached", timeout: 5000 });
          assert.equal(await fullscreen.getAttribute("aria-label"), "Full screen", `${device} ${mode} browser-exit label`);
          await fullscreen.click();
          await waitForNativeFullscreen(true);
          await fullscreen.click();
          await waitForNativeFullscreen(false);
        } else {
          await page.locator("#player.expanded-player").waitFor({ state: "attached" });
          assert.equal(await page.locator(".live-controls").isVisible(), false);
          await fullscreen.click();
          await page.locator("#player:not(.expanded-player)").waitFor({ state: "attached" });
        }
        await page.evaluate(() => { window.fullscreenHarness.mode = "denied"; });
        await fullscreen.click();
        await page.locator("#player.expanded-player").waitFor({ state: "attached" });
        assert.equal(await fullscreen.getAttribute("aria-label"), "Exit full screen", `${device} ${mode} fallback toggle label`);
        assert.equal(await page.locator(".live-controls").isVisible(), false,
          `${device} ${mode} expanded player still shows the settings row`);
        const expandedSize = await page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          player: document.querySelector("#player").getBoundingClientRect().toJSON(),
          stage: document.querySelector(".video-stage").getBoundingClientRect().toJSON(),
          toggle: document.querySelector("#fullscreen").getBoundingClientRect().toJSON(),
        }));
        assert.ok(expandedSize.scroll <= expandedSize.client + 2,
          `${device} ${mode} expanded overflow: ${JSON.stringify(expandedSize)}`);
        assert.ok(expandedSize.stage.width >= viewport.width - 2 && expandedSize.stage.height >= viewport.height - 2,
          `${device} ${mode} video-only fallback does not fill viewport: ${JSON.stringify(expandedSize)}`);
        assert.ok(expandedSize.toggle.width >= 44 && expandedSize.toggle.height >= 44,
          `${device} ${mode} fullscreen toggle below 44px`);
        assert.ok(expandedSize.toggle.left >= 0 && expandedSize.toggle.right <= viewport.width + 1 &&
          expandedSize.toggle.top >= 0 && expandedSize.toggle.bottom <= viewport.height + 1,
          `${device} ${mode} fullscreen control outside viewport`);
        if (device === "tesla" && mode === "classic" && viewport.width === 844 && viewport.height === 390) {
          // Match the main player's 5-second auto-hide and tap-to-reveal.
          await page.waitForFunction(() => document.querySelector(".video-stage")?.classList.contains("fullscreen-controls-idle"),
            null, { timeout: 7500 });
          assert.equal(await fullscreen.isVisible(), true, "Auto-hidden button should remain in DOM");
          assert.equal(await fullscreen.evaluate(el => getComputedStyle(el).pointerEvents), "none");
          await page.locator(".video-stage").click({ position: { x: 25, y: 25 } });
          assert.equal(await fullscreen.evaluate(el => getComputedStyle(el).pointerEvents), "auto",
            "Tapping the video must reveal fullscreen exit control");
          if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, "tesla-video-only-fullscreen.png") });
        }
        await fullscreen.click();
        await page.locator("#player:not(.expanded-player)").waitFor({ state: "attached" });
        await page.locator(".video-stage").evaluate((element) => {
          for (const method of ["requestFullscreen", "webkitRequestFullscreen"]) {
            Object.defineProperty(element, method, { configurable: true, value: undefined });
          }
        });
        await fullscreen.click();
        await page.locator("#player.expanded-player").waitFor({ state: "attached" });
        assert.equal(await fullscreen.getAttribute("aria-label"), "Exit full screen", `${device} ${mode} missing fullscreen API`);
        await fullscreen.dispatchEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        await page.locator("#player:not(.expanded-player)").waitFor({ state: "attached" });
        measurements.push({ device, mode, viewport, siteWidth, playerWidth: { client: playerWidth.client, scroll: playerWidth.scroll }, touchTargets, playerPadding, qualities, expandedSize, nativeFullscreenSupported: await page.evaluate(() => window.fullscreenHarness.supported), isolated: access.isolated, wasmReady: true });

        await back.click();
        await page.waitForURL((url) => url.searchParams.get("mode") === "browse" && url.searchParams.get("ui") === mode, { timeout: 10000 });
        assert.equal(await page.locator('[data-mode="browse"]').getAttribute("aria-current"), "page");
        console.log(`PASS ${device} ${mode} ${viewport.width}×${viewport.height}`);
      }
    }
    await context.close();
  }
  assert.deepEqual(failures, []);
  if (evidenceDir) {
    await writeFile(path.join(evidenceDir, "tesla-remote-play-browser-measurements.json"), JSON.stringify({
      generatedAt: new Date().toISOString(), browser: "Google Chrome via Playwright emulation", physicalDeviceTest: false, measurements,
    }, null, 2) + "\n");
  }
  console.log("PASS fixture navigation, player WASM startup, isolation, player reveal, quality access, return-to-Browse, and touch/layout checks across desktop and Tesla-like Chrome emulation.");
  console.log("Physical Model Y browser and iPhone Safari acceptance were not tested by this fixture run.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
