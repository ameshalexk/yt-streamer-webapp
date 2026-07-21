import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { config } from "../config.js";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 360;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const DEFAULT_FPS = 6;
const MIN_FPS = 3;
const MAX_FPS = 60;
const SESSION_TTL_MS = 15 * 60 * 1000;
const IDLE_CLOSE_MS = 60 * 1000;
const BOUNDARY = "realchromeframe";
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
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

async function targetForPort(port) {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw httpError(502, "Chrome did not expose a debuggable page.");
  return page;
}

async function preparePage(session) {
  await session.cdp.ready;
  await session.cdp.call("Page.enable");
  await session.cdp.call("Runtime.enable");
  await session.cdp.call("Network.enable").catch(() => {});
  await session.cdp.call("Network.setUserAgentOverride", { userAgent: DESKTOP_USER_AGENT, platform: "macOS" }).catch(() => {});
  await session.cdp.call("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
  await session.cdp.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }).catch(() => {});
  await session.cdp.call("Emulation.setDeviceMetricsOverride", {
    width: session.width,
    height: session.height,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch(() => {});
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
    url,
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
    clients: new Set(),
    timer: null,
    capturing: false,
    captureErrors: 0,
    closed: false,
    title: "Real Chrome",
    url,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  proc.on("exit", () => {
    session.closed = true;
    sessions.delete(session.id);
    session.cdp?.close();
    if (session.timer) clearInterval(session.timer);
    for (const client of session.clients) {
      try { client.end(); } catch {}
    }
    session.clients.clear();
  });

  try {
    const target = await targetForPort(port);
    session.url = target.url || url;
    session.title = target.title || "Real Chrome";
    session.cdp = connectCdp(target.webSocketDebuggerUrl);
    await preparePage(session);
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
  };
}

function get(id) {
  const session = sessions.get(String(id || ""));
  if (!session || session.closed) return null;
  return session;
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
      await session.cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, radiusX: 2, radiusY: 2, force: 1, id: 1 }] });
      await session.cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button, buttons: 1, clickCount: 1 });
    await session.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button, buttons: 0, clickCount: 1 });
    const fallback = payload.pointerType === "touch" ? await googleLoginClickFallback(session, p).catch(() => null) : null;
    if (fallback?.clicked) return { ok: true, fallback };
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

export async function navigate(id, payload = {}) {
  const session = get(id);
  if (!session) throw httpError(404, "Real Chrome session not found.");
  const url = normalizeUrl(payload.url);
  session.lastUsedAt = Date.now();
  await session.cdp.ready;
  await session.cdp.call("Page.navigate", { url: url.toString() });
  session.url = url.toString();
  session.title = url.hostname || "Real Chrome";
  setTimeout(async () => {
    if (session.closed) return;
    try {
      const target = await targetForPort(session.port);
      session.url = target.url || session.url;
      session.title = target.title || session.title;
    } catch {}
  }, 800).unref?.();
  return sessionInfo(session);
}

export async function stop(id, reason = "manual") {
  const session = get(id);
  if (!session) return false;
  sessions.delete(session.id);
  session.closed = true;
  if (session.timer) clearInterval(session.timer);
  session.cdp?.close();
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
