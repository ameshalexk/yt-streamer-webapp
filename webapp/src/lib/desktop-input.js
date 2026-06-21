import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const SOURCE_PATH = path.join(config.root, "src", "helpers", "desktop-input.c");
const HELPER_PATH = path.join(config.dataDir, "bin", "desktop-input-helper");
const STATUS_CACHE_MS = 3000;
const REQUEST_TIMEOUT_MS = 2500;
const CLICLICK_CANDIDATES = [
  "/opt/homebrew/bin/cliclick",
  "/usr/local/bin/cliclick",
  "/usr/bin/cliclick",
];

let buildPromise = null;
let cliclickPathPromise = null;
let helper = null;
let helperBuffer = "";
let nextId = 1;
let statusCache = null;
const pending = new Map();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function inputSupported() {
  return process.platform === "darwin";
}

async function fileExecutable(file) {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function cliclickPath() {
  if (cliclickPathPromise) return cliclickPathPromise;
  cliclickPathPromise = (async () => {
    const pathCandidates = String(process.env.PATH || "")
      .split(":")
      .filter(Boolean)
      .map((entry) => path.join(entry, "cliclick"));
    for (const candidate of [...pathCandidates, ...CLICLICK_CANDIDATES]) {
      if (await fileExecutable(candidate)) return candidate;
    }
    return "";
  })();
  return cliclickPathPromise;
}

function runProcess(command, args, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2000) stdout = stdout.slice(-2000);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited ${code}`));
    });
  });
}

function cliclickCoord(value) {
  const n = Math.round(Number(value) || 0);
  return n < 0 ? `=${n}` : String(n);
}

function cliclickPoint(point) {
  return `${cliclickCoord(point.x)},${cliclickCoord(point.y)}`;
}

async function cliclickTrusted() {
  const bin = await cliclickPath();
  if (!bin) return false;
  try {
    const { stdout } = await runProcess(bin, ["p"], REQUEST_TIMEOUT_MS);
    const point = stdout.trim();
    if (!/^-?\d+,-?\d+$/.test(point)) return false;
    await runProcess(bin, [`m:${point}`], REQUEST_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

async function runCliclick(args) {
  const bin = await cliclickPath();
  if (!bin) throw new Error("cliclick is not installed.");
  await runProcess(bin, args, REQUEST_TIMEOUT_MS);
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function authorize(req) {
  const expected = config.desktop.inputToken;
  if (!expected) return true;
  const provided = req.get("x-desktop-input-token") || req.body?.token || "";
  return timingSafeEqual(provided, expected);
}

function sanitizeArg(value) {
  return String(value).replace(/[\r\n\s]+/g, "");
}

function parseFields(text) {
  const fields = {};
  for (const part of String(text || "").trim().split(/\s+/)) {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_-]*)=(.+)$/);
    if (!match) continue;
    const value = Number(match[2]);
    fields[match[1]] = Number.isFinite(value) ? value : match[2];
  }
  return fields;
}

function handleHelperLine(line) {
  const match = String(line || "").trim().match(/^(\d+)\s+(ok|err)\s*(.*)$/);
  if (!match) return;
  const id = Number(match[1]);
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (match[2] === "err") {
    entry.reject(new Error(match[3] || "desktop input helper failed"));
    return;
  }
  entry.resolve({
    message: match[3] || "",
    fields: parseFields(match[3] || ""),
  });
}

function failPending(err) {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err);
  }
}

async function ensureBuilt() {
  if (!inputSupported()) throw new Error("Desktop input is only supported on macOS.");
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    await fs.mkdir(path.dirname(HELPER_PATH), { recursive: true });
    let shouldBuild = true;
    try {
      const [source, binary] = await Promise.all([fs.stat(SOURCE_PATH), fs.stat(HELPER_PATH)]);
      shouldBuild = binary.mtimeMs < source.mtimeMs;
    } catch {
      shouldBuild = true;
    }
    if (!shouldBuild) return;
    await new Promise((resolve, reject) => {
      const clang = spawn("clang", [SOURCE_PATH, "-framework", "ApplicationServices", "-o", HELPER_PATH], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      clang.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 6000) stderr = stderr.slice(-6000);
      });
      clang.on("error", reject);
      clang.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Could not build desktop input helper with clang: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  })();
  try {
    await buildPromise;
  } finally {
    buildPromise = null;
  }
}

async function ensureHelper() {
  await ensureBuilt();
  if (helper && !helper.killed) return helper;
  helper = spawn(HELPER_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
  helperBuffer = "";
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => {
    helperBuffer += chunk;
    let newline = helperBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = helperBuffer.slice(0, newline);
      helperBuffer = helperBuffer.slice(newline + 1);
      handleHelperLine(line);
      newline = helperBuffer.indexOf("\n");
    }
  });
  helper.stderr.on("data", (chunk) => {
    console.error("[desktop-input]", String(chunk).trim());
  });
  helper.on("error", (err) => {
    failPending(err);
  });
  helper.on("close", () => {
    helper = null;
    failPending(new Error("desktop input helper stopped"));
  });
  return helper;
}

async function helperCommand(args, timeoutMs = REQUEST_TIMEOUT_MS) {
  const proc = await ensureHelper();
  const id = nextId++;
  const line = `${id} ${args.map(sanitizeArg).join(" ")}\n`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("desktop input helper timed out"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(line, (err) => {
      if (!err) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function helperStatus({ prompt = false, allowCache = true } = {}) {
  if (allowCache && !prompt && statusCache && Date.now() - statusCache.cachedAt < STATUS_CACHE_MS) {
    return statusCache;
  }
  const result = await helperCommand(["status", prompt ? "1" : "0"]);
  const fields = result.fields || {};
  statusCache = {
    trusted: fields.trusted === 1,
    x: Number(fields.x) || 0,
    y: Number(fields.y) || 0,
    width: Number(fields.width) || 0,
    height: Number(fields.height) || 0,
    cachedAt: Date.now(),
  };
  return statusCache;
}

export async function status({ prompt = false } = {}) {
  const base = {
    enabled: Boolean(config.desktop.inputEnabled),
    supported: inputSupported(),
    protected: Boolean(config.desktop.inputToken),
    available: false,
    trusted: false,
    display: null,
    error: "",
  };
  if (!base.enabled) return base;
  if (!base.supported) {
    return { ...base, error: "Desktop input is only supported on macOS." };
  }
  try {
    const helper = await helperStatus({ prompt, allowCache: !prompt });
    const cliclick = await cliclickTrusted();
    return {
      ...base,
      available: true,
      trusted: helper.trusted || cliclick,
      display: {
        x: helper.x,
        y: helper.y,
        width: config.desktop.inputWidth || helper.width,
        height: config.desktop.inputHeight || helper.height,
      },
    };
  } catch (err) {
    return { ...base, error: err.message };
  }
}

function normalized(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw httpError(400, `${name} must be a number.`);
  return Math.max(0, Math.min(1, number));
}

function limitedNumber(value, name, min, max, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw httpError(400, `${name} must be a number.`);
  return Math.max(min, Math.min(max, number));
}

function mapPoint(payload, display) {
  const nx = normalized(payload.x, "x");
  const ny = normalized(payload.y, "y");
  const width = Math.max(1, Number(display.width) || 1);
  const height = Math.max(1, Number(display.height) || 1);
  const originX = Number(display.x) || 0;
  const originY = Number(display.y) || 0;
  return {
    x: Math.round(originX + nx * (width - 1)),
    y: Math.round(originY + ny * (height - 1)),
  };
}

function helperAction(type) {
  if (type === "tap") return "click";
  if (["move", "down", "drag", "up", "scroll"].includes(type)) return type;
  throw httpError(400, "Unsupported desktop input type.");
}

export async function send(payload = {}) {
  if (!config.desktop.inputEnabled) throw httpError(404, "Desktop input is disabled.");
  if (!inputSupported()) throw httpError(404, "Desktop input is only supported on macOS.");
  const current = await status();
  if (!current.available) throw httpError(503, current.error || "Desktop input helper is unavailable.");
  if (!current.trusted) throw httpError(409, "macOS Accessibility permission is required for desktop input.");

  const action = helperAction(payload.type);
  const point = mapPoint(payload, current.display);
  const button = payload.button === 2 ? 2 : 1;

  if (await cliclickTrusted()) {
    const xy = cliclickPoint(point);
    if (action === "click") {
      await runCliclick([button === 2 ? `rc:${xy}` : `c:${xy}`]);
      return { ok: true };
    }
    if (action === "move") {
      await runCliclick([`m:${xy}`]);
      return { ok: true };
    }
    if (action === "down") {
      await runCliclick([`dd:${xy}`]);
      return { ok: true };
    }
    if (action === "drag") {
      await runCliclick([`dm:${xy}`]);
      return { ok: true };
    }
    if (action === "up") {
      await runCliclick([`du:${xy}`]);
      return { ok: true };
    }
  }

  if (action === "scroll") {
    const dx = Math.round(limitedNumber(payload.dx, "dx", -2000, 2000, 0));
    const dy = Math.round(limitedNumber(payload.dy, "dy", -2000, 2000, 0));
    await helperCommand(["scroll", point.x, point.y, dx, dy]);
    return { ok: true };
  }

  await helperCommand([action, point.x, point.y, button]);
  return { ok: true };
}
