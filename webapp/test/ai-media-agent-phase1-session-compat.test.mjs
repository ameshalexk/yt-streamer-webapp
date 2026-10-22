import test from "node:test";
import assert from "node:assert/strict";
import { AgentSessionRegistry, validateMediaCommand } from "../src/lib/ai-media-agent-session-registry.js";

function fixture(options = {}) {
  let now = 1000; const sent = [];
  const registry = new AgentSessionRegistry({ now: () => now, ttlMs: 30, timeoutMs: 20, authorizePairing: ({ principal, pairingProof }) => principal === "owner" && pairingProof === "pair", ...options });
  const device = registry.register({ principal: "owner", pairingProof: "pair", label: "tab A", connectionId: "conn-a", send: (message) => { sent.push(message); return true; } }).device_id;
  return { registry, device, sent, advance: (ms) => { now += ms; } };
}

test("selected device receives exact command and observed state is returned", async () => {
  const x = fixture(); const waiting = x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "pause", commandId: "cmd-1" });
  assert.equal(x.sent[0].device_id, x.device); assert.equal(x.sent[0].command_id, "cmd-1");
  assert.equal(x.registry.acknowledge({ principal: "owner", deviceId: x.device, connectionId: "conn-a", commandId: "cmd-1", status: "completed", state: { paused: true, playback_phase: "paused", secret: "drop" } }), true);
  assert.deepEqual((await waiting).state, { paused: true, playback_phase: "paused" });
});

test("duplicate, wrong target, and stale target are rejected", async () => {
  const x = fixture(); const first = x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "same" });
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "same" })).status, "duplicate_command_id");
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: "wrong", action: "stop", commandId: "other" })).status, "offline");
  x.registry.acknowledge({ principal: "owner", deviceId: x.device, connectionId: "conn-a", commandId: "same", status: "completed" }); await first;
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "same" })).status, "duplicate_command_id");
  x.advance(31); assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "stale" })).status, "offline");
});

test("command schema is bounded to media actions", () => {
  assert.deepEqual(validateMediaCommand("play_media", { media_id: "abc" }), { media_id: "abc" });
  assert.throws(() => validateMediaCommand("play_media", { url: "https://example.com" }), /unknown_argument/);
  assert.throws(() => validateMediaCommand("open_url", { url: "https://example.com" }), /invalid_action/);
});

test("invalid observed phases are rejected and timeout IDs cannot be replayed", async () => {
  const x = fixture({ timeoutMs: 1, commandTtlMs: 50 });
  const waiting = x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "timeout-id" });
  assert.equal((await waiting).status, "timeout_uncertain");
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "timeout-id" })).status, "duplicate_command_id");
  const other = x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "pause", commandId: "phase-id" });
  assert.equal(x.registry.acknowledge({ principal: "owner", deviceId: x.device, connectionId: "conn-a", commandId: "phase-id", status: "completed", state: { playback_phase: "made-up" } }), false);
  x.registry.disconnect({ deviceId: x.device, connectionId: "conn-a" });
  assert.equal((await other).status, "offline");
});

test("pending commands are bounded per selected device", async () => {
  const x = fixture({ maxPending: 1, timeoutMs: 30 });
  const first = x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "one" });
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "two" })).status, "busy");
  x.registry.disconnect({ deviceId: x.device, connectionId: "conn-a" });
  assert.equal((await first).status, "offline");
});

test("completed command IDs stay replay-protected when the retained history is full", async () => {
  const x = fixture({ maxCompleted: 1 });
  const first = x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "retained" });
  x.registry.acknowledge({ principal: "owner", deviceId: x.device, connectionId: "conn-a", commandId: "retained", status: "completed" });
  await first;
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "retained" })).status, "duplicate_command_id");
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: x.device, action: "stop", commandId: "new" })).status, "busy");
});

test("paired browser session count is bounded", () => {
  const x = fixture({ maxSessions: 1 });
  assert.throws(() => x.registry.register({ principal: "owner", pairingProof: "pair", label: "tab B", connectionId: "conn-b", send: () => true }), /session_limit/);
});
