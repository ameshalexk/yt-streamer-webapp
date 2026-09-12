import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";

const SITE = process.env.SITE || "https://stream.ameshalex.com";
const PRIMARY = process.env.PRIMARY || "https://www.youtube.com/watch?v=e_04ZrNroTo";
const POLICY = process.env.POLICY || "unknown";
const OUT = process.env.OUT || (process.env.HOME + `/ytstreamer-buffer-${POLICY}.json`);
const STALL_MS = Number(process.env.STALL_MS || 5000);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { site: SITE, policy: POLICY, stallMs: STALL_MS, startedAt: new Date().toISOString(), runs: {}, browserErrors: [] };

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

await page.addInitScript(() => { window.__YT_TEST_STALL_UNTIL = 0; });

const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");

async function heap() {
  const h = await cdp.send("Runtime.getHeapUsage");
  return { used: h.usedSize, total: h.totalSize };
}

async function installFrameStallHook() {
  await page.evaluate(() => {
    const proto = window.BufferedMjpeg?.BufferedMjpegPlayer?.prototype;
    if (!proto || proto.__ytTestOriginalEnqueue) return;
    proto.__ytTestOriginalEnqueue = proto._enqueue;
    proto._enqueue = async function(bytes) {
      const wait = Number(window.__YT_TEST_STALL_UNTIL || 0) - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return proto.__ytTestOriginalEnqueue.call(this, bytes);
    };
  });
}

async function snapshot() {
  return page.evaluate(() => {
    const canvas = document.querySelector("#mjpegCanvas");
    const audio = document.querySelector("#audio");
    return {
      stats: window.__YT_STREAMER_BUFFER_STATS__ || null,
      audioTime: Number(audio?.currentTime || 0),
      audioPaused: Boolean(audio?.paused),
      badge: document.querySelector("#streamBadge")?.textContent || "",
      nowPlaying: document.querySelector("#nowPlaying")?.textContent || "",
      seekText: document.querySelector("#streamSeekTime")?.textContent || "",
      screenClass: document.querySelector("#screen")?.className || "",
      canvas: [Number(canvas?.width || 0), Number(canvas?.height || 0)],
      fetches: Number(window.__YT_TEST_BUFFER_FETCHES || 0),
    };
  });
}

async function setControls(fps) {
  await page.evaluate((fps) => {
    document.querySelector("#ctlHeight").value = "480";
    document.querySelector("#ctlFps").value = String(fps);
    document.querySelector("#ctlQuality").value = "7";
  }, fps);
}

async function playPrimary() {
  const started = Date.now();
  await page.evaluate((url) => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    document.querySelector("#quickUrl").value = url;
    document.querySelector("#quickPlayBtn").click();
  }, PRIMARY);
  await page.waitForFunction(() => {
    const s = window.__YT_STREAMER_BUFFER_STATS__;
    return s?.state === "playing" && s.renderedFrames >= 3;
  }, null, { timeout: 120_000 });
  const s = await snapshot();
  return { wallStartupMs: Date.now() - started, playerStartupMs: s.stats?.startupMs ?? null, initial: s };
}

async function sample(durationMs, intervalMs = 250) {
  const rows = [];
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    const s = await snapshot();
    rows.push({ t: Date.now() - start, ...s.stats, audioTime: s.audioTime, badge: s.badge });
    await sleep(intervalMs);
  }
  return rows;
}

function summarize(rows) {
  const finite = (v) => Number.isFinite(Number(v));
  const qSec = rows.map((r) => Number(r.queueSeconds)).filter(finite);
  const qBytes = rows.map((r) => Number(r.queueBytes)).filter(finite);
  const drift = rows.map((r) => Math.abs(Number(r.lastAvDriftMs))).filter(finite);
  const first = rows.find((r) => finite(r.renderedFrames));
  const last = [...rows].reverse().find((r) => finite(r.renderedFrames));
  const elapsedSec = first && last ? Math.max(0.001, (last.t - first.t) / 1000) : null;
  return {
    samples: rows.length,
    maxQueueSecondsObserved: qSec.length ? Math.max(...qSec) : null,
    minQueueSecondsObserved: qSec.length ? Math.min(...qSec) : null,
    maxQueueBytesObserved: qBytes.length ? Math.max(...qBytes) : null,
    maxAbsAvDriftMs: drift.length ? Math.max(...drift) : null,
    avgAbsAvDriftMs: drift.length ? drift.reduce((a, b) => a + b, 0) / drift.length : null,
    renderedFps: first && last ? (Number(last.renderedFrames) - Number(first.renderedFrames)) / elapsedSec : null,
    rebufferCountStart: first?.rebufferCount ?? null,
    rebufferCountEnd: last?.rebufferCount ?? null,
    states: [...new Set(rows.map((r) => r.state).filter(Boolean))],
  };
}

async function waitForQueue(seconds, timeoutMs = 30_000) {
  const start = Date.now();
  let best = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await snapshot();
    best = Math.max(best, Number(s.stats?.queueSeconds || 0));
    if (Number(s.stats?.queueSeconds || 0) >= seconds) return { reached: true, best };
    await sleep(250);
  }
  return { reached: false, best };
}

async function run12() {
  await setControls(12);
  const heapBefore = await heap();
  const startup = await playPrimary();
  const steady = await sample(8000);
  const heapSteady = await heap();

  const maxSeen = Number(startup.initial.stats?.maxQueueSeconds || 0);
  const queueTarget = Math.max(2.5, Math.min(7.5, maxSeen > 6 ? 7 : 4.5));
  const fill = await waitForQueue(queueTarget, 30_000);
  const beforeStall = await snapshot();
  const rebufferBefore = Number(beforeStall.stats?.rebufferCount || 0);

  await page.evaluate((stallMs) => {
    window.__YT_TEST_STALL_UNTIL = performance.now() + stallMs;
  }, STALL_MS);
  const stalled = await sample(STALL_MS + 3500);
  const afterStall = await snapshot();
  const heapAfterStall = await heap();

  await page.evaluate(() => document.querySelector("#pauseBtn").click());
  await page.waitForFunction(() => window.__YT_STREAMER_BUFFER_STATS__?.state === "paused");
  const pauseA = await snapshot();
  await sleep(1200);
  const pauseB = await snapshot();
  await page.evaluate(() => document.querySelector("#pauseBtn").click());
  await page.waitForFunction(() => window.__YT_STREAMER_BUFFER_STATS__?.state === "playing");
  await sleep(1200);
  const resume = await snapshot();

  const seekStarted = Date.now();
  await page.evaluate(() => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    document.querySelector("#streamForwardBtn").click();
  });
  await page.waitForFunction(() => window.__YT_STREAMER_BUFFER_STATS__?.state === "playing" && window.__YT_STREAMER_BUFFER_STATS__.renderedFrames >= 3, null, { timeout: 120_000 });
  const seek = { wallMs: Date.now() - seekStarted, snapshot: await snapshot() };

  return {
    startup,
    steady: summarize(steady),
    maxStatsAfterSteady: {
      maxQueueSeconds: steady.at(-1)?.maxQueueSeconds ?? null,
      maxQueueBytes: steady.at(-1)?.maxQueueBytes ?? null,
    },
    fill,
    stall: {
      before: beforeStall,
      summary: summarize(stalled),
      after: afterStall,
      rebufferDelta: Number(afterStall.stats?.rebufferCount || 0) - rebufferBefore,
    },
    pauseResume: {
      pausedAudioAdvance: pauseB.audioTime - pauseA.audioTime,
      pausedRenderedAdvance: Number(pauseB.stats?.renderedFrames || 0) - Number(pauseA.stats?.renderedFrames || 0),
      resume,
    },
    seek,
    heap: {
      before: heapBefore,
      steady: heapSteady,
      afterStall: heapAfterStall,
      steadyDeltaBytes: heapSteady.used - heapBefore.used,
      stallDeltaBytes: heapAfterStall.used - heapSteady.used,
    },
  };
}

async function run24() {
  await page.evaluate(() => document.querySelector("#stopBtn").click());
  await sleep(500);
  await setControls(24);
  const heapBefore = await heap();
  const startup = await playPrimary();
  const rows = await sample(7000);
  const heapAfter = await heap();
  return {
    startup,
    steady: summarize(rows),
    maxStats: {
      maxQueueSeconds: rows.at(-1)?.maxQueueSeconds ?? null,
      maxQueueBytes: rows.at(-1)?.maxQueueBytes ?? null,
    },
    heap: { before: heapBefore, after: heapAfter, deltaBytes: heapAfter.used - heapBefore.used },
  };
}

try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#quickPlayBtn", { state: "attached" });
  await installFrameStallHook();
  report.runs.fps12 = await run12();
  report.runs.fps24 = await run24();

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
