import test from "node:test";
import assert from "node:assert/strict";

await import("../public/e-auto.js");
const E = globalThis.YtExperimentalAuto;

function frame(seq, jpeg = [0xff, 0xd8, 0xff, 0xd9]) {
  const b = new Uint8Array(48 + jpeg.length); const v = new DataView(b.buffer);
  b.set([0x45, 0x41, 0x4a, 0x46]); v.setUint8(4, 1); v.setUint8(5, 48); v.setUint32(6, 7); v.setUint32(10, seq);
  v.setBigUint64(14, 123456n + BigInt(seq)); v.setBigUint64(22, 1700000000000n + BigInt(seq)); v.setUint32(30, jpeg.length);
  v.setUint16(34, 1500); v.setUint8(36, 7); v.setUint8(37, 2); v.setUint16(38, 854); v.setUint16(40, 480); b.set(jpeg, 48); return b;
}

test("EAJF parser handles split fixed-header frames and metadata", () => {
  const p = new E.EajfParser(); assert.deepEqual(p.push(frame(1).slice(0, 17)), []);
  const [out] = p.push(frame(1).slice(17)); assert.equal(out.sequence, 1); assert.equal(out.fps, 15); assert.equal(out.width, 854); assert.deepEqual([...out.jpeg], [255, 216, 255, 217]);
});

test("EAJF parser resynchronizes and bounds oversized frames", () => {
  const p = new E.EajfParser({ maxFrameBytes: 1024 }); const data = new Uint8Array([1, 2, 3, ...frame(2)]);
  assert.equal(p.push(data).length, 1); assert.equal(p.end().length, 0);
  const bad = frame(3); new DataView(bad.buffer).setUint32(30, 2048); assert.equal(p.push(bad).length, 0); assert.ok(p.errors > 0);
});

test("dual EWMA is independent and conservative", () => {
  const e = new E.DualEwmaEstimator(); e.sample(1000, 1); assert.equal(e.fast.estimate, e.slow.estimate); e.sample(100, 50); assert.equal(e.estimate, Math.min(e.fast.estimate, e.slow.estimate)); e.reset(); assert.equal(e.estimate, null);
});

test("ABR drops quickly on stall and upgrades only after hysteresis", () => {
  let now = 0; const c = new E.MjpegAbrController({ now: () => now, profile: "high", switchCooldownMs: 1000, upgradeStableMs: 2000 });
  assert.equal(c.signal("stall" )?.to, "smooth"); now = 1000; assert.equal(c.observe({ buffer: 5, render: 1 }), null);
  now = 3000; assert.equal(c.observe({ buffer: 5, render: 1 })?.to, "high");
});

test("ABR simulation: low bandwidth and sudden collapse downshift before an empty buffer", () => {
  let now = 0;
  const c = new E.MjpegAbrController({ now: () => now, profile: "high", switchCooldownMs: 1000 });
  const low = c.observe({ buffer: 1.8, bandwidth: 3_900_000, requiredBandwidth: 4_800_000, render: 1 });
  assert.deepEqual({ from: low.from, to: low.to, reason: low.reason }, { from: "high", to: "smooth", reason: "pressure" });
  assert.ok(c.targetBuffer > 2, "pressure should raise the safety buffer");
  now = 1000;
  const collapse = c.observe({ buffer: 1.1, drain: true, bandwidth: 400_000, requiredBandwidth: 2_500_000, render: .92 });
  assert.deepEqual({ from: collapse.from, to: collapse.to, reason: collapse.reason }, { from: "smooth", to: "balanced", reason: "drain" });
});

test("ABR simulation: jitter does not oscillate during cooldown", () => {
  let now = 0;
  const c = new E.MjpegAbrController({ now: () => now, profile: "smooth", switchCooldownMs: 3000, upgradeStableMs: 5000 });
  assert.equal(c.observe({ buffer: 2, bandwidth: 1_000_000, requiredBandwidth: 2_500_000 })?.to, "balanced");
  for (const bandwidth of [4_000_000, 1_200_000, 3_800_000, 900_000]) {
    now += 500;
    assert.equal(c.observe({ buffer: 3.5, bandwidth, requiredBandwidth: 1_800_000, render: .99 }), null);
  }
  assert.equal(c.profile, "balanced");
});

test("ABR simulation: recovery requires sustained headroom and target stays bounded", () => {
  let now = 0;
  const c = new E.MjpegAbrController({ now: () => now, profile: "balanced", switchCooldownMs: 1000, upgradeStableMs: 3000 });
  assert.equal(c.signal("stall")?.to, "low");
  for (let i = 0; i < 10; i++) {
    now += 1000;
    c.signal("stall");
  }
  assert.equal(c.targetBuffer, 5.5);
  const recoveringFrom = c.profile;
  const healthy = { buffer: 5.5, bandwidth: 4_000_000, requiredBandwidth: 1_000_000, render: .99, decode: .01, drop: 0 };
  now += 1000;
  assert.equal(c.observe(healthy), null);
  now += 2999;
  assert.equal(c.observe(healthy), null);
  now += 1;
  const upgrade = c.observe(healthy);
  assert.equal(E.PROFILES.indexOf(upgrade.to), E.PROFILES.indexOf(recoveringFrom) + 1);
  assert.ok(c.targetBuffer >= 1.5 && c.targetBuffer <= 5.5);
});

test("session comparison reports E-Auto deltas", () => {
  const a = new E.SessionMetrics().record("render", 8).record("drop", 2); const b = new E.SessionMetrics().record("render", 9);
  assert.equal(E.compareSessions(a, b).rendered.delta, 1); assert.equal(E.compareSessions(a, b).dropped.delta, -2);
});
