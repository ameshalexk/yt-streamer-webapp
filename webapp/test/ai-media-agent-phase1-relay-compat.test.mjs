import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import WebSocket from "ws";
import { startLocalAgentRelay } from "../scripts/ai-agent-local-relay.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function nextMessage(socket, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("websocket message timeout")); }, timeoutMs);
    const onMessage = (data) => {
      const value = JSON.parse(data.toString());
      if (!predicate(value)) return;
      clearTimeout(timer); socket.off("message", onMessage); resolve(value);
    };
    socket.on("message", onMessage);
  });
}

async function pair(relayOrigin, browserOrigin, pairingToken, label) {
  const socket = new WebSocket(`${relayOrigin}/dev/player`, { origin: browserOrigin });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const registeredPromise = nextMessage(socket, (value) => value.kind === "registered");
  socket.send(JSON.stringify({ kind: "pair", proof: pairingToken, label }));
  return { socket, registered: await registeredPromise };
}

test("local relay enforces loopback origin and dispatches only to the explicitly selected session", { timeout: 10000 }, async (t) => {
  const browserOrigin = `http://127.0.0.1:${await freePort()}`;
  const ownerToken = crypto.randomBytes(32).toString("base64url");
  const pairingToken = crypto.randomBytes(32).toString("base64url");
  const relay = await startLocalAgentRelay({ ownerToken, pairingToken, browserOrigin, timeoutMs: 2000, ttlMs: 30000 });
  t.after(async () => relay.close());
  const target = await pair(relay.origin, browserOrigin, pairingToken, "selected target");
  const decoy = await pair(relay.origin, browserOrigin, pairingToken, "unselected tab");
  t.after(() => { target.socket.terminate(); decoy.socket.terminate(); });
  target.socket.send(JSON.stringify({ kind: "heartbeat", state: { playback_phase: "playing" } }));
  decoy.socket.send(JSON.stringify({ kind: "heartbeat", state: { playback_phase: "idle" } }));

  const devicesResponse = await fetch(`${relay.origin}/dev/devices`, { headers: { Origin: browserOrigin, Authorization: `Bearer ${ownerToken}` } });
  assert.equal(devicesResponse.status, 200);
  assert.equal(devicesResponse.headers.get("access-control-allow-origin"), browserOrigin);
  const { devices } = await devicesResponse.json();
  assert.equal(devices.length, 2);
  assert.deepEqual(new Set(devices.map((item) => item.device_id)), new Set([target.registered.device_id, decoy.registered.device_id]));

  const wrongOrigin = await fetch(`${relay.origin}/dev/devices`, { headers: { Origin: "http://127.0.0.1:1", Authorization: `Bearer ${ownerToken}` } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get("access-control-allow-origin"), null);
  const noOrigin = await fetch(`${relay.origin}/dev/devices`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(noOrigin.status, 403);
  const unauthorized = await fetch(`${relay.origin}/dev/devices`, { headers: { Origin: browserOrigin, Authorization: "Bearer invalid" } });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), browserOrigin);

  const commandId = crypto.randomUUID();
  const commandPromise = fetch(`${relay.origin}/dev/command`, {
    method: "POST",
    headers: { Origin: browserOrigin, Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: target.registered.device_id, command_id: commandId, action: "pause", args: {} }),
  });
  const delivered = await nextMessage(target.socket, (value) => value.kind === "command");
  assert.equal(delivered.device_id, target.registered.device_id);
  assert.equal(delivered.command_id, commandId);
  assert.equal(delivered.action, "pause");
  const decoyMessages = [];
  decoy.socket.on("message", (data) => decoyMessages.push(data.toString()));
  target.socket.send(JSON.stringify({ kind: "ack", command_id: commandId, status: "completed", state: { paused: true, playback_phase: "paused" } }));
  const response = await commandPromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), browserOrigin);
  const result = await response.json();
  assert.equal(result.device_id, target.registered.device_id);
  assert.equal(result.command_id, commandId);
  assert.equal(result.state.playback_phase, "paused");
  assert.equal(result.state.paused, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(decoyMessages, [], "unselected browser session receives no command");
});

test("relay refuses public browser origins and can retain legacy loopback fixtures", async () => {
  const token = crypto.randomBytes(32).toString("base64url");
  await assert.rejects(() => startLocalAgentRelay({ ownerToken: token,
    pairingToken: crypto.randomBytes(32).toString("base64url"),
    browserOrigin: "https://example.com" }), /browser_origin_must_be_explicit_loopback/);
  const relay=await startLocalAgentRelay({ownerToken:token,
    pairingToken:crypto.randomBytes(32).toString("base64url")});
  try {
    const noOrigin=await fetch(relay.origin+"/dev/devices",{headers:{Authorization:"Bearer "+token}});
    assert.equal(noOrigin.status,200,"local fixture permits no-origin only with loopback and bearer");
  }finally{await relay.close();}
});

test("relay accepts an explicitly configured localhost browser origin", { timeout: 10000 }, async (t) => {
  const browserOrigin = `http://localhost:${await freePort()}`;
  const ownerToken = crypto.randomBytes(32).toString("base64url");
  const pairingToken = crypto.randomBytes(32).toString("base64url");
  const relay = await startLocalAgentRelay({ ownerToken, pairingToken, browserOrigin, timeoutMs: 2000, ttlMs: 30000 });
  t.after(async () => relay.close());
  const paired = await pair(relay.origin, browserOrigin, pairingToken, "localhost tab");
  t.after(() => paired.socket.terminate());
  const response = await fetch(`${relay.origin}/dev/devices`, { headers: { Origin: browserOrigin, Authorization: `Bearer ${ownerToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), browserOrigin);
  assert.equal((await response.json()).devices[0].device_id, paired.registered.device_id);
});
