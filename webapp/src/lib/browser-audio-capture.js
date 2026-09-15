import fsNative from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

const SWITCH_AUDIO_SOURCE = process.env.SWITCH_AUDIO_SOURCE_PATH || "/opt/homebrew/bin/SwitchAudioSource";
const BLACKHOLE_NAME = process.env.BROWSER_BLACKHOLE_NAME || "BlackHole 2ch";
const HELPER_APP = path.join(config.root, "native", "build", "YTStreamerAudioTap.app");
const HELPER_BIN = path.join(HELPER_APP, "Contents", "MacOS", "YTStreamerAudioTap");
const HELPER_SOURCE = path.join(config.root, "native", "audio-tap", "main.m");
const HELPER_BUILD = path.join(config.root, "scripts", "build-audio-tap.sh");
const CORE_TAP_ROOT = path.join(os.tmpdir(), "ytstreamer-browser-audio-taps");

const activeCoreTaps = new Set();
let blackHoleRefs = 0;
let blackHolePreviousOutput = "";
let blackHolePreviousSystem = "";

function run(command, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(path.basename(command) + " timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(stderr.trim() || stdout.trim() || (path.basename(command) + " exited " + code)));
      else resolve(stdout.trim());
    });
  });
}

async function ensureHelperBuilt() {
  let needsBuild = false;
  try {
    const [source, buildScript, binary] = await Promise.all([
      fs.stat(HELPER_SOURCE),
      fs.stat(HELPER_BUILD),
      fs.stat(HELPER_BIN),
    ]);
    needsBuild = Math.max(source.mtimeMs, buildScript.mtimeMs) > binary.mtimeMs;
  } catch {
    needsBuild = true;
  }
  if (needsBuild) await run("/bin/zsh", [HELPER_BUILD], { timeoutMs: 30_000 });
  return HELPER_APP;
}

async function currentDevice(type) {
  return run(SWITCH_AUDIO_SOURCE, ["-c", "-t", type]);
}

async function setDevice(type, name) {
  await run(SWITCH_AUDIO_SOURCE, ["-s", name, "-t", type]);
}

async function restoreDevice(type, name) {
  if (!name || name === BLACKHOLE_NAME) return;
  await setDevice(type, name).catch((error) => {
    console.warn("[browser-audio] could not restore " + type + " device:", error.message);
  });
}

async function acquireBlackHole() {
  if (blackHoleRefs === 0) {
    [blackHolePreviousOutput, blackHolePreviousSystem] = await Promise.all([
      currentDevice("output").catch(() => ""),
      currentDevice("system").catch(() => ""),
    ]);
    try {
      if (blackHolePreviousOutput !== BLACKHOLE_NAME) await setDevice("output", BLACKHOLE_NAME);
      if (blackHolePreviousSystem !== BLACKHOLE_NAME) await setDevice("system", BLACKHOLE_NAME);
    } catch (error) {
      await Promise.all([
        restoreDevice("output", blackHolePreviousOutput),
        restoreDevice("system", blackHolePreviousSystem),
      ]);
      blackHolePreviousOutput = "";
      blackHolePreviousSystem = "";
      throw error;
    }
  }

  blackHoleRefs += 1;
  let released = false;
  return {
    backend: "blackhole-direct",
    audio: BLACKHOLE_NAME,
    details: {
      deviceName: BLACKHOLE_NAME,
      previousOutput: blackHolePreviousOutput,
      previousSystemOutput: blackHolePreviousSystem,
      localMuted: true,
    },
    release: async () => {
      if (released) return;
      released = true;
      blackHoleRefs = Math.max(0, blackHoleRefs - 1);
      if (blackHoleRefs !== 0) return;

      const previousOutput = blackHolePreviousOutput;
      const previousSystem = blackHolePreviousSystem;
      blackHolePreviousOutput = "";
      blackHolePreviousSystem = "";
      await Promise.all([
        restoreDevice("output", previousOutput),
        restoreDevice("system", previousSystem),
      ]);
    },
  };
}

function parseStatus(text) {
  const messages = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("YTAP ")) continue;
    try {
      messages.push(JSON.parse(line.slice(5)));
    } catch {}
  }
  return messages;
}

function coreTapPermissionError() {
  const error = new Error(
    "Core Tap needs macOS System Audio Recording permission. On the Mac, open System Settings → Privacy & Security → Screen & System Audio Recording, enable YT Streamer Audio Tap, then retry."
  );
  error.code = "CORE_TAP_PERMISSION_REQUIRED";
  return error;
}

async function helperRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopHelper(pid) {
  if (!await helperRunning(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    if (!await helperRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function waitForHelperStatus(statusPath, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastMessages = [];
  while (Date.now() < deadline) {
    let text = "";
    try { text = await fs.readFile(statusPath, "utf8"); } catch {}
    const messages = parseStatus(text);
    if (messages.length) {
      lastMessages = messages;
      for (const message of messages) {
        if (message.ready === true) return { ready: message, messages };
        if (message.ready === false) {
          const error = new Error(message.error || "Core Audio tap failed");
          if (message.permissionRequired) error.code = "CORE_TAP_PERMISSION_REQUIRED";
          error.helperPid = Number(message.helperPid) || null;
          throw error;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const last = lastMessages.at(-1) || {};
  const error = last.stage === "create-ioproc" || last.stage === "ioproc-created"
    ? coreTapPermissionError()
    : new Error("YT Streamer Audio Tap did not become ready in time.");
  error.helperPid = Number(last.helperPid) || null;
  error.statusMessages = lastMessages;
  throw error;
}

async function createCoreTapSessionFiles() {
  await fs.mkdir(CORE_TAP_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(CORE_TAP_ROOT, "tap-"));
  const fifoPath = path.join(dir, "audio.f32le");
  const statusPath = path.join(dir, "status.log");
  await run("/usr/bin/mkfifo", [fifoPath]);
  await fs.writeFile(statusPath, "");
  const fifoHandle = await fs.open(fifoPath, fsNative.constants.O_RDWR);
  const pcmStream = fifoHandle.createReadStream({ autoClose: false });
  return { dir, fifoPath, statusPath, fifoHandle, pcmStream };
}

async function cleanupCoreTapFiles(session) {
  try { session.pcmStream?.destroy(); } catch {}
  try { await session.fifoHandle?.close(); } catch {}
  await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

async function acquireCoreTap(processPids = []) {
  const pids = [...new Set(
    processPids
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 1)
  )];
  if (!pids.length) throw new Error("Real Chrome has no process IDs available for Core Audio capture.");

  await ensureHelperBuilt();
  const session = await createCoreTapSessionFiles();
  const args = pids.flatMap((pid) => ["--pid", String(pid)]);
  args.push(
    "--mute", "1",
    "--name", "YT Streamer Chrome Process Tap",
    "--pcm-fifo", session.fifoPath,
    "--status-file", session.statusPath
  );

  try {
    await run("/usr/bin/open", ["-n", HELPER_APP, "--args", ...args], { timeoutMs: 8000 });
    const { ready } = await waitForHelperStatus(session.statusPath);
    session.helperPid = Number(ready.helperPid) || null;
    session.sampleRate = Number(ready.sampleRate) || 48000;
    session.channels = Number(ready.channels) || 2;
    activeCoreTaps.add(session);
  } catch (error) {
    let helperPid = Number(error.helperPid) || null;
    if (!helperPid) {
      try {
        const messages = parseStatus(await fs.readFile(session.statusPath, "utf8"));
        helperPid = Number(messages.at(-1)?.helperPid) || null;
      } catch {}
    }
    if (helperPid) await stopHelper(helperPid);
    await cleanupCoreTapFiles(session);
    if (error.code === "CORE_TAP_PERMISSION_REQUIRED") throw coreTapPermissionError();
    throw error;
  }

  let released = false;
  return {
    backend: "core-tap",
    audio: "",
    pcmStream: session.pcmStream,
    details: {
      helperPid: session.helperPid,
      sampleRate: session.sampleRate,
      channels: session.channels,
      sampleFormat: "f32le",
      localMuted: true,
    },
    release: async () => {
      if (released) return;
      released = true;
      activeCoreTaps.delete(session);
      await stopHelper(session.helperPid);
      await cleanupCoreTapFiles(session);
    },
  };
}

export function normalizeBackend(value) {
  const raw = String(value || "manual").toLowerCase();
  if (raw === "blackhole-direct" || raw === "core-tap") return raw;
  return "manual";
}

export async function acquire({ backend, audio = "", processPids = [] } = {}) {
  const mode = normalizeBackend(backend);
  if (mode === "blackhole-direct") return acquireBlackHole();
  if (mode === "core-tap") return acquireCoreTap(processPids);
  return {
    backend: "manual",
    audio: String(audio || ""),
    details: { localMuted: false },
    release: async () => {},
  };
}

export async function releaseAll() {
  const sessions = [...activeCoreTaps];
  activeCoreTaps.clear();
  await Promise.all(sessions.map(async (session) => {
    await stopHelper(session.helperPid);
    await cleanupCoreTapFiles(session);
  }));

  const previousOutput = blackHolePreviousOutput;
  const previousSystem = blackHolePreviousSystem;
  blackHoleRefs = 0;
  blackHolePreviousOutput = "";
  blackHolePreviousSystem = "";
  await Promise.all([
    restoreDevice("output", previousOutput),
    restoreDevice("system", previousSystem),
  ]);
}

export function status() {
  return {
    blackHoleRefs,
    blackHolePreviousOutput,
    blackHolePreviousSystem,
    activeCoreTaps: activeCoreTaps.size,
    helperApp: HELPER_APP,
  };
}
