import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { config } from "../config.js";
import { FULLSCREEN_SHIM } from "./browser-renderer.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 360;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const DEFAULT_FPS = 60;
const MIN_FPS = 3;
const MAX_FPS = 60;
const SESSION_TTL_MS = 15 * 60 * 1000;
const IDLE_CLOSE_MS = 60 * 1000;
const BOUNDARY = "realchromeframe";
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const POPUP_ALLOWED_HOSTS = ["mediagraming.com"];
const POPUP_GUARD_INTERVAL_MS = 250;
const POPUP_PENDING_GRACE_MS = 2500;
const APNE_TRANSIT_TIMEOUT_MS = 5000;
const PLAY_NOW_REQUEST_TTL_MS = 15000;
const MEDIA_AUTOPLAY_TIMEOUT_MS = 10000;
const MEDIA_AUTOPLAY_INTERVAL_MS = 350;
const REMOTE_BROWSER_BLOCKED_URLS = [
  "*://cdn.jsdelivr.net/npm/disable-devtool*",
];
const APNE_FLASH_GUARD = `(() => {
  const hostname = location.hostname.toLowerCase().replace(/\\.$/, "");
  if (hostname !== "apnetv.xyz" && !hostname.endsWith(".apnetv.xyz")) return;
  if (window.__ytApneFlashGuardInstalled) return;
  window.__ytApneFlashGuardInstalled = true;
  let lastHandled = 0;
  const PLAY_NOW_CLASS = "yt-apne-play-now";
  const flashTarget = (event) => event.target instanceof Element ? event.target.closest(".flash_link") : null;
  const isPlayNowEvent = (event) => event.target instanceof Element && Boolean(event.target.closest("." + PLAY_NOW_CLASS));

  const installPlayNowButtons = () => {
    for (const target of document.querySelectorAll(".flash_link")) {
      if (target.querySelector(":scope > ." + PLAY_NOW_CLASS)) continue;
      if (getComputedStyle(target).position === "static") target.style.position = "relative";
      const button = document.createElement("button");
      button.type = "button";
      button.className = PLAY_NOW_CLASS;
      button.textContent = "Play Now";
      button.setAttribute("aria-label", "Play this episode now");
      Object.assign(button.style, {
        position: "absolute",
        right: "14px",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: "2147483000",
        padding: "10px 16px",
        border: "0",
        borderRadius: "999px",
        background: "#111",
        color: "#fff",
        font: "600 15px/1 system-ui, -apple-system, sans-serif",
        boxShadow: "0 2px 10px rgba(0,0,0,.28)",
        cursor: "pointer",
        touchAction: "manipulation",
      });
      target.appendChild(button);
    }
  };

  const submitFlash = (event) => {
    const target = flashTarget(event);
    if (!target) return;
    const playNow = isPlayNowEvent(event);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const now = Date.now();
    if (now - lastHandled < 900) return;
    lastHandled = now;
    if (playNow) window.__ytApnePlayNowRequestedAt = now;
    const action = target.dataset.href || "";
    const episodeId = target.dataset.id || "";
    if (!/^https:\\/\\/(?:www\\.)?newsportaling\\.com\\/finnance-/i.test(action) || !episodeId) return;
    const form = document.createElement("form");
    form.action = action;
    form.method = "POST";
    form.target = "_blank";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "id";
    input.value = episodeId;
    form.appendChild(input);
    form.style.display = "none";
    document.documentElement.appendChild(form);
    form.submit();
    form.remove();
  };
  const swallow = (event) => {
    if (!flashTarget(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  window.addEventListener("pointerdown", submitFlash, true);
  window.addEventListener("mousedown", submitFlash, true);
  window.addEventListener("touchstart", submitFlash, true);
  window.addEventListener("click", submitFlash, true);
  window.addEventListener("pointerup", swallow, true);
  window.addEventListener("mouseup", swallow, true);
  window.addEventListener("click", swallow, true);
  window.addEventListener("touchend", swallow, true);

  const install = () => {
    installPlayNowButtons();
    if (window.__ytApnePlayNowObserver || !document.documentElement) return;
    const observer = new MutationObserver(() => installPlayNowButtons());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__ytApnePlayNowObserver = observer;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
  setTimeout(install, 0);
})();`;
const CHROME_PATHS = [
  process.env.REAL_CHROME_PATH || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

const sessions = new Map();
let nextRpcId = 1;
let cleanupTimer = null;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function screenshotQuality(value, fallback = 72) {
  return clampInt(value, 20, 100, fallback);
}

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) throw httpError(400, "url required");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw httpError(400, "valid URL required");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw httpError(400, "only http/https URLs are supported");
  return url;
}

function chromeProfileDir() {
  return process.env.REAL_CHROME_PROFILE_DIR || path.join(config.dataDir, "real-chrome-profile");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function psOutput() {
  return new Promise((resolve, reject) => {
    const proc = spawn("ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code) reject(new Error(stderr.trim() || `ps exited ${code}`));
      else resolve(stdout);
    });
  });
}

const AUDIO_SERVICE_MARKER = "audio.mojom.AudioService";
const AUDIO_PRIME_EXPRESSION = `(() => {
  try {
    const key = "__ytStreamerAudioPrime";
    if (!window[key]) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return { ok: false, reason: "AudioContext unavailable" };
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      window[key] = { context, oscillator, gain };
    }
    const prime = window[key];
    if (prime.context.state === "suspended") prime.context.resume().catch(() => {});
    return { ok: true, state: prime.context.state };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
})()`;

async function profileAudioServicePids(profile) {
  const profileArg = `--user-data-dir=${profile}`;
  const lines = (await psOutput()).split("\n");
  const pids = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] || "";
    if (pid && command.includes(profileArg) && command.includes(AUDIO_SERVICE_MARKER)) pids.push(pid);
  }
  return [...new Set(pids)];
}

async function ensureAudioServiceForTap(session, timeoutMs = 2200) {
  let audioPids = await profileAudioServicePids(session.profile).catch(() => []);
  if (audioPids.length) return audioPids;

  const deadline = Date.now() + timeoutMs;
  while (!session.closed && Date.now() < deadline) {
    await session.cdp.call("Runtime.evaluate", {
      expression: AUDIO_PRIME_EXPRESSION,
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => {});
    await wait(120);
    audioPids = await profileAudioServicePids(session.profile).catch(() => []);
    if (audioPids.length) {
      console.log(`[real-chrome] primed audio service for Core Tap: ${audioPids.join(",")}`);
      return audioPids;
    }
  }
  console.warn("[real-chrome] Core Tap audio service did not appear before capture startup");
  return audioPids;
}

async function profileProcessPids(profile) {
  const profileArg = `--user-data-dir=${profile}`;
  const lines = (await psOutput()).split("\n");
  const pids = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] || "";
    if (pid && pid !== process.pid && command.includes(profileArg)) pids.push(pid);
  }
  return [...new Set(pids)];
}

async function cleanupProfileLocks(profile) {
  await Promise.all([
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
  ].map((name) => fs.rm(path.join(profile, name), { force: true }).catch(() => {})));
}

async function signalPids(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch {}
  }
}

export async function cleanupOrphans(reason = "manual") {
  if (sessions.size > 0) return 0;
  const profile = chromeProfileDir();
  const pids = await profileProcessPids(profile).catch(() => []);
  if (!pids.length) {
    await cleanupProfileLocks(profile);
    return 0;
  }
  await signalPids(pids, "SIGTERM");
  await wait(900);
  const remaining = await profileProcessPids(profile).catch(() => []);
  await signalPids(remaining, "SIGKILL");
  await cleanupProfileLocks(profile);
  console.log(`[real-chrome] cleaned ${pids.length} orphan process${pids.length === 1 ? "" : "es"} (${reason})`);
  return pids.length;
}

async function executablePath() {
  for (const candidate of CHROME_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw httpError(500, "Chrome/Chromium executable not found");
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 12);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 8000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw httpError(502, `Chrome DevTools did not become ready: ${lastError?.message || "timeout"}`);
}

function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let opened = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome DevTools WebSocket timed out")), 6000);
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Chrome DevTools WebSocket failed"));
    }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || "Chrome DevTools command failed"));
    else resolve(msg.result || {});
  });
  ws.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("Chrome DevTools WebSocket closed"));
    pending.clear();
  });
  return {
    ready,
    call(method, params = {}) {
      if (!opened || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome DevTools WebSocket is not open"));
      const id = nextRpcId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 8000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`Chrome target list returned HTTP ${res.status}`);
  return res.json();
}

async function targetForPort(port) {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw httpError(502, "Chrome did not expose a debuggable page.");
  return page;
}

async function targetById(port, targetId) {
  if (!targetId) return null;
  const targets = await listTargets(port);
  return targets.find((target) => target.id === targetId && target.type === "page" && target.webSocketDebuggerUrl) || null;
}

export function isAllowedPopupUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return POPUP_ALLOWED_HOSTS.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function isApneTvTransitUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const hostOk = hostname === "newsportaling.com" || hostname.endsWith(".newsportaling.com");
    return hostOk && url.pathname.startsWith("/finnance-");
  } catch {
    return false;
  }
}

function popupUrlDecision(raw) {
  const value = String(raw || "").trim();
  if (!value || value === "about:blank") return "pending";
  if (isAllowedPopupUrl(value)) return "allow";
  if (isApneTvTransitUrl(value)) return "transit";
  return "block";
}

function isApneTvUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "apnetv.xyz" || hostname.endsWith(".apnetv.xyz");
  } catch {
    return false;
  }
}

export function isApneTvDevtoolFallbackUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.hostname.toLowerCase() !== "theajack.github.io") return false;
    if (url.pathname !== "/disable-devtool/404.html") return false;
    return isApneTvUrl(`https://${url.searchParams.get("h") || ""}/`);
  } catch {
    return false;
  }
}

async function closeChromeTarget(port, targetId) {
  if (!targetId) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function installApneFlashGuard(cdp) {
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: APNE_FLASH_GUARD,
    runImmediately: true,
  }).catch(async () => {
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
      source: APNE_FLASH_GUARD,
    }).catch(() => {});
  });
  await cdp.call("Runtime.evaluate", {
    expression: APNE_FLASH_GUARD,
    awaitPromise: true,
  }).catch(() => {});
}

async function installFullscreenShim(session, cdp = session.cdp) {
  // Off-screen Real Chrome cannot reliably stay in native fullscreen. Reuse the
  // browser renderer's virtual fullscreen so site players fill the captured viewport.
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: FULLSCREEN_SHIM,
    runImmediately: true,
  }).catch(async () => {
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
      source: FULLSCREEN_SHIM,
    }).catch(() => {});
  });
  await cdp.call("Runtime.evaluate", {
    expression: FULLSCREEN_SHIM,
    awaitPromise: true,
  }).catch(() => {});
}

async function preparePage(session, cdp = session.cdp) {
  await cdp.ready;
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await installFullscreenShim(session, cdp);
  await installApneFlashGuard(cdp);
  await cdp.call("Network.enable").catch(() => {});
  await cdp.call("Network.setBlockedURLs", { urls: REMOTE_BROWSER_BLOCKED_URLS }).catch(() => {});
  await cdp.call("Network.setUserAgentOverride", { userAgent: DESKTOP_USER_AGENT, platform: "macOS" }).catch(() => {});
  await cdp.call("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
  await cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }).catch(() => {});
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: session.width,
    height: session.height,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch(() => {});
}

async function recoverMainFromApneTvDevtoolRedirect(session) {
  if (session.closed || !session.mainCdp) return false;
  const mainTarget = await targetById(session.port, session.mainTargetId).catch(() => null);
  if (!mainTarget || !isApneTvDevtoolFallbackUrl(mainTarget.url)) return false;
  if (session.mainRecoveryAt && Date.now() - session.mainRecoveryAt < 1500) return true;

  await session.mainCdp.call("Network.setBlockedURLs", { urls: REMOTE_BROWSER_BLOCKED_URLS }).catch(() => {});

  let recoveredUrl = "";
  const history = await session.mainCdp.call("Page.getNavigationHistory").catch(() => null);
  if (history?.entries?.length) {
    const priorEntries = history.entries.slice(0, Math.max(0, history.currentIndex));
    const previousApne = [...priorEntries].reverse().find((entry) => isApneTvUrl(entry.url));
    if (previousApne) {
      await session.mainCdp.call("Page.navigateToHistoryEntry", { entryId: previousApne.id });
      recoveredUrl = previousApne.url;
    }
  }

  if (!recoveredUrl && isApneTvUrl(session.mainSafeUrl)) {
    await session.mainCdp.call("Page.navigate", { url: session.mainSafeUrl });
    recoveredUrl = session.mainSafeUrl;
  }

  if (!recoveredUrl) return false;
  session.mainRecoveryAt = Date.now();
  session.mainSafeUrl = recoveredUrl;
  session.lastUsedAt = Date.now();
  if (!session.secondaryTargetId) {
    session.cdp = session.mainCdp;
    session.url = recoveredUrl;
    try {
      session.title = new URL(recoveredUrl).hostname || "Real Chrome";
    } catch {
      session.title = "Real Chrome";
    }
  }
  console.log(`[real-chrome] recovered APNE TV from disable-devtool redirect -> ${recoveredUrl}`);
  setTimeout(() => capture(session).catch(() => {}), 250).unref?.();
  return true;
}

async function restoreMainTab(session, { closeTargetId = null } = {}) {
  if (session.closed) return false;
  const secondaryCdp = session.secondaryCdp;
  session.secondaryTargetId = null;
  session.secondaryCdp = null;
  session.cdp = session.mainCdp;
  secondaryCdp?.close();
  if (closeTargetId) await closeChromeTarget(session.port, closeTargetId);
  let mainTarget = await targetById(session.port, session.mainTargetId).catch(() => null);
  if (!mainTarget || !session.mainCdp) return false;
  await preparePage(session, session.mainCdp).catch(() => {});
  if (isApneTvDevtoolFallbackUrl(mainTarget.url)) {
    await recoverMainFromApneTvDevtoolRedirect(session).catch(() => false);
    mainTarget = await targetById(session.port, session.mainTargetId).catch(() => mainTarget);
  }
  if (mainTarget?.url && !isApneTvDevtoolFallbackUrl(mainTarget.url)) {
    session.mainSafeUrl = mainTarget.url;
  }
  session.url = mainTarget?.url || session.mainSafeUrl || session.url;
  session.title = mainTarget?.title || session.title || "Real Chrome";
  session.lastUsedAt = Date.now();
  capture(session).catch(() => {});
  return true;
}

async function consumeApnePlayNowRequest(session) {
  if (!session.mainCdp) return false;
  const result = await session.mainCdp.call("Runtime.evaluate", {
    expression: `(() => {
      const value = Number(window.__ytApnePlayNowRequestedAt || 0);
      window.__ytApnePlayNowRequestedAt = 0;
      return value;
    })()`,
    returnByValue: true,
  }).catch(() => null);
  const requestedAt = Number(result?.result?.value || 0);
  return requestedAt > 0 && Date.now() - requestedAt <= PLAY_NOW_REQUEST_TTL_MS;
}

const MEDIAGRAMING_AUTOPLAY_EXPRESSION = `(async () => {
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden";
  };

  const docs = [document];
  for (const iframe of document.querySelectorAll("iframe")) {
    try {
      if (iframe.contentDocument) docs.push(iframe.contentDocument);
    } catch {}
  }

  const videos = docs.flatMap((doc) => [...doc.querySelectorAll("video")]);
  let clicked = false;
  let playAttempted = false;

  for (const video of videos) {
    try {
      video.muted = false;
      video.volume = 1;
      if (video.paused || video.readyState < 2) {
        playAttempted = true;
        await video.play().catch(() => {});
      }
    } catch {}
  }

  let playing = videos.some((video) => !video.paused && !video.ended);
  if (!playing) {
    const selectors = [
      ".jw-display-icon-container",
      ".jw-icon-playback",
      ".vjs-big-play-button",
      ".plyr__control--overlaid",
      "[data-plyr='play']",
      "button[aria-label*='play' i]",
      "[role='button'][aria-label*='play' i]",
      "button[title*='play' i]"
    ];
    for (const doc of docs) {
      let control = null;
      for (const selector of selectors) {
        control = [...doc.querySelectorAll(selector)].find(visible);
        if (control) break;
      }
      if (control) {
        try {
          control.click();
          clicked = true;
          break;
        } catch {}
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    playing = videos.some((video) => !video.paused && !video.ended);
  }

  const playerFrame = [...document.querySelectorAll("iframe")].find((iframe) => {
    const src = String(iframe.src || "");
    return /\/new\/video\.php/i.test(src) || /videoapne|master\.m3u8/i.test(src);
  }) || [...document.querySelectorAll("iframe")].filter(visible).sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  })[0] || null;

  let fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (!fullscreen && playerFrame) {
    try {
      await (playerFrame.requestFullscreen?.() || playerFrame.webkitRequestFullscreen?.());
    } catch {}
    fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement)
      || document.documentElement.classList.contains("ytstreamer-fs-active");
  }

  return {
    href: location.href,
    videos: videos.length,
    playing,
    clicked,
    playAttempted,
    playerFrame: Boolean(playerFrame),
    fullscreen,
  };
})()`;

async function autoPlayMediagraming(session, cdp) {
  const startedAt = Date.now();
  let last = null;
  while (!session.closed
    && session.secondaryCdp === cdp
    && Date.now() - startedAt < MEDIA_AUTOPLAY_TIMEOUT_MS) {
    const result = await cdp.call("Runtime.evaluate", {
      expression: MEDIAGRAMING_AUTOPLAY_EXPRESSION,
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => null);
    last = result?.result?.value || last;
    if (last?.playing && last?.fullscreen) {
      console.log("[real-chrome] Play Now started Mediagraming playback in fullscreen");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, MEDIA_AUTOPLAY_INTERVAL_MS));
  }
  console.log("[real-chrome] Play Now automation ended without full confirmation", last || {});
  return false;
}

async function activateAllowedSecondaryTab(session, target) {
  if (!target?.id || target.id === session.mainTargetId || !target.webSocketDebuggerUrl) return false;
  if (!isAllowedPopupUrl(target.url)) return false;

  const previousTargetId = session.secondaryTargetId;
  const previousCdp = session.secondaryCdp;
  const cdp = connectCdp(target.webSocketDebuggerUrl);
  await preparePage(session, cdp);

  session.secondaryTargetId = target.id;
  session.secondaryCdp = cdp;
  session.cdp = cdp;
  session.url = target.url || session.url;
  session.title = target.title || new URL(target.url).hostname || "Real Chrome";
  session.popupCandidates.delete(target.id);
  session.lastUsedAt = Date.now();
  previousCdp?.close();
  if (previousTargetId && previousTargetId !== target.id) {
    await closeChromeTarget(session.port, previousTargetId);
  }
  capture(session).catch(() => {});
  console.log(`[real-chrome] allowed popup ${target.url}`);

  const playNow = await consumeApnePlayNowRequest(session).catch(() => false);
  if (playNow) {
    autoPlayMediagraming(session, cdp).catch((err) => {
      console.warn("[real-chrome] Play Now automation failed", err?.message || err);
    });
  }
  return true;
}

async function enforcePopupPolicy(session) {
  if (session.closed || session.popupGuardBusy) return;
  session.popupGuardBusy = true;
  try {
    const pages = (await listTargets(session.port)).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
    const pageIds = new Set(pages.map((target) => target.id));
    const main = pages.find((target) => target.id === session.mainTargetId);

    if (main) {
      if (isApneTvDevtoolFallbackUrl(main.url)) {
        await recoverMainFromApneTvDevtoolRedirect(session).catch(() => false);
      } else if (main.url && main.url !== "about:blank") {
        session.mainSafeUrl = main.url;
      }
    }

    if (session.secondaryTargetId) {
      const activeSecondary = pages.find((target) => target.id === session.secondaryTargetId);
      if (!activeSecondary) {
        await restoreMainTab(session);
      } else if (popupUrlDecision(activeSecondary.url) === "block") {
        const blockedId = session.secondaryTargetId;
        console.log(`[real-chrome] closing allowed popup after redirect: ${activeSecondary.url}`);
        await restoreMainTab(session, { closeTargetId: blockedId });
      } else {
        session.url = activeSecondary.url || session.url;
        session.title = activeSecondary.title || session.title;
      }
    } else if (main) {
      session.url = main.url || session.url;
      session.title = main.title || session.title;
    }

    for (const target of pages) {
      if (target.id === session.mainTargetId || target.id === session.secondaryTargetId) continue;
      const decision = popupUrlDecision(target.url);
      if (decision === "allow") {
        await activateAllowedSecondaryTab(session, target);
        continue;
      }
      if (decision === "block") {
        session.popupCandidates.delete(target.id);
        await closeChromeTarget(session.port, target.id);
        console.log("[real-chrome] blocked popup " + target.url);
        continue;
      }

      const firstSeen = session.popupCandidates.get(target.id) || Date.now();
      session.popupCandidates.set(target.id, firstSeen);

      if (decision === "transit") {
        const apneMainActive = isApneTvUrl(main?.url) || isApneTvUrl(session.mainSafeUrl);
        if (!apneMainActive || Date.now() - firstSeen >= APNE_TRANSIT_TIMEOUT_MS) {
          session.popupCandidates.delete(target.id);
          await closeChromeTarget(session.port, target.id);
          console.log("[real-chrome] blocked expired APNE transit " + target.url);
        } else if (Date.now() - firstSeen < POPUP_GUARD_INTERVAL_MS * 2) {
          console.log("[real-chrome] allowing hidden APNE transit " + target.url);
        }
        continue;
      }

      if (Date.now() - firstSeen >= POPUP_PENDING_GRACE_MS) {
        session.popupCandidates.delete(target.id);
        await closeChromeTarget(session.port, target.id);
        console.log("[real-chrome] blocked unresolved popup target");
      }
    }

    for (const targetId of [...session.popupCandidates.keys()]) {
      if (!pageIds.has(targetId)) session.popupCandidates.delete(targetId);
    }
  } catch (err) {
    if (!session.closed) console.warn("[real-chrome] popup guard:", err.message);
  } finally {
    session.popupGuardBusy = false;
  }
}

function startPopupGuard(session) {
  if (session.tabGuardTimer) return;
  session.tabGuardTimer = setInterval(() => {
    enforcePopupPolicy(session).catch(() => {});
  }, POPUP_GUARD_INTERVAL_MS);
  session.tabGuardTimer.unref?.();
  enforcePopupPolicy(session).catch(() => {});
}

export function activeSessionCount() {
  return sessions.size;
}

export function listSessions() {
  return [...sessions.values()].filter((session) => !session.closed).map(sessionInfo);
}

function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        stop(session.id, "ttl").catch(() => {});
      } else if (session.clients.size === 0 && now - session.lastUsedAt > IDLE_CLOSE_MS) {
        stop(session.id, "idle").catch(() => {});
      }
    }
    if (sessions.size === 0) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 30_000);
  cleanupTimer.unref?.();
}

export async function start(payload = {}) {
  if (sessions.size >= 1) throw httpError(429, "Real Chrome is already running. Stop it first.");
  await cleanupOrphans("pre-start");
  const width = clampInt(payload.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH);
  const height = clampInt(payload.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT);
  const fps = clampInt(payload.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const quality = screenshotQuality(payload.quality);
  const port = await findFreePort();
  const profile = chromeProfileDir();
  await fs.mkdir(profile, { recursive: true });
  const chrome = await executablePath();
  const url = String(payload.url || "https://www.google.com/").trim() || "https://www.google.com/";
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${width},${height}`,
    "--new-window",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  const session = {
    id: cryptoRandomId(),
    width,
    height,
    fps,
    quality,
    port,
    profile,
    proc,
    cdp: null,
    mainCdp: null,
    secondaryCdp: null,
    mainTargetId: null,
    secondaryTargetId: null,
    popupCandidates: new Map(),
    popupGuardBusy: false,
    tabGuardTimer: null,
    clients: new Set(),
    timer: null,
    capturing: false,
    captureErrors: 0,
    closed: false,
    title: "Real Chrome",
    url,
    mainSafeUrl: isApneTvUrl(url) ? url : "",
    mainRecoveryAt: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  proc.on("exit", () => {
    session.closed = true;
    sessions.delete(session.id);
    session.secondaryCdp?.close();
    if (session.mainCdp && session.mainCdp !== session.secondaryCdp) session.mainCdp.close();
    else session.cdp?.close();
    if (session.timer) clearInterval(session.timer);
    if (session.tabGuardTimer) clearInterval(session.tabGuardTimer);
    for (const client of session.clients) {
      try { client.end(); } catch {}
    }
    session.clients.clear();
  });

  try {
    const target = await targetForPort(port);
    session.mainTargetId = target.id;
    session.cdp = connectCdp(target.webSocketDebuggerUrl);
    session.mainCdp = session.cdp;
    await preparePage(session);
    await session.mainCdp.call("Page.navigate", { url });
    session.url = url;
    try {
      session.title = new URL(url).hostname || "Real Chrome";
    } catch {
      session.title = "Real Chrome";
    }
    startPopupGuard(session);
  } catch (err) {
    try { proc.kill("SIGKILL"); } catch {}
    await cleanupOrphans("failed-start").catch(() => {});
    throw err;
  }

  sessions.set(session.id, session);
  startCleanupTimer();
  return sessionInfo(session);
}

function sessionInfo(session) {
  const now = Date.now();
  return {
    backend: "real-chrome",
    id: session.id,
    url: session.url,
    title: session.title,
    width: session.width,
    height: session.height,
    fps: session.fps,
    quality: session.quality,
    profile: session.profile,
    clients: session.clients.size,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    ageMs: now - session.createdAt,
    idleMs: now - session.lastUsedAt,
    secondaryTabOpen: Boolean(session.secondaryTargetId),
    popupAllowlist: [...POPUP_ALLOWED_HOSTS],
  };
}

function get(id) {
  const session = sessions.get(String(id || ""));
  if (!session || session.closed) return null;
  return session;
}

export async function audioCapturePids(id) {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  await ensureAudioServiceForTap(session);
  const profilePids = await profileProcessPids(session.profile).catch(() => []);
  return [...new Set([session.proc?.pid, ...profilePids].map(Number).filter((pid) => Number.isInteger(pid) && pid > 1))];
}

async function capture(session) {
  if (session.capturing || session.closed || !session.clients.size) return;
  session.capturing = true;
  try {
    const result = await session.cdp.call("Page.captureScreenshot", {
      format: "jpeg",
      quality: screenshotQuality(session.quality),
      fromSurface: true,
    });
    const frame = Buffer.from(result.data || "", "base64");
    if (!frame.length) return;
    const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    const tail = Buffer.from("\r\n");
    for (const res of [...session.clients]) {
      if (res.destroyed) {
        session.clients.delete(res);
        continue;
      }
      res.write(header);
      res.write(frame);
      res.write(tail);
    }
    session.captureErrors = 0;
  } catch (err) {
    session.captureErrors = (session.captureErrors || 0) + 1;
    console.error("[real-chrome] capture failed:", err.message);
    if (session.captureErrors >= 12) {
      stop(session.id, "capture-errors").catch(() => {});
    }
  } finally {
    session.capturing = false;
  }
}

function ensureCaptureLoop(session) {
  if (session.timer) return;
  session.timer = setInterval(() => capture(session), Math.max(16, Math.round(1000 / session.fps)));
  session.timer.unref?.();
  capture(session).catch(() => {});
}

function restartCaptureLoop(session) {
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
  if (session.clients.size > 0) ensureCaptureLoop(session);
}

export async function updateSettings(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  session.lastUsedAt = Date.now();
  const nextFps = payload.fps == null ? session.fps : clampInt(payload.fps, MIN_FPS, MAX_FPS, session.fps);
  const nextQuality = payload.quality == null ? session.quality : screenshotQuality(payload.quality, session.quality);
  const nextWidth = payload.width == null ? session.width : clampInt(payload.width, MIN_WIDTH, MAX_WIDTH, session.width);
  const nextHeight = payload.height == null ? session.height : clampInt(payload.height, MIN_HEIGHT, MAX_HEIGHT, session.height);
  const viewportChanged = nextWidth !== session.width || nextHeight !== session.height;
  const fpsChanged = nextFps !== session.fps;
  const qualityChanged = nextQuality !== session.quality;
  if (viewportChanged) {
    session.width = nextWidth;
    session.height = nextHeight;
    await preparePage(session);
  }
  if (fpsChanged) {
    session.fps = nextFps;
    restartCaptureLoop(session);
  }
  if (qualityChanged) {
    session.quality = nextQuality;
  }
  if (!fpsChanged && (viewportChanged || qualityChanged)) {
    capture(session).catch(() => {});
  }
  return sessionInfo(session);
}

export function stream(req, res, id) {
  const session = get(id);
  if (!session) {
    res.status(404).type("text/plain").end("Real Chrome session not found.");
    return;
  }
  session.lastUsedAt = Date.now();
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "close",
    "X-Accel-Buffering": "no",
  });
  session.clients.add(res);
  ensureCaptureLoop(session);
  const cleanup = () => {
    session.clients.delete(res);
    session.lastUsedAt = Date.now();
    if (session.clients.size === 0 && session.timer) {
      clearInterval(session.timer);
      session.timer = null;
    }
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

function point(payload, session) {
  const x = Math.max(0, Math.min(1, Number(payload.x)));
  const y = Math.max(0, Math.min(1, Number(payload.y)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw httpError(400, "x and y must be numbers");
  return {
    x: Math.round(x * Math.max(1, session.width - 1)),
    y: Math.round(y * Math.max(1, session.height - 1)),
  };
}

async function focusedEditableInfo(session) {
  const result = await session.cdp.call("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { editable: false };
      const tag = el.tagName?.toLowerCase() || "";
      const isTextInput = tag === "input" && !["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].includes(String(el.type || "").toLowerCase());
      const editable = isTextInput || tag === "textarea" || el.isContentEditable;
      if (!editable || el.disabled || el.readOnly) return { editable: false };
      return {
        editable: true,
        tag,
        type: String(el.type || "").toLowerCase(),
        value: isTextInput || tag === "textarea" ? el.value || "" : el.textContent || "",
        placeholder: el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("name") || "",
        maxLength: typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : null,
      };
    })()`,
  });
  return result.result?.value || { editable: false };
}

async function replaceFocusedEditableText(session, text) {
  const expression = `((nextValue) => {
    const el = document.activeElement;
    if (!el) return { ok: false, editable: false };
    const tag = el.tagName?.toLowerCase() || "";
    const inputLike = tag === "input" || tag === "textarea";
    if (inputLike) {
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, nextValue);
      else el.value = nextValue;
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    } else if (el.isContentEditable) {
      el.textContent = nextValue;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      return { ok: false, editable: false };
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, editable: true };
  })(${JSON.stringify(String(text ?? ""))})`;
  const result = await session.cdp.call("Runtime.evaluate", { returnByValue: true, expression });
  return result.result?.value || { ok: false, editable: false };
}

async function pressKey(session, key) {
  const keyCodes = { Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 };
  const code = keyCodes[key];
  if (!code) throw httpError(400, "Unsupported Real Chrome key.");
  await session.cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await session.cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

async function googleLoginClickFallback(session, p) {
  const result = await session.cdp.call("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      if (!/\\.google\\.com$/i.test(location.hostname)) return { ok: false, skipped: true };
      const tapX = ${Math.round(p.x)};
      const tapY = ${Math.round(p.y)};
      const selectors = "button, a, [role='button'], input[type='button'], input[type='submit']";
      const label = [
        el => el.innerText,
        el => el.textContent,
        el => el.value,
        el => el.getAttribute("aria-label"),
        el => el.getAttribute("title")
      ];
      function textFor(el) {
        return label.map(fn => {
          try { return fn(el); } catch { return ""; }
        }).filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      }
      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }
      function clickTarget(target, reason) {
        const text = textFor(target);
        target.scrollIntoView({ block: "center", inline: "center" });
        target.focus?.();
        target.click();
        return { ok: true, clicked: true, reason, label: text };
      }
      const direct = document.elementFromPoint(tapX, tapY)?.closest?.(selectors);
      if (direct && visible(direct)) return clickTarget(direct, "direct");
      const candidates = [...document.querySelectorAll(selectors)]
        .filter(visible)
        .map(el => ({ el, rect: el.getBoundingClientRect(), text: textFor(el) }));
      const tryAnother = candidates.find(item => /try\\s+another\\s+way/i.test(item.text));
      if (tryAnother) {
        const r = tryAnother.rect;
        const pad = 56;
        const near = tapX >= r.left - pad && tapX <= r.right + pad && tapY >= r.top - pad && tapY <= r.bottom + pad;
        if (near) return clickTarget(tryAnother.el, "near-try-another-way");
      }
      const nearest = candidates
        .map(item => {
          const cx = item.rect.left + item.rect.width / 2;
          const cy = item.rect.top + item.rect.height / 2;
          return { ...item, distance: Math.hypot(tapX - cx, tapY - cy) };
        })
        .sort((a, b) => a.distance - b.distance)[0];
      if (nearest && nearest.distance < 72) return clickTarget(nearest.el, "nearest");
      return {
        ok: false,
        clicked: false,
        candidates: candidates.slice(0, 8).map(item => ({
          text: item.text,
          rect: { left: Math.round(item.rect.left), top: Math.round(item.rect.top), width: Math.round(item.rect.width), height: Math.round(item.rect.height) }
        }))
      };
    })()`,
  });
  return result.result?.value || { ok: false, clicked: false };
}

export async function input(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  session.lastUsedAt = Date.now();
  if (payload.type === "focus-info") return focusedEditableInfo(session);
  if (payload.type === "replace-text") return replaceFocusedEditableText(session, payload.text);
  if (payload.type === "text") {
    await session.cdp.call("Input.insertText", { text: String(payload.text ?? "").slice(0, 4096) });
    return { ok: true };
  }
  if (payload.type === "key") {
    await pressKey(session, String(payload.key || ""));
    return { ok: true };
  }
  const p = point(payload, session);
  const button = payload.button === 2 ? "right" : "left";
  if (payload.type === "tap") {
    if (payload.pointerType === "touch") {
      // Touch emulation already emits the compatibility click. Do not send a second
      // explicit mouse click or toggle controls (such as fullscreen) can fire twice.
      await session.cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }] });
      await session.cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const fallback = await googleLoginClickFallback(session, p).catch(() => null);
      if (fallback?.clicked) return { ok: true, fallback };
      return { ok: true };
    }
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, buttons: 1, clickCount: 1 });
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, buttons: 0, clickCount: 1 });
    return { ok: true };
  }
  if (payload.type === "move" || payload.type === "drag") {
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" });
    return { ok: true };
  }
  if (payload.type === "down") {
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, buttons: 1, clickCount: 1 });
    return { ok: true };
  }
  if (payload.type === "up") {
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, buttons: 0, clickCount: 1 });
    return { ok: true };
  }
  if (payload.type === "scroll") {
    await session.cdp.call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: p.x,
      y: p.y,
      deltaX: Math.max(-2000, Math.min(2000, Number(payload.dx) || 0)),
      deltaY: Math.max(-2000, Math.min(2000, Number(payload.dy) || 0)),
    });
    return { ok: true };
  }
  throw httpError(400, "Unsupported Real Chrome input type.");
}

export async function mediaPlayback(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  const action = String(payload.action || "").toLowerCase();
  if (!new Set(["pause", "play"]).has(action)) throw httpError(400, "Media action must be pause or play.");
  session.lastUsedAt = Date.now();
  await session.cdp.ready;
  const expression = `(() => {
    const action = ${JSON.stringify(action)};
    const docs = [document];
    for (const iframe of document.querySelectorAll("iframe")) {
      try { if (iframe.contentDocument) docs.push(iframe.contentDocument); } catch {}
    }
    const media = docs.flatMap((doc) => [...doc.querySelectorAll("video,audio")]);
    let changed = 0;
    for (const item of media) {
      try {
        if (action === "pause") {
          if (!item.paused && !item.ended) { item.pause(); changed += 1; }
        } else if (!item.ended && item.paused) {
          item.play().catch(() => {});
          changed += 1;
        }
      } catch {}
    }
    return {
      ok: true,
      action,
      mediaCount: media.length,
      changed,
      states: media.slice(0, 12).map((item) => ({
        tag: item.tagName,
        paused: item.paused,
        ended: item.ended,
        currentTime: Number(item.currentTime || 0),
        muted: Boolean(item.muted),
        volume: Number(item.volume ?? 1),
      })),
    };
  })()`;
  const result = await session.cdp.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.value || { ok: true, action, mediaCount: 0, changed: 0, states: [] };
}

export async function navigate(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  const url = normalizeUrl(payload.url);
  session.lastUsedAt = Date.now();
  if (session.secondaryTargetId) {
    await closeSecondaryTab(id, "navigate");
  }
  await session.mainCdp.ready;
  await session.mainCdp.call("Network.setBlockedURLs", { urls: REMOTE_BROWSER_BLOCKED_URLS }).catch(() => {});
  await session.mainCdp.call("Page.navigate", { url: url.toString() });
  session.cdp = session.mainCdp;
  session.url = url.toString();
  session.mainSafeUrl = isApneTvUrl(url.toString()) ? url.toString() : "";
  session.title = url.hostname || "Real Chrome";
  setTimeout(async () => {
    if (session.closed) return;
    try {
      const target = await targetById(session.port, session.mainTargetId);
      if (!target) return;
      session.url = target.url || session.url;
      session.title = target.title || session.title;
    } catch {}
  }, 800).unref?.();
  return sessionInfo(session);
}

export async function closeSecondaryTab(id, reason = "manual") {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  if (!session.secondaryTargetId) {
    const recovered = await recoverMainFromApneTvDevtoolRedirect(session).catch(() => false);
    return { ok: true, closed: false, recovered, session: sessionInfo(session) };
  }
  if (session.popupGuardBusy) await wait(300);
  const targetId = session.secondaryTargetId;
  session.popupGuardBusy = true;
  try {
    const restored = await restoreMainTab(session, { closeTargetId: targetId });
    console.log(`[real-chrome] closed secondary tab (${reason})`);
    return { ok: true, closed: true, restored, session: sessionInfo(session) };
  } finally {
    session.popupGuardBusy = false;
  }
}

export async function stop(id, reason = "manual") {
  const session = get(id);
  if (!session) return false;
  sessions.delete(session.id);
  session.closed = true;
  if (session.timer) clearInterval(session.timer);
  if (session.tabGuardTimer) clearInterval(session.tabGuardTimer);
  session.secondaryCdp?.close();
  if (session.mainCdp && session.mainCdp !== session.secondaryCdp) session.mainCdp.close();
  else session.cdp?.close();
  try { session.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    if (!session.proc.killed) {
      try { session.proc.kill("SIGKILL"); } catch {}
    }
  }, 1200).unref?.();
  for (const client of session.clients) {
    try { client.end(); } catch {}
  }
  session.clients.clear();
  console.log(`[real-chrome] closed ${session.id} (${reason}) ${session.url}`);
  return true;
}

export async function stopAll(reason = "manual") {
  const ids = [...sessions.keys()];
  const results = await Promise.all(ids.map((id) => stop(id, reason).catch(() => false)));
  return results.filter(Boolean).length;
}
