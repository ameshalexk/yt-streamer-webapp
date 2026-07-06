import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { streamBrowserFrameTS } from "./stream.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const SESSION_TTL_MS = 15 * 60 * 1000;
const IDLE_CLOSE_MS = 60 * 1000;
const BOUNDARY = "browserframe";
const FULLSCREEN_SHIM = `(() => {
  if (window.__ytStreamerFullscreenShim) return;
  window.__ytStreamerFullscreenShim = true;
  let activeElement = null;
  let activeRestore = null;

  function dispatchChange() {
    try { document.dispatchEvent(new Event("fullscreenchange")); } catch {}
    try { document.dispatchEvent(new Event("webkitfullscreenchange")); } catch {}
  }

  function restore() {
    if (activeRestore) {
      try { activeRestore(); } catch {}
    }
    activeRestore = null;
    activeElement = null;
    document.documentElement.classList.remove("ytstreamer-fs-active");
    document.body?.classList.remove("ytstreamer-fs-active");
    dispatchChange();
  }

  function styleValue(el, name, value) {
    try {
      el.style.setProperty(name, value, "important");
    } catch {
      el.style[name] = value;
    }
  }

  function forceViewportOrigin(el) {
    try {
      const rect = el.getBoundingClientRect();
      const dx = Math.round(-rect.left);
      const dy = Math.round(-rect.top);
      if (dx || dy) styleValue(el, "transform", "translate(" + dx + "px, " + dy + "px)");
    } catch {}
  }

  function relaxAncestors(el) {
    const restore = [];
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      restore.push({
        node,
        position: node.style.position,
        overflow: node.style.overflow,
        overflowX: node.style.overflowX,
        overflowY: node.style.overflowY,
        transform: node.style.transform,
        filter: node.style.filter,
        perspective: node.style.perspective,
        contain: node.style.contain,
        clipPath: node.style.clipPath,
        zIndex: node.style.zIndex,
        isolation: node.style.isolation,
        borderRadius: node.style.borderRadius,
      });
      const computed = getComputedStyle(node);
      if (computed.position === "static") styleValue(node, "position", "relative");
      styleValue(node, "overflow", "visible");
      styleValue(node, "overflow-x", "visible");
      styleValue(node, "overflow-y", "visible");
      styleValue(node, "transform", "none");
      styleValue(node, "filter", "none");
      styleValue(node, "perspective", "none");
      styleValue(node, "contain", "none");
      styleValue(node, "clip-path", "none");
      styleValue(node, "z-index", "2147483646");
      styleValue(node, "isolation", "auto");
      styleValue(node, "border-radius", "0");
      node = node.parentElement;
    }
    return () => {
      for (const item of restore.reverse()) {
        Object.assign(item.node.style, {
          position: item.position,
          overflow: item.overflow,
          overflowX: item.overflowX,
          overflowY: item.overflowY,
          transform: item.transform,
          filter: item.filter,
          perspective: item.perspective,
          contain: item.contain,
          clipPath: item.clipPath,
          zIndex: item.zIndex,
          isolation: item.isolation,
          borderRadius: item.borderRadius,
        });
      }
    };
  }

  function styleFullscreen(el) {
    if (!el || activeElement === el) return;
    restore();
    const restoreAncestors = relaxAncestors(el);
    const previous = {
      position: el.style.position,
      inset: el.style.inset,
      top: el.style.top,
      right: el.style.right,
      bottom: el.style.bottom,
      left: el.style.left,
      width: el.style.width,
      height: el.style.height,
      zIndex: el.style.zIndex,
      background: el.style.background,
      transform: el.style.transform,
      border: el.style.border,
      margin: el.style.margin,
      maxWidth: el.style.maxWidth,
      maxHeight: el.style.maxHeight,
      overflow: el.style.overflow,
      bodyOverflow: document.body?.style.overflow || "",
      htmlOverflow: document.documentElement.style.overflow || "",
    };
    activeElement = el;
    activeRestore = () => {
      Object.assign(el.style, {
        position: previous.position,
        inset: previous.inset,
        top: previous.top,
        right: previous.right,
        bottom: previous.bottom,
        left: previous.left,
        width: previous.width,
        height: previous.height,
        zIndex: previous.zIndex,
        background: previous.background,
        transform: previous.transform,
        border: previous.border,
        margin: previous.margin,
        maxWidth: previous.maxWidth,
        maxHeight: previous.maxHeight,
        overflow: previous.overflow,
      });
      try { restoreAncestors(); } catch {}
      if (document.body) document.body.style.overflow = previous.bodyOverflow;
      document.documentElement.style.overflow = previous.htmlOverflow;
    };
    styleValue(el, "position", "fixed");
    styleValue(el, "inset", "0");
    styleValue(el, "top", "0");
    styleValue(el, "right", "0");
    styleValue(el, "bottom", "0");
    styleValue(el, "left", "0");
    styleValue(el, "width", "100vw");
    styleValue(el, "height", "100vh");
    styleValue(el, "max-width", "100vw");
    styleValue(el, "max-height", "100vh");
    styleValue(el, "z-index", "2147483647");
    styleValue(el, "background", "#000");
    styleValue(el, "transform", "none");
    styleValue(el, "border", "0");
    styleValue(el, "margin", "0");
    styleValue(el, "overflow", "hidden");
    forceViewportOrigin(el);
    if (document.body) styleValue(document.body, "overflow", "hidden");
    styleValue(document.documentElement, "overflow", "hidden");
    document.documentElement.classList.add("ytstreamer-fs-active");
    document.body?.classList.add("ytstreamer-fs-active");
    dispatchChange();
  }

  function findIframe(source) {
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        if (iframe.contentWindow === source) return iframe;
      } catch {}
    }
    return null;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (!msg || msg.__ytStreamerFullscreen !== true) return;
    if (msg.action === "enter") {
      const iframe = findIframe(event.source);
      if (iframe) styleFullscreen(iframe);
    } else if (msg.action === "exit") {
      restore();
    }
  });

  function requestFullscreenShim(el) {
    if (window.top !== window) {
      try { window.top.postMessage({ __ytStreamerFullscreen: true, action: "enter" }, "*"); } catch {}
    }
    styleFullscreen(el);
    return Promise.resolve();
  }

  function fullscreenClassTarget() {
    return document.querySelector(
      ".jwplayer.jw-flag-fullscreen, .jwplayer.jw-state-fullscreen, .vjs-fullscreen, .plyr--fullscreen-active"
    );
  }

  function syncPlayerFullscreenClasses() {
    const target = fullscreenClassTarget();
    if (target && activeElement !== target) {
      requestFullscreenShim(target).catch(() => {});
    } else if (!target && activeElement?.matches?.(".jwplayer, .video-js, .plyr")) {
      document.exitFullscreen().catch(() => {});
    }
  }

  try {
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => activeElement });
    Object.defineProperty(document, "webkitFullscreenElement", { configurable: true, get: () => activeElement });
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => true });
    Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, get: () => true });
  } catch {}

  Element.prototype.requestFullscreen = function() { return requestFullscreenShim(this); };
  Element.prototype.webkitRequestFullscreen = function() { return requestFullscreenShim(this); };
  Document.prototype.exitFullscreen = function() {
    if (window.top !== window) {
      try { window.top.postMessage({ __ytStreamerFullscreen: true, action: "exit" }, "*"); } catch {}
    }
    restore();
    return Promise.resolve();
  };
  Document.prototype.webkitExitFullscreen = Document.prototype.exitFullscreen;
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeElement) document.exitFullscreen();
  }, true);
  function installPlayerFullscreenObserver() {
    if (window.__ytStreamerFullscreenObserver || !document.documentElement) return;
    try {
      const observer = new MutationObserver(syncPlayerFullscreenClasses);
      observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });
      window.__ytStreamerFullscreenObserver = observer;
      syncPlayerFullscreenClasses();
    } catch {}
  }
  installPlayerFullscreenObserver();
  document.addEventListener("DOMContentLoaded", installPlayerFullscreenObserver, { once: true });
  setTimeout(installPlayerFullscreenObserver, 0);
})();`;
const CHROME_PATHS = [
  process.env.BROWSER_CHROME_PATH || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

const sessions = new Map();
const hostSafetyCache = new Map();
let playwrightPromise = null;
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

function screenshotQuality(value, fallback = 70) {
  return clampInt(value, 20, 90, fallback);
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
  url.hash = "";
  return url;
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (!version) return false;
  if (version === 4) {
    const parts = address.split(".").map((p) => parseInt(p, 10));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 0
    );
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

async function assertPublicUrl(url) {
  if (process.env.BROWSER_STREAM_ALLOW_PRIVATE === "1") return;
  if (isPrivateAddress(url.hostname)) throw httpError(400, "private/internal URLs are blocked");
  const cacheKey = `${url.protocol}//${url.hostname}`;
  if (hostSafetyCache.get(cacheKey) === true) return;
  if (hostSafetyCache.get(cacheKey) === false) throw httpError(400, "private/internal URLs are blocked");
  let records;
  try {
    records = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw httpError(400, "URL host could not be resolved");
  }
  if (!records.length || records.some((entry) => isPrivateAddress(entry.address))) {
    hostSafetyCache.set(cacheKey, false);
    throw httpError(400, "private/internal URLs are blocked");
  }
  hostSafetyCache.set(cacheKey, true);
}

async function requestAllowed(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
  if (!["http:", "https:"].includes(url.protocol)) return false;
  try {
    await assertPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}

async function loadPlaywright() {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright-core").catch((err) => {
      playwrightPromise = null;
      throw httpError(500, `playwright-core is not installed: ${err.message}`);
    });
  }
  return playwrightPromise;
}

async function executablePath() {
  const fs = await import("node:fs/promises");
  for (const candidate of CHROME_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw httpError(500, "Chrome/Chromium executable not found");
}

function sessionInfo(session) {
  const now = Date.now();
  return {
    backend: "browser",
    id: session.id,
    url: session.page?.url() || session.url,
    title: session.title || "",
    width: session.width,
    height: session.height,
    fps: session.fps,
    quality: session.quality,
    clients: sessionClientCount(session),
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    ageMs: now - session.createdAt,
    idleMs: now - session.lastUsedAt,
  };
}

function sessionClientCount(session) {
  return (session.clients?.size || 0) + (session.transports?.size || 0);
}

async function wakeMedia(session) {
  if (!session || session.closed || !session.page) return;
  const frames = session.page.frames();
  await Promise.allSettled(frames.map((frame) => frame.evaluate(() => {
    const media = [...document.querySelectorAll("video,audio")];
    for (const el of media) {
      try {
        el.muted = false;
        el.volume = 1;
        el.autoplay = true;
        const play = el.play?.();
        if (play?.catch) play.catch(() => {});
      } catch {}
    }
    return media.length;
  })));
}

function scheduleMediaWake(session) {
  for (const delay of [300, 1500, 4000]) {
    const timer = setTimeout(() => {
      wakeMedia(session).catch(() => {});
    }, delay);
    timer.unref?.();
  }
}

function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        stop(session.id, "ttl").catch(() => {});
      } else if (sessionClientCount(session) === 0 && now - session.lastUsedAt > IDLE_CLOSE_MS) {
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

export function activeSessionCount() {
  return sessions.size;
}

export function listSessions() {
  return [...sessions.values()].map(sessionInfo);
}

export function get(id) {
  return sessions.get(String(id || ""));
}

export async function start(payload = {}) {
  if (sessions.size >= config.maxConcurrentStreams) throw httpError(429, "Too many active browser sessions. Stop one and retry.");
  const url = normalizeUrl(payload.url);
  await assertPublicUrl(url);
  const width = clampInt(payload.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH);
  const height = clampInt(payload.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT);
  const fps = clampInt(payload.fps, config.mjpeg.minFps, config.mjpeg.maxFps, DEFAULT_FPS);
  const quality = screenshotQuality(payload.quality);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    executablePath: await executablePath(),
    headless: true,
    ignoreDefaultArgs: ["--mute-audio"],
    args: ["--no-first-run", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    userAgent: payload.userAgent || undefined,
  });
  await context.addInitScript(FULLSCREEN_SHIM);
  await context.route("**/*", async (route) => {
    if (await requestAllowed(route.request().url())) return route.continue();
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  const id = cryptoRandomId();
  const session = {
    id,
    url: url.toString(),
    width,
    height,
    fps,
    quality,
    browser,
    context,
    page,
    title: "",
    clients: new Set(),
    transports: new Set(),
    timer: null,
    capturing: false,
    captureErrors: 0,
    closed: false,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessions.set(id, session);
  startCleanupTimer();
  try {
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    session.title = err.message;
  }
  try {
    session.title = await page.title();
  } catch {}
  scheduleMediaWake(session);
  return sessionInfo(session);
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-5);
}

async function capture(session) {
  if (session.closed || session.capturing || session.clients.size === 0) return;
  session.capturing = true;
  try {
    const frame = await captureJpegFrame(session);
    const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    const footer = Buffer.from("\r\n");
    for (const res of [...session.clients]) {
      if (res.destroyed) {
        session.clients.delete(res);
        continue;
      }
      res.write(header);
      res.write(frame);
      res.write(footer);
    }
    session.captureErrors = 0;
  } catch (err) {
    session.captureErrors += 1;
    if (session.captureErrors === 1 || session.captureErrors % 10 === 0) {
      console.error(`[browser-renderer] capture failed for ${session.url}: ${err.message}`);
    }
    if (session.captureErrors >= 30) {
      stop(session.id, "capture-errors").catch(() => {});
    }
  } finally {
    session.capturing = false;
  }
}

function captureJpegFrame(session) {
  if (!session || session.closed || !session.page) throw httpError(404, "Browser session not found.");
  return session.page.screenshot({
    type: "jpeg",
    quality: screenshotQuality(session.quality),
    timeout: 5000,
    animations: "disabled",
  });
}

function ensureCaptureLoop(session) {
  if (session.timer) return;
  const interval = Math.max(1000 / session.fps, 16);
  session.timer = setInterval(() => {
    capture(session).catch(() => {});
  }, interval);
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
  if (!session) throw httpError(404, "Browser session not found.");
  session.lastUsedAt = Date.now();
  const nextFps = payload.fps == null ? session.fps : clampInt(payload.fps, config.mjpeg.minFps, config.mjpeg.maxFps, session.fps);
  const nextQuality = payload.quality == null ? session.quality : screenshotQuality(payload.quality, session.quality);
  const nextWidth = payload.width == null ? session.width : clampInt(payload.width, MIN_WIDTH, MAX_WIDTH, session.width);
  const nextHeight = payload.height == null ? session.height : clampInt(payload.height, MIN_HEIGHT, MAX_HEIGHT, session.height);
  const viewportChanged = nextWidth !== session.width || nextHeight !== session.height;
  const fpsChanged = nextFps !== session.fps;
  const qualityChanged = nextQuality !== session.quality;
  if (viewportChanged) {
    await session.page.setViewportSize({ width: nextWidth, height: nextHeight });
    session.width = nextWidth;
    session.height = nextHeight;
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
    res.status(404).type("text/plain").end("Browser session not found.");
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

export function streamTs(req, res, id, { audio, bitrateK } = {}) {
  const session = get(id);
  if (!session) {
    res.status(404).type("text/plain").end("Browser session not found.");
    return;
  }
  session.lastUsedAt = Date.now();
  session.transports.add(res);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    session.transports.delete(res);
    session.lastUsedAt = Date.now();
  };
  streamBrowserFrameTS(req, res, {
    fps: session.fps,
    width: session.width,
    height: session.height,
    quality: session.quality,
    audio,
    bitrateK,
    label: "browser-ts",
    captureFrame: async () => {
      session.lastUsedAt = Date.now();
      return captureJpegFrame(session);
    },
    onCleanup: cleanup,
  });
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
  for (const frame of session.page.frames()) {
    try {
      const info = await frame.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        const tag = el.tagName?.toLowerCase() || "";
        const isTextInput = tag === "input" && ![
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ].includes(String(el.type || "").toLowerCase());
        const editable = isTextInput || tag === "textarea" || el.isContentEditable;
        if (!editable || el.disabled || el.readOnly) return null;
        return {
          editable: true,
          tag,
          type: String(el.type || "").toLowerCase(),
          value: isTextInput || tag === "textarea" ? el.value || "" : el.textContent || "",
          placeholder: el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("name") || "",
          maxLength: typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : null,
        };
      });
      if (info?.editable) return { frame, info };
    } catch {}
  }
  return null;
}

async function replaceFocusedEditableText(session, text) {
  const focused = await focusedEditableInfo(session);
  if (!focused) return { ok: false, editable: false };
  await focused.frame.evaluate((nextValue) => {
    const el = document.activeElement;
    if (!el) return;
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
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(text ?? ""));
  return { ok: true, editable: true };
}

export async function input(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Browser session not found.");
  session.lastUsedAt = Date.now();
  if (payload.type === "focus-info") {
    const focused = await focusedEditableInfo(session);
    return focused?.info || { editable: false };
  }
  if (payload.type === "replace-text") {
    return replaceFocusedEditableText(session, payload.text);
  }
  if (payload.type === "key") {
    const key = String(payload.key || "");
    const allowed = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
    if (!allowed.has(key)) throw httpError(400, "Unsupported browser key.");
    await session.page.keyboard.press(key);
    return { ok: true };
  }
  if (payload.type === "text") {
    const text = String(payload.text ?? "");
    if (text.length > 4096) throw httpError(400, "Text input is too long.");
    await session.page.keyboard.insertText(text);
    return { ok: true };
  }
  const p = point(payload, session);
  const button = payload.button === 2 ? "right" : "left";
  if (payload.type === "tap") {
    await session.page.mouse.click(p.x, p.y, { button });
    scheduleMediaWake(session);
    return { ok: true };
  }
  if (payload.type === "move") {
    await session.page.mouse.move(p.x, p.y);
    return { ok: true };
  }
  if (payload.type === "down") {
    await session.page.mouse.move(p.x, p.y);
    await session.page.mouse.down({ button });
    return { ok: true };
  }
  if (payload.type === "drag") {
    await session.page.mouse.move(p.x, p.y);
    return { ok: true };
  }
  if (payload.type === "up") {
    await session.page.mouse.move(p.x, p.y);
    await session.page.mouse.up({ button });
    return { ok: true };
  }
  if (payload.type === "scroll") {
    await session.page.mouse.move(p.x, p.y);
    await session.page.mouse.wheel(
      Math.max(-2000, Math.min(2000, Number(payload.dx) || 0)),
      Math.max(-2000, Math.min(2000, Number(payload.dy) || 0))
    );
    return { ok: true };
  }
  throw httpError(400, "Unsupported browser input type.");
}

export async function navigate(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Browser session not found.");
  const url = normalizeUrl(payload.url);
  await assertPublicUrl(url);
  session.lastUsedAt = Date.now();
  await session.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
  session.url = url.toString();
  try {
    session.title = await session.page.title();
  } catch {}
  scheduleMediaWake(session);
  return sessionInfo(session);
}

export async function stop(id, reason = "manual") {
  const session = get(id);
  if (!session) return false;
  sessions.delete(session.id);
  session.closed = true;
  if (session.timer) clearInterval(session.timer);
  for (const res of [...session.clients]) {
    try { res.end(); } catch {}
  }
  for (const res of [...session.transports]) {
    try { res.end(); } catch {}
  }
  session.clients.clear();
  session.transports.clear();
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
  console.log(`[browser-renderer] closed ${session.id} (${reason}) ${session.url}`);
  return true;
}

export async function stopAll(reason = "manual") {
  const ids = [...sessions.keys()];
  const results = await Promise.all(ids.map((id) => stop(id, reason).catch(() => false)));
  return results.filter(Boolean).length;
}
