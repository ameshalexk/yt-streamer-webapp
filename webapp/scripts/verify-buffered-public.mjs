import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";

const SITE = "https://stream.ameshalex.com";
const PRIMARY = "https://www.youtube.com/watch?v=e_04ZrNroTo";
const SECONDARY = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const OUT = process.env.HOME + "/ytstreamer-public-verify.json";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const report = { site: SITE, startedAt: new Date().toISOString(), checks: {}, browserErrors: [] };
const save = async () => writeFile(OUT, JSON.stringify(report, null, 2));

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
page.setDefaultTimeout(90_000);
page.on("pageerror", (error) => report.browserErrors.push("pageerror: " + error.message));
page.on("console", (message) => {
  if (message.type() === "error") report.browserErrors.push("console: " + message.text());
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot() {
  return page.evaluate(() => {
    const canvas = document.querySelector("#mjpegCanvas");
    let canvasHash = 0;
    if (canvas?.width && canvas?.height) {
      try {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const stride = Math.max(4, Math.floor(data.length / 2048 / 4) * 4);
        for (let i = 0; i < data.length; i += stride) {
          canvasHash = ((canvasHash * 33) ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16)) >>> 0;
        }
      } catch {}
    }
    const audio = document.querySelector("#audio");
    return {
      nowPlaying: document.querySelector("#nowPlaying")?.textContent || "",
      badge: document.querySelector("#streamBadge")?.textContent || "",
      screenClass: document.querySelector("#screen")?.className || "",
      stats: window.__YT_STREAMER_BUFFER_STATS__ || null,
      audioTime: Number(audio?.currentTime || 0),
      audioPaused: Boolean(audio?.paused),
      audioReadyState: Number(audio?.readyState || 0),
      canvas: [Number(canvas?.width || 0), Number(canvas?.height || 0)],
      canvasHash,
      seekText: document.querySelector("#streamSeekTime")?.textContent || "",
      fps: document.querySelector("#ctlFps")?.value || "",
      quality: document.querySelector("#ctlQuality")?.value || "",
      height: document.querySelector("#ctlHeight")?.value || "",
      notice: document.querySelector("#streamNotice")?.hidden
        ? ""
        : (document.querySelector("#streamNoticeTitle")?.textContent || "") + ": " + (document.querySelector("#streamNoticeDetail")?.textContent || ""),
    };
  });
}

async function observeUntilPlaying({ expectedTitle = null, timeoutMs = 90_000 } = {}) {
  const observations = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const s = await snapshot();
    observations.push({
      elapsedMs: Date.now() - startedAt,
      badge: s.badge,
      state: s.stats?.state || null,
      queueSeconds: s.stats?.queueSeconds ?? null,
      renderedFrames: s.stats?.renderedFrames ?? null,
      nowPlaying: s.nowPlaying,
    });
    const titleOk = !expectedTitle || s.nowPlaying.includes(expectedTitle);
    if (titleOk && s.stats?.state === "playing" && s.stats.renderedFrames >= 3) {
      return { elapsedMs: Date.now() - startedAt, observations, snapshot: s };
    }
    if (s.notice && /failed|error/i.test(s.notice)) throw new Error(s.notice);
    await sleep(500);
  }
  throw new Error("Timed out waiting for buffered playback");
}

async function setControls(values, trigger = false) {
  await page.evaluate(({ values, trigger }) => {
    let triggerElement = null;
    for (const [id, value] of Object.entries(values)) {
      const el = document.querySelector(id);
      el.value = String(value);
      triggerElement ||= el;
    }
    if (trigger && triggerElement) {
      window.__YT_STREAMER_BUFFER_STATS__ = null;
      triggerElement.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { values, trigger });
}

async function playUrl(url, expectedTitle) {
  await page.evaluate(({ url }) => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    document.querySelector("#quickUrl").value = url;
    document.querySelector("#quickPlayBtn").click();
  }, { url });
  return observeUntilPlaying({ expectedTitle, timeoutMs: 120_000 });
}

async function restartAction(fn) {
  await page.evaluate((source) => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    Function(source)();
  }, `return (${fn.toString()})();`);
  return observeUntilPlaying({ timeoutMs: 120_000 });
}

try {
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#quickPlayBtn", { state: "attached" });
  await setControls({ "#ctlHeight": 480, "#ctlFps": 12, "#ctlQuality": 7 });

  report.checks.startup12 = await playUrl(PRIMARY, "Wheels on the Bus");
  await save();

  const c12a = await snapshot();
  await sleep(4000);
  const c12b = await snapshot();
  report.checks.cadence12 = {
    renderedFps: (c12b.stats.renderedFrames - c12a.stats.renderedFrames) / 4,
    renderedFrames: c12b.stats.renderedFrames - c12a.stats.renderedFrames,
    audioAdvance: c12b.audioTime - c12a.audioTime,
    canvasAdvanced: c12b.canvasHash !== c12a.canvasHash,
    start: c12a,
    end: c12b,
  };
  await save();

  await page.evaluate(() => document.querySelector("#pauseBtn").click());
  await page.waitForFunction(() => window.__YT_STREAMER_BUFFER_STATS__?.state === "paused");
  const pa = await snapshot();
  await sleep(1200);
  const pb = await snapshot();
  report.checks.pause = {
    audioAdvance: pb.audioTime - pa.audioTime,
    renderedAdvance: pb.stats.renderedFrames - pa.stats.renderedFrames,
    start: pa,
    end: pb,
  };
  await page.evaluate(() => document.querySelector("#pauseBtn").click());
  await page.waitForFunction(() => window.__YT_STREAMER_BUFFER_STATS__?.state === "playing");
  await sleep(1200);
  report.checks.resume = await snapshot();
  await save();

  report.checks.seek = await restartAction(() => document.querySelector("#streamForwardBtn").click());
  await save();

  report.checks.restream = await restartAction(() => document.querySelector("#restreamBtn").click());
  await save();

  await page.evaluate(() => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    const el = document.querySelector("#ctlQuality");
    el.value = "12";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  report.checks.qualityChange = await observeUntilPlaying({ timeoutMs: 120_000 });
  await save();

  await page.evaluate(() => {
    window.__YT_STREAMER_BUFFER_STATS__ = null;
    document.querySelector("#ctlHeight").value = "480";
    document.querySelector("#ctlQuality").value = "7";
    const el = document.querySelector("#ctlFps");
    el.value = "24";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const startup24 = await observeUntilPlaying({ timeoutMs: 120_000 });
  const c24a = await snapshot();
  await sleep(4000);
  const c24b = await snapshot();
  report.checks.candidate24 = {
    startup: startup24,
    renderedFps: (c24b.stats.renderedFrames - c24a.stats.renderedFrames) / 4,
    renderedFrames: c24b.stats.renderedFrames - c24a.stats.renderedFrames,
    audioAdvance: c24b.audioTime - c24a.audioTime,
    canvasAdvanced: c24b.canvasHash !== c24a.canvasHash,
    start: c24a,
    end: c24b,
  };
  await save();

  await setControls({ "#ctlHeight": 480, "#ctlFps": 12, "#ctlQuality": 7 });
  const secondary = await playUrl(SECONDARY, "Me at the zoo");
  const primaryAgain = await playUrl(PRIMARY, "Wheels on the Bus");
  report.checks.switching = { secondary, primaryAgain };
  await save();

  await page.evaluate(() => document.querySelector("#stopBtn").click());
  await page.waitForFunction(() => !document.querySelector("#screen")?.classList.contains("playing"));
  report.checks.stop = await snapshot();
  report.completedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await save();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
