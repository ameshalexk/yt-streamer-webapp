// Local-only Chrome check: the preview must not restart playback until release.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const source = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const id = "dQw4w9WgXcQ";
const url0 = "https://i.ytimg.com/sb/" + id + "/storyboard3_L2/M0.jpg";
const url1 = "https://i.ytimg.com/sb/" + id + "/storyboard3_L2/M1.jpg";
const metadata = {
  id, title: "Preview fixture", duration: 213, isLive: false,
  storyboard: {width: 160, height: 90, columns: 5, rows: 5, fps: 0.5, urls: [url0, url1]},
};
const types = {".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".svg":"image/svg+xml"};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify(url.pathname === "/api/youtube/info" ? metadata : {ok:true,playlists:[],items:[],sessions:[],data:[]}));
    return;
  }
  const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) {res.writeHead(403); res.end(); return;}
  try {
    const bytes = await fs.readFile(file);
    res.writeHead(200, {"content-type":types[path.extname(file)] || "application/octet-stream"});
    res.end(bytes);
  } catch {res.writeHead(404);res.end();}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.MOBILE_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args:["--no-sandbox"],
});
const site = "http://127.0.0.1:" + server.address().port + "/";
try {
  for (const width of [320, 390, 768, 1280]) {
    const page = await browser.newPage({viewport:{width, height:860}, hasTouch:width===390, isMobile:width===390});
    await page.goto(site, {waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => typeof window.configureStreamSeek === "function", {timeout:15000});
    await page.evaluate((source) => {
      window.setMode("recommended");
      window.beginNewPlaybackQuality();
      document.querySelector("#screen").classList.add("playing","mjpeg-buffered-mode");
      configureStreamSeek({duration:213,seekable:true,youtubeUrl:source},0);
      replayFn = (seconds) => { window.committedSeek = seconds; };
    }, source);
    await page.locator("#streamSeekTrack").scrollIntoViewIfNeeded();
    const box = await page.locator("#streamSeekTrack").boundingBox();
    assert.ok(box?.width > 60, "seek track unavailable at " + width + " " + JSON.stringify(await page.evaluate(() => ({seekable:streamSeek.seekable, duration:streamSeek.duration, hidden:document.querySelector("#streamSeek").hidden, screen:document.querySelector("#screen").getBoundingClientRect().toJSON(), track:document.querySelector("#streamSeekTrack").getBoundingClientRect().toJSON(), visible:document.querySelector("#streamSeekTrack").getClientRects().length}))));
    const x = box.x + box.width * 0.45;
    const y = box.y + box.height * 0.5;
    await page.mouse.move(x,y);
    await page.mouse.down();
    await page.waitForFunction(() => seekPreview.metadataCache.has("dQw4w9WgXcQ"), null, {timeout:10000});
    if (width >= 390)
      await page.waitForFunction(() => document.querySelector("#streamSeekPreview").classList.contains("has-frame"), null, {timeout:10000});
    const hovered = await page.evaluate(() => ({
      time:document.querySelector("#streamSeekPreviewTime").textContent,
      img:document.querySelector("#streamSeekPreviewFrame").style.backgroundImage,
      committed:window.committedSeek,
      preview:document.querySelector("#streamSeekPreview").getBoundingClientRect().toJSON(),
      track:document.querySelector("#streamSeekTrack").getBoundingClientRect().toJSON(),
      screen:document.querySelector("#screen").getBoundingClientRect().toJSON(),
    }));
    assert.ok(hovered.time, "missing seek timestamp at " + width);
    if (width >= 390)
      assert.ok(hovered.img.includes("M1.jpg"), "wrong frame at " + width + ": " + JSON.stringify(hovered));
    assert.equal(hovered.committed, undefined, "drag unexpectedly seeks");
    assert.ok(hovered.preview.left >= -1 && hovered.preview.right <= width + 1, "preview overflows viewport at " + width);
    assert.ok(hovered.preview.top >= hovered.screen.top - 1 && hovered.preview.bottom <= hovered.screen.bottom + 1,
      "preview clipped by player at " + width + ": " + JSON.stringify(hovered));
    await page.mouse.move(box.x + box.width * 0.30, y, {steps:5});
    assert.equal(await page.evaluate(() => window.committedSeek), undefined, "drag seeks before release");
    await page.mouse.up();
    const committed = await page.evaluate(() => ({
      time:window.committedSeek,
      hidden:document.querySelector("#streamSeekPreview").hidden,
    }));
    assert.ok(committed.time > 60 && committed.time < 70, "wrong committed time " + JSON.stringify(committed));
    assert.equal(committed.hidden, true, "preview stays visible after release");
    console.log("PASS " + width + "px: preview frame, bounded popup, drag/release seek");
    await page.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
