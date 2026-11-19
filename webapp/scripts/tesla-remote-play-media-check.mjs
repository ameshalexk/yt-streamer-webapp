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
const generatedRegistration = { registKey: randomBytes(16).toString("hex"), morning: randomBytes(16).toString("hex") };
const operations = [];
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
});
feature.attach(server);
let relaySocket;
server.prependListener("upgrade", (request, socket) => {
  if (request.url === TESLA_REMOTE_PLAY_SOCKET) relaySocket = socket;
});
let browser;
try {
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
  await page.locator("#connect").click();
  await page.waitForFunction(() => window.__chiakiWasmReady === 1);
  await see(() => operations.some(event => event.type === TYPES.CONNECT && event.port === 9295),
    "Pinned WASM did not attempt a session through the authenticated WebSocket");
  await page.evaluate(() => {
    const original = api.sessionSetController;
    window.fixtureInput = [];
    api.sessionSetController = (...values) => {
      window.fixtureInput.push(values);
      return original(...values);
    };
    Module.onEvent("connected", 0, "");
    const buttons = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    buttons[6] = { pressed: true, value: 0.5 };
    buttons[17] = { pressed: true, value: 1 };
    window.fixturePads = [{ id: "Synthetic controller", index: 0, connected: true, mapping: "standard", buttons, axes: [.5, -.7, 0, .3] }];
  });
  await page.waitForFunction(() => window.fixtureInput.some(values => values[0] === (1 | 16_384) && values[1] === 128 && values[3] > 0));
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
  let priorConnections = operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length;
  await page.locator("#connect").click();
  await see(() => operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length > priorConnections,
    "The browser did not create a fresh session after Disconnect");
  relaySocket.destroy();
  await page.locator("#retry").waitFor({ state: "visible", timeout: 12000 });
  await see(() => !feature.active, "Dropped WebSocket retained the previous lease");
  await page.locator("#retry").click();
  priorConnections = operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length;
  await page.locator("#connect").click();
  await see(() => operations.filter(event => event.type === TYPES.CONNECT && event.port === 9295).length > priorConnections,
    "Explicit Retry did not restore the authenticated relay");
  await page.locator("#liveDisconnect").click();
  await see(() => !feature.active, "The retried session did not release the relay");
  assert.deepEqual(errors, []);
  console.log(`PASS pinned WASM registration probe, fixture registration storage, session packet, controller neutral state, H.264 320×180 decode, AudioWorklet peak ${peak.toFixed(3)}, disconnect, transport loss, and explicit retry.`);
} finally {
  await browser?.close();
  feature.close(server);
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
