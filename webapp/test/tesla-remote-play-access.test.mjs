import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket } from "ws";
import { mountTeslaRemotePlay, TESLA_REMOTE_PLAY_SOCKET } from "../src/lib/tesla-remote-play.js";
import { chiakiRelayProtocol as protocol } from "../src/lib/tesla-remote-play-relay.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const audience = "remote-play-test-audience";
const origin = "https://remote-play.example";
const issuer = "https://fixture.cloudflareaccess.com";
const keys = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture" }] };
const ownerEmail = "owner@example.test";
const consoleIp = "192.168.42.11";
const encode = data => Buffer.from(JSON.stringify(data)).toString("base64url");
function jwt(now, changes = {}) {
  const timestamp = Math.floor(now / 1000);
  const claim = { iss: issuer, aud: [audience], iat: timestamp - 10, exp: timestamp + 60,
    sub: "owner-fixture", email: ownerEmail, ...changes };
  const input = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(claim)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

async function start(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-play-fixture-"));
  const data = path.join(dir, "tesla-remote-play");
  const app = express();
  const time = { at: Date.now() };
  const feature = mountTeslaRemotePlay(app, {
    root: fileURLToPath(new URL("../", import.meta.url)), dataDir: dir, origin, enabled: true, audience, ownerEmail,
    provider: { issuer, get: async () => keys }, now: () => time.at, pingIntervalMs: 30, ...options,
  });
  app.get("/", (_req, res) => res.send("neighbor"));
  const server = app.listen(0, "127.0.0.1");
  feature.attach(server);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "cf-access-jwt-assertion": jwt(time.at) };
  t.after(async () => {
    feature.close(server);
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { base, headers, time, data, feature,
    async configure() {
      await fs.mkdir(data, { mode: 0o700 });
      await fs.writeFile(path.join(data, "console-ip"), consoleIp, { mode: 0o600 });
    },
    open(opts = {}) {
      return new WebSocket(base.replace("http:", "ws:") + TESLA_REMOTE_PLAY_SOCKET,
        opts.protocol ?? "binary", { origin: opts.origin ?? origin, headers: opts.headers ?? headers });
    },
  };
}

function refused(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", () => { ws.terminate(); reject(Error("unexpected upgrade")); });
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
}

test("owner can open the isolated player; signed-out, expired and non-owner credentials cannot", async t => {
  const fixture = await start(t);
  const paths = ["/api/tesla-remote-play/status", "/api/tesla-remote-play/console",
    "/tesla-remote-play/", "/tesla-remote-play/chiaki.wasm", "/tesla-remote-play/source"];
  const denied = [
    [{}, 401],
    [{ "cf-access-jwt-assertion": jwt(fixture.time.at, { exp: Math.floor(fixture.time.at / 1000) - 1 }) }, 401],
    [{ "cf-access-jwt-assertion": jwt(fixture.time.at, { email: "other@example.test" }) }, 403],
    [{ "cf-access-jwt-assertion": jwt(fixture.time.at, { aud: "other-app" }) }, 401],
  ];
  for (const [headers, status] of denied) {
    for (const url of paths) assert.equal((await fetch(fixture.base + url, { headers })).status, status);
    assert.equal(await refused(fixture.open({ headers })), status);
  }
  const status = await fetch(fixture.base + paths[0], { headers: fixture.headers });
  assert.deepEqual(await status.json(), { available: true, configured: false });
  assert.equal(await refused(fixture.open()), 503);
  const source = await fetch(fixture.base + "/tesla-remote-play/source", { headers: fixture.headers });
  assert.equal(source.status, 200);
  assert.equal(source.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(source.headers.get("cross-origin-embedder-policy"), "require-corp");
  for (const [asset, type] of [["chiaki-source.tar.gz", "application/gzip"],
    ["chiaki-license.txt", "text/plain"], ["chiaki-manifest.json", "application/json"],
    ["chiaki-notice.txt", "text/plain"], ["chiaki.js", "text/javascript"], ["chiaki.wasm", "application/wasm"]]) {
    const reply = await fetch(`${fixture.base}/tesla-remote-play/${asset}`, { headers: fixture.headers });
    assert.equal(reply.status, 200, asset);
    assert.ok(reply.headers.get("content-type").startsWith(type), asset);
    assert.ok((await reply.arrayBuffer()).byteLength > 100, asset);
  }
  const neighbor = await fetch(fixture.base + "/");
  assert.equal(neighbor.headers.get("cross-origin-embedder-policy"), null);
  assert.equal(await neighbor.text(), "neighbor");
  assert.equal((await fetch(fixture.base + "/tesla-remote-play/source", { headers: {
    "cf-access-jwt-assertion": "invalid", cookie: `CF_Authorization=${jwt(fixture.time.at)}`,
  } })).status, 401);
});

test("registration is owner-bound, same-origin and private on disk", async t => {
  const fixture = await start(t);
  await fixture.configure();
  const endpoint = fixture.base + "/api/tesla-remote-play/console";
  const credentials = { registKey: randomBytes(16).toString("hex"), morning: randomBytes(16).toString("hex") };
  const set = (requestOrigin, body) => fetch(endpoint, { method: "PUT", body,
    headers: { ...fixture.headers, origin: requestOrigin, "content-type": "application/json" } });
  assert.equal((await set("https://other.example", JSON.stringify(credentials))).status, 403);
  assert.equal((await set(origin, "{" )).status, 400);
  assert.equal((await set(origin, JSON.stringify({ bogus: true }))).status, 400);
  assert.equal((await set(origin, JSON.stringify(credentials))).status, 204);
  const read = await fetch(endpoint, { headers: fixture.headers });
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await read.json(), { host: consoleIp, registration: credentials });
  assert.equal((await fs.stat(path.join(fixture.data, "registration.json"))).mode & 0o777, 0o600);
  const alternate = await fetch(endpoint, { headers: { "cf-access-jwt-assertion": jwt(fixture.time.at, { sub: "different-profile" }) } });
  assert.deepEqual(await alternate.json(), { host: consoleIp, registration: null });
});

test("WebSocket relays the pinned binary protocol and never hands an active lease to a competitor", async t => {
  const fixture = await start(t);
  await fixture.configure();
  assert.equal(await refused(fixture.open({ origin: "https://other.example" })), 403);
  assert.equal(await refused(fixture.open({ protocol: "other" })), 403);
  const primary = fixture.open();
  await once(primary, "open");
  assert.equal(fixture.feature.active, true);
  assert.equal(await refused(fixture.open()), 409);
  const reply = once(primary, "message");
  primary.send(protocol.encode(protocol.TYPES.GETADDRINFO, 1, 0, 0, 0, 0, Buffer.from(`${consoleIp}\0`)));
  assert.equal(protocol.readPacket((await reply)[0]).type, protocol.TYPES.REPLY);
  const closed = once(primary, "close");
  primary.close();
  await closed;
  const next = fixture.open();
  await once(next, "open");
  const expired = once(next, "close");
  fixture.time.at += 61_000;
  await expired;
  for (let retry = 0; retry < 50 && fixture.feature.active; retry++) await delay(10);
  assert.equal(fixture.feature.active, false);
  assert.equal(await refused(fixture.open()), 401);
});

test("the disabled host exposes neither player nor control socket", async t => {
  const fixture = await start(t, { enabled: false });
  assert.equal((await fetch(fixture.base + "/api/tesla-remote-play/status", { headers: fixture.headers })).status, 404);
  assert.equal((await fetch(fixture.base + "/tesla-remote-play/", { headers: fixture.headers })).status, 404);
  assert.equal(await refused(fixture.open()), 503);
});


test("operator disable hides the feature and closes an established relay", async t => {
  const fixture = await start(t);
  await fixture.configure();
  const ws = fixture.open();
  await once(ws, "open");
  const closed = once(ws, "close");
  await fs.writeFile(path.join(fixture.data, "disabled"), "1", { mode: 0o600 });
  await closed;
  const status = await fetch(fixture.base + "/api/tesla-remote-play/status", { headers: fixture.headers });
  assert.equal(status.status, 404);
  assert.equal(await refused(fixture.open()), 503);
});
