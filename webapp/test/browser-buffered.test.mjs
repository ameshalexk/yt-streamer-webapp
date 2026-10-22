import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const chrome = process.env.CHROME_PATH || (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");

function jpegFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      // Keep this tiny synthetic fixture from fanning out across every runner
      // core while the full Node test suite is running in parallel.
      "-filter_threads", "1",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=1",
      "-frames:v", "1",
      "-threads:v", "1",
      "-q:v", "7",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    let settled = false;
    const fixtureDeadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("ffmpeg JPEG fixture did not finish within 10000 ms"));
    }, 10_000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(fixtureDeadline);
      reject(new Error(`ffmpeg JPEG fixture failed to start: ${error.message}`, { cause: error }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(fixtureDeadline);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg JPEG fixture exited ${code}: ${stderr || "no diagnostic output"}`));
    });
  });
}

function writePart(res, jpeg) {
  res.write(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${jpeg.byteLength}\r\n\r\n`);
  res.write(jpeg);
  res.write("\r\n");
}

async function closeWithin(label, operation, onTimeout) {
  let timer;
  const finished = await Promise.race([
    Promise.resolve().then(operation).then(() => true, (error) => {
      console.warn(`${label} cleanup failed: ${error.message}`);
      return true;
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  clearTimeout(timer);
  if (!finished) {
    console.warn(`${label} cleanup exceeded 5000 ms; forcing it closed`);
    void Promise.resolve().then(onTimeout).catch((error) => {
      console.warn(`${label} forced cleanup failed: ${error.message}`);
    });
  }
}

test("headless Chrome re-buffers after uneven delivery and remains bounded", { timeout: 70_000 }, async () => {
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

  let browser;
  let browserServer;
  try {
    await new Promise((resolve, reject) => {
      const listenDeadline = setTimeout(() => reject(new Error("buffered MJPEG fixture server did not start within 5000 ms")), 5_000);
      server.once("error", (error) => {
        clearTimeout(listenDeadline);
        reject(new Error(`buffered MJPEG fixture server failed to start: ${error.message}`, { cause: error }));
      });
      server.listen(0, "127.0.0.1", () => {
        clearTimeout(listenDeadline);
        resolve();
      });
    });
    const { port } = server.address();
    try {
      browserServer = await chromium.launchServer({
        executablePath: chrome,
        headless: true,
        timeout: 20_000,
        args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
      });
    } catch (error) {
      throw new Error(`headless Chrome launch failed: ${error.message}`, { cause: error });
    }
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: 5_000 });
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
    if (browserServer) {
      await closeWithin("Chrome", () => browserServer.close(), () => browserServer.kill());
    }
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closeWithin("buffered MJPEG fixture server", () => serverClosed, () => server.closeAllConnections?.());
  }
});
