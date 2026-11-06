// Independent localhost smoke test. No production endpoint or deployed files.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(url.pathname === "/api/playlists" ? [] : { ok: true, playlists: [], items: [] }));
  }
  const full = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
  if (!full.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const bytes = await fs.readFile(full);
    res.writeHead(200, { "content-type": mime[path.extname(full)] || "application/octet-stream" });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.MOBILE_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true, args: ["--no-sandbox"],
  });
  for (const style of ["classic", "new"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const url = `http://127.0.0.1:${server.address().port}/?ui=${style}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.renderYoutubePlaybackMethod === "function");
    const toggle = page.locator("#bufferLabToggle");
    assert.equal(await toggle.count(), 1, style + ": unique toggle");
    assert.equal(await toggle.isChecked(), false, style + ": default off");
    assert.equal(await toggle.isDisabled(), true, style + ": disabled while MJPEG selected");
    await page.locator('[data-playback-method="webcodecs"]').click();
    assert.equal(await toggle.isDisabled(), false, style + ": enabled for WebCodecs");
    await toggle.check();
    assert.equal(await page.evaluate(() => localStorage.getItem("ytStreamerBufferLabV1")), "1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.renderYoutubePlaybackMethod === "function");
    assert.equal(await toggle.isChecked(), true, style + ": persisted on reload");
    await toggle.uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem("ytStreamerBufferLabV1")), null);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.renderYoutubePlaybackMethod === "function");
    assert.equal(await toggle.isChecked(), false, style + ": revert to baseline");
    await page.locator('[data-playback-method="mjpeg"]').click();
    assert.equal(await toggle.isDisabled(), true, style + ": MJPEG remains untouched");
    console.log(`PASS ${style}: Buffer Lab off / opt-in / persisted / reverted`);
    await ctx.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
