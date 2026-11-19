// Browser fixture for the shipped WASM and player. A deterministic peer replies
// at the packet relay boundary. It never opens a socket to a PS5.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomInt, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium } from "playwright-core";
import { mountTeslaRemotePlay, TESLA_REMOTE_PLAY_SOCKET } from "../src/lib/tesla-remote-play.js";
import { chiakiRelayProtocol as wire } from "../src/lib/tesla-remote-play-relay.mjs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const evidenceDir = process.env.TESLA_REMOTE_PLAY_EVIDENCE_DIR
  ? path.resolve(process.env.TESLA_REMOTE_PLAY_EVIDENCE_DIR) : null;
const host = "192.168.42.23";
const audience = "remote-play-media-fixture";
const issuer = "https://fixture.cloudflareaccess.com";
const email = "owner@example.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const at = Math.floor(Date.now() / 1000);
const keys = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture" }] };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const claims = { iss: issuer, aud: [audience], iat: at - 20, exp: at + 600, sub: "the-fixture-owner", email };
const assertion = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(claims)}`;
const token = `${assertion}.${sign("RSA-SHA256", Buffer.from(assertion), privateKey).toString("base64url")}`;
const generatedRegistration = {
  registKey: Buffer.from(randomBytes(4).toString("hex").padEnd(16, "\0")).toString("hex"),
  morning: randomBytes(16).toString("hex"),
};
const operations = [];
let powerState = "ready";
let wakeRequests = 0;
const { TYPES } = wire;

function fixturePeer({ send }) {
  return {
    async handle(buffer) {
      const request = wire.readHeader(buffer);
      if (!request) throw Error("invalid fixture packet");
      const { type, fd, id, b, length } = request;
      operations.push({ type, port: b });
      let result = type === TYPES.SEND || type === TYPES.SENDTO ? length : 0;
      let payload;
      if (type === TYPES.GETADDRINFO) {
        payload = Buffer.from(host.split(".").map(Number));
        result = payload.readUInt32LE();
      }
      if (type === TYPES.CONNECT) send(wire.encode(TYPES.PUSH_CONNECTED, 0, fd));
      if (type === TYPES.SENDTO && b === 9295 && request.payload.toString("ascii") === "SRC3\0") {
        const source = Buffer.from(host.split(".").map(Number)).readUInt32LE();
        send(wire.encode(TYPES.PUSH_DATA, 0, fd, 0, b, source, Buffer.from("RES3\0")));
      }
      if (id) send(wire.encode(TYPES.REPLY, id, fd, result, 0, 0, payload));
    },
    closeAll() {},
  };
}

function videoFixture() {
  const ffmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
    "-frames:v", "16", "-threads", "1", "-c:v", "libx264", "-profile:v", "baseline", "-preset", "ultrafast",
    "-tune", "zerolatency", "-x264-params", "aud=1:repeat-headers=1", "-f", "h264", "-",
  ]);
  assert.equal(ffmpeg.status, 0, "FFmpeg could not generate the H.264 fixture");
  const bytes = ffmpeg.stdout;
  const units = [];
  let start = 0;
  for (let n = 0; n < bytes.length - 4; n++) {
    if (bytes[n] === 0 && bytes[n + 1] === 0 && bytes[n + 2] === 0 && bytes[n + 3] === 1 &&
        (bytes[n + 4] & 31) === 9 && n > start) {
      units.push(bytes.subarray(start, n).toString("base64"));
      start = n;
    }
  }
  units.push(bytes.subarray(start).toString("base64"));
  assert.equal(units.length, 16);
  return units;
}

async function see(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(message);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "remote-play-media-"));
const dir = path.join(temp, "tesla-remote-play");
await fs.mkdir(dir, { mode: 0o700 });
await fs.writeFile(path.join(dir, "console-ip"), host, { mode: 0o600 });
const app = express();
const server = createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const feature = mountTeslaRemotePlay(app, {
  root: fileURLToPath(new URL("../", import.meta.url)), dataDir: temp, origin, enabled: true,
  audience, ownerEmail: email, provider: { issuer, get: async () => keys }, relayFactory: fixturePeer,
  powerProbe: async () => powerState,
  wakeSender: async (target, packet) => {
    assert.equal(target, host);
    assert.ok(Buffer.isBuffer(packet));
    wakeRequests++;
  },
});
feature.attach(server);
let relaySocket;
server.prependListener("upgrade", (request, socket) => {
  if (request.url === TESLA_REMOTE_PLAY_SOCKET) relaySocket = socket;
});
let browser;
try {
  if (evidenceDir) await fs.mkdir(evidenceDir, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{ name: "CF_Authorization", value: token, url: origin, httpOnly: true }]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.fixturePads = [];
    Object.defineProperty(navigator, "getGamepads", { value: () => window.fixturePads });
  });
  const errors = [];
  page.on("pageerror", () => errors.push("unhandled browser error"));
  await page.goto(`${origin}/tesla-remote-play/`);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.locator("#pairing summary").click();
  await page.locator("#pin").fill(String(randomInt(10_000_000, 100_000_000)));
  await page.locator("#accountId").fill(randomBytes(8).toString("base64"));
  await page.locator("#pair").click();
  await see(() => operations.some(event => event.type === TYPES.SENDTO && event.port === 9295),
    "Pinned WASM did not send a unicast registration probe through the relay");
  await page.evaluate(keys => Module.onRegist({ ok: true, ...keys }), generatedRegistration);
  await see(async () => {
    const response = await fetch(`${origin}/api/tesla-remote-play/console`, { headers: { "cf-access-jwt-assertion": token } });
    const result = await response.json();
    return result.registration?.registKey === generatedRegistration.registKey;
  }, "The registration result did not reach the private owner store");
  assert.equal(await page.locator("#pin").inputValue(), "");
  assert.equal(await page.locator("#accountId").inputValue(), "");
  await see(() => !feature.active, "The pairing socket did not close");

  await page.goto(`${origin}/tesla-remote-play/`);
  const priorWakeRequests = wakeRequests;
  await page.locator("#wake").click();
  await see(() => wakeRequests === priorWakeRequests + 1,
    "Wake did not send exactly one native PS5 wake request");
  assert.equal(feature.active, false, "Wake must not acquire a Remote Play relay lease");

  // Model a PS5 in rest mode. The primary action must issue exactly one
  // explicit wake packet and defer sessionStart until discovery says ready.
  powerState = "standby";
  // Expire one-second server-side power probe cache before reloading.
  await delay(1100);
  await page.goto(`${origin}/tesla-remote-play/`);
  await page.locator("#qualityBefore").selectOption("1080");
  await page.getByRole("button", { name: "Wake PS5 and connect" }).waitFor();
  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "tesla-standby-wake-connect-fixture.png"), fullPage: true });
  }
  await page.evaluate(async () => {
    await loadRuntime();
    window.sessionStartCalls = [];
    const cwrap = Module.cwrap.bind(Module);
    Module.cwrap = (name, ...args) => {
      const fn = cwrap(name, ...args);
      if (name !== "chiaki_wasm_session_start") return fn;
      return (...values) => { window.sessionStartCalls.push(values); return fn(...values); };
    };
  });
  const priorConnectRequests = wakeRequests;
  let wakeSessionCount = operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length;
  await page.getByRole("button", { name: "Wake PS5 and connect" }).click();
  await see(() => wakeRequests === priorConnectRequests + 1,
    "Wake and connect did not send exactly one native PS5 wake request");
  await delay(1100);
  assert.equal(await page.evaluate(() => window.sessionStartCalls.length), 0,
    "The player started a session before the PS5 left standby");
  assert.equal(operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length,
    wakeSessionCount, "The player opened a relay connection while the PS5 was still in standby");
  assert.equal(feature.active, false, "The player held a relay lease while the PS5 was still waking");
  powerState = "ready";
  await see(() => page.evaluate(() => window.sessionStartCalls.length > 0),
    "The player did not start after the PS5 became ready");
  assert.deepEqual(await page.evaluate(() => window.sessionStartCalls[0].slice(3)),
    [1, 4, 60, 0, 15000], "Wake and connect must preserve the requested 1080p60 profile");
  await page.evaluate(() => Module.onEvent("quit", 1, "fixture console quit"));
  await page.locator("#retry").waitFor({ state: "visible" });
  assert.match(await page.locator("#state").innerText(), /session ended|connection failed|quit/i);
  assert.equal(await page.locator("#player").isVisible(), true,
    "Unexpected PS5 quit should keep the failure and retry controls in view");
  await see(() => !feature.active, "Unexpected PS5 quit did not release the authenticated relay");

  // A user can cancel while the PS5 is still waking. A late ready reply must
  // never launch a session after cancellation.
  powerState = "standby";
  // Expire one-second server-side power probe cache before reloading.
  await delay(1100);
  await page.goto(`${origin}/tesla-remote-play/`);
  await page.locator("#qualityBefore").selectOption("1080");
  await page.evaluate(async () => {
    await loadRuntime();
    window.sessionStartCalls = [];
    const cwrap = Module.cwrap.bind(Module);
    Module.cwrap = (name, ...args) => {
      const fn = cwrap(name, ...args);
      if (name !== "chiaki_wasm_session_start") return fn;
      return (...values) => { window.sessionStartCalls.push(values); return fn(...values); };
    };
  });
  await page.getByRole("button", { name: "Wake PS5 and connect" }).waitFor();
  const beforeCancelConnectRequests = wakeRequests;
  await page.getByRole("button", { name: "Wake PS5 and connect" }).click();
  await see(() => wakeRequests === beforeCancelConnectRequests + 1,
    "The second wake and connect action did not issue one native wake request");
  wakeSessionCount = operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length;
  await page.locator("#liveDisconnect").click();
  await page.getByText("Connection cancelled.", { exact: true }).waitFor();
  powerState = "ready";
  await delay(2300);
  assert.equal(operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length,
    wakeSessionCount, "Cancellation opened a Remote Play session after the user cancelled");

  await page.goto(`${origin}/tesla-remote-play/`);
  await page.locator("#qualityBefore").selectOption("540");
  await page.evaluate(async () => {
    await loadRuntime();
    window.sessionStartCalls = [];
    const cwrap = Module.cwrap.bind(Module);
    Module.cwrap = (name, ...args) => {
      const fn = cwrap(name, ...args);
      if (name !== "chiaki_wasm_session_start") return fn;
      return (...values) => {
        window.sessionStartCalls.push(values);
        return fn(...values);
      };
    };
  });
  const connectionCount = () => operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length;
  let priorConnections = connectionCount();
  await page.locator("#connect").click();
  assert.equal(await page.locator("#quality").inputValue(), "540");
  await page.waitForFunction(() => window.__chiakiWasmReady === 1);
  await see(() => connectionCount() > priorConnections,
    "Pinned WASM did not attempt a session through the authenticated WebSocket");
  await see(() => page.evaluate(() => window.sessionStartCalls.length > 0),
    "Player did not invoke the pinned Chiaki session start function");
  assert.deepEqual(await page.evaluate(() => window.sessionStartCalls[0].slice(3)),
    [1, 2, 30, 0, 4500], "540p30 must request the 960x540 preset and its configured bitrate");
  await page.evaluate(() => {
    const original = api.sessionSetController;
    window.fixtureInput = [];
    api.sessionSetController = (...values) => {
      window.fixtureInput.push(values);
      original(...values);
      // The fixture does not negotiate the console feedback channel. Model its
      // accepted state while still exercising the real WASM call boundary.
      return 0;
    };
    Module.onEvent("connected", 0, "");
    const buttons = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    buttons[6] = { pressed: true, value: 0.5 };
    buttons[17] = { pressed: true, value: 1 };
    window.fixturePads = [{ id: "Synthetic controller", index: 0, connected: true, mapping: "standard", buttons, axes: [.5, -.7, 0, .3] }];
  });
  await page.waitForFunction(() => window.fixtureInput.some(values => values[0] === (1 | 16_384) && values[1] === 128 && values[3] > 0));
  const beforeBlur = await page.evaluate(() => window.fixtureInput.length);
  await page.evaluate(() => {
    Document.prototype.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
  await page.waitForFunction(from => window.fixtureInput.slice(from).some(values => values.every(value => value === 0)), beforeBlur);
  await page.evaluate(() => { Document.prototype.hasFocus = () => true; });
  await page.waitForFunction(from => window.fixtureInput.slice(from).some(values => values[0] === (1 | 16_384)), beforeBlur);
  const before = await page.evaluate(() => window.fixtureInput.length);
  await page.evaluate(() => { window.fixturePads = []; });
  await page.waitForFunction(from => window.fixtureInput.slice(from).some(values => values.every(value => value === 0)), before);

  const footage = videoFixture();
  await page.evaluate(async units => {
    for (const unit of units) {
      const data = Uint8Array.from(atob(unit), char => char.charCodeAt(0));
      const ptr = Module._malloc(data.length);
      Module.HEAPU8.set(data, ptr);
      try { await Module.onVideo(ptr, data.length, 0, 0); } finally { Module._free(ptr); }
      await new Promise(resolve => setTimeout(resolve, 34));
    }
  }, footage);
  await page.waitForFunction(() => document.getElementById("screen").width === 320 &&
    document.getElementById("screen").height === 180 && document.getElementById("observed").textContent.includes("320×180"));
  if (evidenceDir) {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => {
      for (const [side, value] of Object.entries({ top: "12px", right: "8px", bottom: "20px", left: "8px" })) {
        document.documentElement.style.setProperty(`--safe-${side}`, value);
      }
      document.querySelector(".video-stage").requestFullscreen = () => Promise.reject(Error("fixture fullscreen fallback"));
    });
    await page.locator("#fullscreen").click();
    await page.locator("#player.expanded-player").waitFor({ state: "attached" });
    await page.screenshot({ path: path.join(evidenceDir, "tesla-expanded-landscape-h264-fixture.png") });
    await page.locator("#fullscreen").click();
    await page.locator("#player:not(.expanded-player)").waitFor({ state: "attached" });
  }
  const peak = await page.evaluate(async () => {
    const meter = audioContext.createAnalyser();
    audioNode.connect(meter);
    const samples = new Float32Array(meter.fftSize);
    Module.onAudioSettings(2, 48000);
    const frames = 960;
    const ptr = Module._malloc(frames * 4);
    let peak = 0;
    try {
      for (let i = 0; i < 28; i++) {
        const pcm = Module.HEAP16.subarray(ptr / 2, ptr / 2 + frames * 2);
        for (let p = 0; p < pcm.length; p++) pcm[p] = Math.sin(p / 13) * 4096;
        Module.onAudio(ptr, frames);
        await new Promise(resolve => setTimeout(resolve, 20));
        meter.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      return peak;
    } finally {
      Module._free(ptr);
      audioNode.disconnect(meter);
    }
  });
  assert.ok(peak > 0.01, "The player AudioWorklet did not output the injected waveform");
  await page.locator("#liveDisconnect").click();
  await see(() => !feature.active, "Disconnect did not release the authenticated relay");
  priorConnections = connectionCount();
  await page.locator("#connect").click();
  await see(() => connectionCount() > priorConnections,
    "The browser did not create a fresh session after Disconnect");
  relaySocket.destroy();
  await page.locator("#retry").waitFor({ state: "visible", timeout: 12000 });
  await see(() => !feature.active, "Dropped WebSocket retained the previous lease");
  await page.locator("#retry").click();
  priorConnections = connectionCount();
  await page.locator("#connect").click();
  await see(() => connectionCount() > priorConnections,
    "Explicit Retry did not restore the authenticated relay");
  await page.locator("#liveDisconnect").click();
  await see(() => !feature.active, "The retried session did not release the relay");
  for (const profile of ["1080", "720"]) {
    await page.goto(`${origin}/tesla-remote-play/`);
    await page.locator("#qualityBefore").selectOption(profile);
    await page.evaluate(async () => {
      await loadRuntime();
      window.sessionStartCalls = [];
      const cwrap = Module.cwrap.bind(Module);
      Module.cwrap = (name, ...args) => {
        const fn = cwrap(name, ...args);
        if (name !== "chiaki_wasm_session_start") return fn;
        return (...values) => {
          window.sessionStartCalls.push(values);
          return fn(...values);
        };
      };
    });
    priorConnections = connectionCount();
    await page.locator("#connect").click();
    await see(() => connectionCount() > priorConnections,
      `${profile}p did not establish its Chiaki session`);
    await see(() => page.evaluate(() => window.sessionStartCalls.length > 0),
      `${profile}p did not call the pinned Chiaki session start function`);
    const expected = profile === "1080" ? [1, 4, 60, 0, 15000] : [1, 3, 60, 0, 8000];
    assert.deepEqual(await page.evaluate(() => window.sessionStartCalls.at(-1).slice(3)), expected,
      `${profile}p60 must request its Chiaki resolution preset, frame rate, codec and bitrate`);
    await page.evaluate(() => Module.onEvent("connected", 0, ""));
    await page.locator("#liveDisconnect").click();
    await see(() => !feature.active, `${profile}p disconnect did not release the authenticated relay`);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS pinned WASM registration probe, fixture registration storage, explicit Wake, requested 1080p60/15Mbps, 720p60/8Mbps, 540p30/4.5Mbps profiles, controller focus/removal neutral state, H.264 320×180 decode, AudioWorklet peak ${peak.toFixed(3)}, disconnect, transport loss, and explicit retry.`);
} finally {
  await browser?.close();
  feature.close(server);
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
