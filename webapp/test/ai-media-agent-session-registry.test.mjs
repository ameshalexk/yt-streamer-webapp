import test from "node:test";
import assert from "node:assert/strict";
import { AgentSessionRegistry, validateMediaCommand } from "../src/lib/ai-media-agent-session-registry.js";

const make = (opts = {}) => {
  let now = 1000;
  const sent = [];
  const registry = new AgentSessionRegistry({
    now: () => now, authorizePairing: ({ principal, pairingProof }) => principal === "owner" && pairingProof === "one-time-paired",
    ...opts,
  });
  const register = (label = "Test Tesla", connectionId = "tab-A") => registry.register({
    principal: "owner", pairingProof: "one-time-paired", label, connectionId,
    send: (message) => { sent.push(message); return true; },
  });
  return { registry, register, sent, advance: (ms) => { now += ms; } };
};

test("denies unverified pairing, invalid principal and unknown device", async () => {
  const x = make();
  assert.throws(() => x.registry.register({
    principal: "owner", pairingProof: "bad", label: "Tesla",
    connectionId: "tab-X", send: () => true,
  }), /unauthorized_pairing/);
  const { device_id } = x.register();
  assert.equal(x.registry.list("other").length, 0);
  assert.equal((await x.registry.dispatch({ principal: "other", deviceId: device_id, action: "pause" })).status, "offline");
  assert.equal(x.sent.length, 0);
});

test("dispatch only to explicitly selected tab and ACK with state", async () => {
  const x = make();
  const a = x.register("Tesla", "tab-A").device_id;
  const b = x.register("Phone", "tab-B").device_id;
  const resultPromise = x.registry.dispatch({ principal: "owner", deviceId: b, action: "pause" });
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].device_id, b);
  assert.notEqual(a, b);
  assert.equal(x.registry.acknowledge({
    principal: "owner", deviceId: b, connectionId: "tab-B",
    commandId: x.sent[0].command_id, status: "completed",
    state: { paused: true, position_seconds: 42, title: "Mock song", mode: "mjpeg" },
  }), true);
  assert.deepEqual((await resultPromise).state, { paused: true, position_seconds: 42, title: "Mock song", mode: "mjpeg" });
  assert.equal(x.registry.list("owner").find(v => v.device_id === b).state.paused, true);
});

test("wrong tab, wrong principal, forged ACK and duplicate ACK are rejected", async () => {
  const x = make();
  const a = x.register().device_id;
  const resultPromise = x.registry.dispatch({ principal: "owner", deviceId: a, action: "resume" });
  const commandId = x.sent[0].command_id;
  const ack = (principal, connectionId) => x.registry.acknowledge({
    principal, deviceId: a, connectionId, commandId, status: "completed",
  });
  assert.equal(ack("attacker", "tab-A"), false);
  assert.equal(ack("owner", "other-tab"), false);
  assert.equal(ack("owner", "tab-A"), true);
  assert.equal(ack("owner", "tab-A"), false);
  assert.equal((await resultPromise).status, "completed");
});

test("expired tab goes offline without dispatch", async () => {
  const x = make({ ttlMs: 30 });
  const a = x.register().device_id;
  x.advance(31);
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: a, action: "pause" })).status, "offline");
  assert.equal(x.registry.list("owner").length, 0);
  assert.equal(x.sent.length, 0);
});

test("heartbeat updates observed state but cannot revive expired/wrong tab", () => {
  const x = make({ ttlMs: 30 });
  const a = x.register().device_id;
  assert.equal(x.registry.heartbeat({ principal: "owner", deviceId: a, connectionId: "intruder" }), false);
  assert.equal(x.registry.heartbeat({ principal: "owner", deviceId: a, connectionId: "tab-A", state: { paused: false, secret: "must drop" } }), true);
  assert.equal(x.registry.list("owner")[0].state.secret, undefined);
  x.advance(31);
  assert.equal(x.registry.heartbeat({ principal: "owner", deviceId: a, connectionId: "tab-A" }), false);
});

test("timeout is uncertain, does not replay or invent success", async () => {
  const x = make({ timeoutMs: 14 });
  const a = x.register().device_id;
  const outcome = await x.registry.dispatch({ principal: "owner", deviceId: a, action: "pause" });
  assert.equal(outcome.status, "timeout_uncertain");
  assert.equal(x.sent.length, 1);
  assert.equal(x.registry.acknowledge({
    principal: "owner", deviceId: a, connectionId: "tab-A",
    commandId: x.sent[0].command_id, status: "completed",
  }), false);
});

test("disconnect cancels in-flight command; stale connection cannot disconnect a new one", async () => {
  const x = make();
  const a = x.register().device_id;
  const waiting = x.registry.dispatch({ principal: "owner", deviceId: a, action: "next" });
  assert.equal(x.registry.disconnect({ deviceId: a, connectionId: "stale" }), false);
  assert.equal(x.registry.disconnect({ deviceId: a, connectionId: "tab-A" }), true);
  assert.equal((await waiting).status, "offline");
});

test("strict input schema rejects arbitrary URLs, OS or script execution", () => {
  for (const [action, args] of [
    ["open_url", { url: "https://other.site" }],
    ["play_media", { media_id: "valid", javascript: "alert(1)" }],
    ["play_media", { media_id: "" }],
    ["seek", { position_seconds: -1 }],
    ["seek", { position_seconds: "ten" }],
    ["set_volume", { value_percent: 130 }],
    ["pause", { media_id: "ignored" }],
    ["pause", ["bad"]],
  ]) assert.throws(() => validateMediaCommand(action, args));
  assert.deepEqual(validateMediaCommand("play_media", { media_id: "yt-vid-123" }), { media_id: "yt-vid-123" });
});

test("rate limit and in-flight cap prevent flooding", async () => {
  const x = make({ rateLimit: 2, maxPending: 1, timeoutMs: 25 });
  const a = x.register().device_id;
  const first = x.registry.dispatch({ principal: "owner", deviceId: a, action: "pause" });
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: a, action: "pause" })).status, "busy");
  x.registry.acknowledge({ principal: "owner", deviceId: a, connectionId: "tab-A",
    commandId: x.sent[0].command_id, status: "completed" });
  await first;
  const second = x.registry.dispatch({ principal: "owner", deviceId: a, action: "pause" });
  x.registry.acknowledge({ principal: "owner", deviceId: a, connectionId: "tab-A",
    commandId: x.sent[1].command_id, status: "completed" });
  await second;
  assert.equal((await x.registry.dispatch({ principal: "owner", deviceId: a, action: "pause" })).status, "rate_limited");
});

test("browser permission failure is explicitly surfaced", async () => {
  const x = make();
  const a = x.register().device_id;
  const wait = x.registry.dispatch({ principal: "owner", deviceId: a, action: "request_fullscreen" });
  x.registry.acknowledge({ principal: "owner", deviceId: a, connectionId: "tab-A",
    commandId: x.sent[0].command_id, status: "needs_user_gesture", error: "tap fullscreen in car" });
  const result = await wait;
  assert.equal(result.status, "needs_user_gesture");
  assert.match(result.error, /tap/);
});

test("ACK readback retains observed playback phase and bounded AV evidence", async () => {
  const x = make();
  const device = x.register("Chrome playback", "tab-c").device_id;
  const waiting = x.registry.dispatch({ principal: "owner", deviceId: device, action: "play_media",
    args: {media_id:"aqz-KE-bpKQ"} });
  const ack = x.registry.acknowledge({
    principal: "owner", deviceId: device, connectionId: "tab-c",
    commandId: x.sent[0].command_id, status: "buffering",
    state: {mode:"buffered_mjpeg", playback_phase:"buffering", audio_observation:"element_buffering",
      rendered_frames:0, paused:false, av_drift_ms:93, secret:"DROP", position_seconds:0},
  });
  assert.equal(ack,true);
  const result=await waiting;
  assert.equal(result.status,"buffering");
  assert.equal(result.state.playback_phase,"buffering");
  assert.equal(result.state.audio_observation,"element_buffering");
  assert.equal(result.state.av_drift_ms,93);
  assert.equal(result.state.secret,undefined);
  const w=x.registry.dispatch({principal:"owner",deviceId:device,action:"get_player_state"});
  x.registry.acknowledge({principal:"owner",deviceId:device,connectionId:"tab-c",
    commandId:x.sent[1].command_id,status:"completed",
    state:{mode:"buffered_mjpeg",playback_phase:"playing",rendered_frames:17,
      audio_observation:"element_playing_output_unverified",av_drift_ms:-65}});
  assert.equal((await w).state.playback_phase,"playing");
  assert.equal(x.registry.list("owner")[0].state.rendered_frames,17);
});
