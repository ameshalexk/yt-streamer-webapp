// Local-only Google Chrome check for the real playback speed picker in both UI modes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(app, "public");
const baselineRef = process.env.SPEED_MENU_BASELINE_REF;
const originalCss = baselineRef ? execFileSync("git", ["show", `${baselineRef}:webapp/public/styles.css`], { cwd: app, encoding: "utf8" }) : null;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(url.pathname === "/api/playlists" ? [] : { ok: true, playlists: [], items: [], sessions: [], data: [] }));
    return;
  }
  const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.resolve(pub, `.${relative}`);
  if (!file.startsWith(pub + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
const sockets = new Set();
server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const executablePath = process.env.CHROME_PATH || process.env.MOBILE_TEST_CHROME || process.env.CHROME_BIN || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ["--no-sandbox"] });
try {
  for (const [width, height] of [[320,568],[375,812],[390,844],[430,932],[768,1024],[844,390]]) {
    for (const ui of ["classic", "new"]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      await page.goto(`http://127.0.0.1:${server.address().port}/?ui=${ui}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof window.beginNewPlaybackQuality === "function" && document.querySelector("#playbackSpeedSelect"), null, { timeout: 15000 });
      await page.evaluate(() => {
        document.querySelector("#screen").classList.add("playing", "mjpeg-buffered-mode");
        youtubePlaybackMethod = "webcodecs";
        renderYoutubePlaybackMethod();
      });
      if (width === 320 && ui === "classic" && originalCss) {
        await page.evaluate(() => { document.querySelector('link[href*="styles.css"]').disabled = true; });
        const baselineStyle = await page.addStyleTag({ content: originalCss });
        const original = await page.locator("#playbackSpeedSelect").evaluate(select => {
          const style = getComputedStyle(select), option = getComputedStyle(select.options[0]);
          return { color: style.color, colorScheme: style.colorScheme, optionColor: option.color, optionBackground: option.backgroundColor, height: select.getBoundingClientRect().height };
        });
        await baselineStyle.evaluate(el => el.remove());
        await page.evaluate(() => { document.querySelector('link[href*="styles.css"]').disabled = false; });
        console.log(`BASELINE ${ui} ${width}x${height} (${baselineRef}): ${JSON.stringify(original)}`);
      }
      const metrics = await page.locator("#playbackSpeedSelect").evaluate(select => {
        const style = getComputedStyle(select), option = getComputedStyle(select.options[0]);
        const wrapper = select.closest(".playback-speed-control");
        return { color: style.color, colorScheme: style.colorScheme, optionColor: option.color,
          optionBackground: option.backgroundColor, minHeight: style.minHeight, selectHeight: select.getBoundingClientRect().height,
          selectWidth: select.getBoundingClientRect().width,
          wrapperHeight: wrapper.getBoundingClientRect().height, wrapperMinHeight: getComputedStyle(wrapper).minHeight,
          overflow: document.documentElement.scrollWidth - innerWidth, count: select.options.length,
          values: Array.from(select.options, item => item.value) };
      });
      assert.equal(metrics.colorScheme, "light", `${ui} ${width}: expected light native picker palette`);
      assert.equal(metrics.optionColor, "rgb(17, 17, 17)", `${ui} ${width}: expected dark option text`);
      assert.equal(metrics.optionBackground, "rgb(255, 255, 255)", `${ui} ${width}: expected opaque option background`);
      assert.ok(metrics.selectWidth >= 44 && metrics.selectHeight >= 44 && metrics.wrapperHeight >= 44, `${ui} ${width}: target below 44px ${JSON.stringify(metrics)}`);
      assert.equal(metrics.count, 6, `${ui} ${width}: speed options changed`);
      assert.ok(metrics.overflow <= 2, `${ui} ${width}: horizontal overflow`);
      if (width === 320 && ui === "classic") {
        const timerScheduled = await page.evaluate(() => {
          const monitor = new PlaybackRecovery.Monitor({ recover() {} });
          const result = monitor.request("failure", { key: "speed-menu-fixture" });
          monitor.reset();
          return result;
        });
        assert.equal(timerScheduled, true, "playback recovery timer should schedule and cancel in Chrome");
      }
      if (width === 390 && ui === "classic") {
        await page.locator("#playbackSpeedSelect").click();
        await page.waitForTimeout(200);
        await page.screenshot({ path: "/tmp/yt-speed-menu-popup-attempt.png" });
      }
      const speedSelect = page.locator("#playbackSpeedSelect");
      const rates = ["1", "1.25", "1.5", "2", "3", "4"];
      assert.deepEqual(metrics.values, rates, `${ui} ${width}: expected all six playback rates`);
      if (width === 320 && ui === "classic") {
        for (const rate of rates) {
          await speedSelect.selectOption(rate);
          assert.equal(await speedSelect.inputValue(), rate, `speed selection did not change to ${rate}x`);
        }
        await speedSelect.selectOption("1");
      } else {
        await speedSelect.selectOption("2");
        assert.equal(await speedSelect.inputValue(), "2", `${ui} ${width}: selection did not change to 2x`);
      }
      if (width === 320 && ui === "classic") await page.screenshot({ path: "/tmp/yt-speed-menu-mobile.png" });
      if (width === 320 && ui === "classic") console.log(`UPDATED ${ui} ${width}x${height}: ${JSON.stringify(metrics)}`);
      console.log(`PASS ${ui} ${width}x${height}: native menu contrast, ${metrics.selectHeight}px select, no overflow`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  const stopped = new Promise(resolve => server.close(resolve));
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  await stopped;
}
