import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import WebSocket from "ws";
import { startLocalAgentRelay } from "../scripts/ai-agent-local-relay.mjs";

const token = () => crypto.randomBytes(32).toString("hex");
async function pairedPlayer(relay, pairingToken, label) {
  const ws = new WebSocket(relay.origin.replace("http", "ws") + "/dev/player", { origin: relay.origin });
  const registered = new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", function onMessage(buffer) {
      const frame = JSON.parse(String(buffer));
      if (frame.kind === "registered") { ws.off("message", onMessage); resolve(frame); }
    });
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ kind: "pair", label, proof: pairingToken }));
  return { ws, device: await registered };
}
async function http(relay, token, route, body, extraHeaders = {}) {
  const r = await fetch(relay.origin + route, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}

test("real WebSockets: only selected paired tab receives command and acks observed state", async () => {
  const owner = token(), pair = token();
  const relay = await startLocalAgentRelay({ ownerToken: owner, pairingToken: pair });
  const sockets = [];
  try {
    const one = await pairedPlayer(relay, pair, "Tesla mock");
    const two = await pairedPlayer(relay, pair, "Phone mock");
    sockets.push(one.ws, two.ws);
    assert.equal((await http(relay, owner, "/dev/devices")).body.devices.length, 2);
    let deliveriesToWrongTab = 0;
    one.ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.kind === "command") deliveriesToWrongTab += 1;
    });
    two.ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.kind === "command") two.ws.send(JSON.stringify({
        kind: "ack", command_id: frame.command_id, status: "completed",
        state: { paused: true, title: "Test track", mode: "mjpeg" },
      }));
    });
    const t0 = performance.now();
    const response = await http(relay, owner, "/dev/command", {
      device_id: two.device.device_id, action: "pause",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "completed");
    assert.equal(response.body.state.paused, true);
    assert.equal(deliveriesToWrongTab, 0);
    assert.ok(performance.now() - t0 < 800, "loopback command should ACK promptly");
  } finally {
    for (const ws of sockets) ws.terminate();
    await relay.close();
  }
});

test("no owner token, wrong Origin and wrong pairing are denied", async () => {
  const owner = token(), pair = token();
  const relay = await startLocalAgentRelay({ ownerToken: owner, pairingToken: pair });
  try {
    assert.equal((await http(relay, "bad", "/dev/devices")).status, 401);
    assert.equal((await http(relay, owner, "/dev/devices", null, { origin: "https://evil.test" })).status, 403);
    const ws = new WebSocket(relay.origin.replace("http","ws") + "/dev/player", { origin: "https://evil.test" });
    const failure = await new Promise((resolve) => {
      ws.on("unexpected-response", (_, response) => resolve(response.statusCode));
      ws.on("error", () => resolve("blocked"));
    });
    assert.equal(failure, 403);
    const bad = new WebSocket(relay.origin.replace("http","ws") + "/dev/player", { origin: relay.origin });
    await new Promise((resolve) => bad.once("open", resolve));
    const close = new Promise(resolve => bad.once("close", code => resolve(code)));
    bad.send(JSON.stringify({ kind: "pair", label: "Impersonator", proof: token() }));
    assert.equal(await close, 1008);
    assert.equal((await http(relay, owner, "/dev/devices")).body.devices.length, 0);
  } finally { await relay.close(); }
});

test("offline device is not retried and fullscreen failure needs user gesture", async () => {
  const owner = token(), pair = token();
  const relay = await startLocalAgentRelay({ ownerToken: owner, pairingToken: pair, timeoutMs: 30 });
  try {
    const { ws, device } = await pairedPlayer(relay, pair, "Tesla test");
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "command" && message.action === "request_fullscreen") {
        ws.send(JSON.stringify({ kind: "ack", command_id: message.command_id, status: "needs_user_gesture" }));
      }
    });
    const action = await http(relay, owner, "/dev/command", { device_id: device.device_id, action: "request_fullscreen" });
    assert.equal(action.body.status, "needs_user_gesture");
    const noAnswer = await http(relay, owner, "/dev/command", { device_id: device.device_id, action: "get_player_state" });
    assert.equal(noAnswer.body.status, "timeout_uncertain");
    ws.terminate();
    await new Promise(resolve => setTimeout(resolve, 20));
    const gone = await http(relay, owner, "/dev/command", { device_id: device.device_id, action: "pause" });
    assert.equal(gone.body.status, "offline");
  } finally { await relay.close(); }
});
