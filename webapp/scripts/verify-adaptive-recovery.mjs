import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";

const SITE = "https://stream.ameshalex.com";
const PRIMARY = "https://www.youtube.com/watch?v=e_04ZrNroTo";
const OUT = process.env.HOME + "/ytstreamer-adaptive-recovery.json";
const STALL_MS = 9500;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const report = { site: SITE, stallMs: STALL_MS, startedAt: new Date().toISOString(), stalls: [], browserErrors: [] };
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
page.setDefaultTimeout(120_000);
page.on("pageerror", (error) => report.browserErrors.push("pageerror: " + error.message));
page.on("console", (message) => {
  if (message.type() === "error") report.browserErrors.push("console: " + message.text());
});

async function snapshot() {
  return page.evaluate(() => ({
    stats: window.__YT_STREAMER_BUFFER_STATS__ || null,
    badge: document.querySelector("#streamBadge")?.textContent || "",
    nowPlaying: document.querySelector("#nowPlaying")?.textContent || "",
    audioTime: Number(document.querySelector("#audio")?.currentTime || 0),
  }));
}

async function waitFor(predicateSource, timeoutMs = 120_000) {
  await page.waitForFunction(predicateSource, null, { timeout: timeoutMs, polling: 100 });
  return snapshot();
}

async function waitForFullQueue() {
  return waitFor(() => {
    const s = window.__YT_STREAMER_BUFFER_STATS__;
    return s?.state === "playing" && Number(s.queueSeconds || 0) >= 7.5;
  });
}

async function injectStall(index) {
  const before = await waitForFullQueue();
  const beforeCount = Number(before.stats?.rebufferCount || 0);
  const started = Date.now();
  await page.evaluate((ms) => { window.__YT_TEST_STALL_UNTIL = performance.now() + ms; }, STALL_MS);

  await page.waitForFunction((expected) => {
    const s = window.__YT_STREAMER_BUFFER_STATS__;
    return Number(s?.rebufferCount || 0) > expected && s?.state === "buffering";
  }, beforeCount, { timeout: STALL_MS + 15_000, polling: 100 });
  const buffering = await snapshot();
  const rebufferAtMs = Date.now() - started;

  await page.waitForFunction((expected) => {
    const s = window.__YT_STREAMER_BUFFER_STATS__;
    return Number(s?.rebufferCount || 0) > expected && s?.state === "playing";
  }, beforeCount, { timeout: 30_000, polling: 100 });
  const recovered = await snapshot();

  const result = {
    index,
    before: before.stats,
    rebufferAtMs,
    buffering: buffering.stats,
    recoveredAtMs: Date.now() - started,
    recovered: recovered.stats,
  };
  report.stalls.push(result);
  await writeFile(OUT, JSON.stringify(report, null, 2));
  return result;
}

try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#quickPlayBtn", { state: "attached" });
  await page.evaluate(() => {
    document.querySelector("#ctlHeight").value = "480";
    document.querySelector("#ctlFps").value = "12";
    document.querySelector("#ctlQuality").value = "7";
    window.__YT_TEST_STALL_UNTIL = 0;
    const proto = window.BufferedMjpeg?.BufferedMjpegPlayer?.prototype;
    if (!proto?.__adaptiveTestOriginalEnqueue) {
      proto.__adaptiveTestOriginalEnqueue = proto._enqueue;
      proto._enqueue = async function(bytes) {
        const wait = Number(window.__YT_TEST_STALL_UNTIL || 0) - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        return proto.__adaptiveTestOriginalEnqueue.call(this, bytes);
      };
    }
  });

  await page.evaluate((url) => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    document.querySelector("#quickUrl").value = url;
    document.querySelector("#quickPlayBtn").click();
  }, PRIMARY);
  report.startup = await waitForFullQueue();

  await injectStall(1);
  await injectStall(2);
  await injectStall(3);

  await page.evaluate(() => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    document.querySelector("#restreamBtn").click();
  });
  report.restart = await waitFor(() => {
    const s = window.__YT_STREAMER_BUFFER_STATS__;
    return s?.state === "playing" && s.renderedFrames >= 3;
  });

  await page.evaluate(() => document.querySelector("#stopBtn").click());
  await page.waitForFunction(() => !document.querySelector("#screen")?.classList.contains("playing"));
  report.stop = await snapshot();
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
