import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function jpegFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=1",
      "-frames:v", "1",
      "-q:v", "7",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(stderr || `ffmpeg exited ${code}`)));
  });
}

function writePart(res, jpeg) {
  res.write(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${jpeg.byteLength}\r\n\r\n`);
  res.write(jpeg);
  res.write("\r\n");
}

test("headless Chrome re-buffers after uneven delivery and remains bounded", { timeout: 30_000 }, async () => {
  const [script, jpeg] = await Promise.all([
    readFile(new URL("../public/buffered-mjpeg.js", import.meta.url), "utf8"),
    jpegFixture(),
  ]);
  const timers = new Set();
  let streamClosed = false;

  const server = http.createServer((req, res) => {
    if (req.url === "/buffered-mjpeg.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      res.end(script);
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-MJPEG-Boundary": "ffmpeg",
        "X-MJPEG-FPS": "12",
      });
      let sent = 0;
      const schedule = (fn, delay) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, delay);
        timers.add(timer);
      };
      const burst = (count, delayBetween, done) => {
        const send = () => {
          if (res.destroyed) return;
          if (count <= 0) return done();
          writePart(res, jpeg);
          sent += 1;
          count -= 1;
          schedule(send, delayBetween);
        };
        send();
      };
      // 1.5 s of media quickly, then a deliberate 2.2 s network gap,
      // followed by enough frames to refill and finish.
      burst(18, 8, () => {
        schedule(() => burst(30, 12, () => {
          streamClosed = true;
          res.end();
        }), 2200);
      });
      req.on("close", () => { streamClosed = true; });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><canvas id="c"></canvas><script src="/buffered-mjpeg.js"></script><script>
      window.states = [];
      window.done = false;
      const player = new BufferedMjpeg.BufferedMjpegPlayer({
        url: "/stream",
        canvas: document.querySelector("#c"),
        fps: 12,
        sessionId: 1,
        isCurrent: () => true,
        audioEnabled: () => false,
        startupSeconds: 1,
        rebufferSeconds: 0.5,
        maxQueueSeconds: 2,
        maxQueueBytes: 4 * 1024 * 1024,
        onState: (state, detail) => { window.states.push({state, detail, at: performance.now()}); },
        onStats: (stats) => { window.stats = stats; },
        onError: (error) => { window.error = error.message; window.done = true; },
        onEnded: () => { window.done = true; },
      });
      window.player = player;
      player.start();
    </script>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.done === true, null, { timeout: 20_000 });
    const result = await page.evaluate(() => ({
      states: window.states.map((item) => item.state),
      stats: window.stats,
      error: window.error || null,
      canvas: [document.querySelector("#c").width, document.querySelector("#c").height],
    }));

    assert.equal(result.error, null);
    assert.ok(result.states.filter((state) => state === "buffering").length >= 2);
    assert.ok(result.stats.rebufferCount >= 1);
    assert.equal(result.stats.renderedFrames, 48);
    assert.ok(result.stats.maxQueueSeconds <= 2);
    assert.ok(result.stats.maxQueueBytes <= 4 * 1024 * 1024);
    assert.deepEqual(result.canvas, [160, 90]);
    assert.equal(streamClosed, true);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await browser?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
