import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const arbitration = app.slice(app.indexOf("function adaptiveQualityAllowed"), app.indexOf("function requestQualityProfile"));
const lifecycle = app.slice(app.indexOf("function cancelAutoQualityTransition"), app.indexOf("let autoplayEnabled"));

function fixture() {
  const calls = [];
  const callbacks = new Map();
  const replay = () => {};
  const context = vm.createContext({
    replayFn: replay, streamAttempt: 4, streamSeek: { seekable: true }, soundOn: true, activeCompat: null,
    activeYoutubeSourceUrl: "https://www.youtube.com/watch?v=fixture",
    playbackPaused: false, pendingQualityRestore: null, queuedAutoQuality: null, qualitySwitchTimer: null,
    qualitySwitchGeneration: 0, diagnosticsQualityReason: null, document: { hidden: false },
    navigator: { onLine: true }, performance: { now: () => 5000 }, awaitingRecoveredFrame: null,
    STREAM_QUALITY_PROFILES: { low: { id: "low" }, medium: { id: "medium" }, high: { id: "high" } },
    streamQualitySelection: "auto", AUTO_STREAM_QUALITY_ID: "auto",
    autoQualityController: {
      cancelSwitch: d => calls.push(["cancel", d.to]),
      rejectSwitch: d => calls.push(["reject", d.to]),
      getTelemetry: () => ({ adaptiveTier: "medium" }),
    },
    playbackRecovery: { isVideoRecoveryPending: () => context.videoRecoveryPending },
    qualityProfilesAvailableForCurrentMode: () => true, isStreamAtEnd: () => false,
    currentAttempt: n => n === context.streamAttempt, qualitySwitchResumeAt: () => context.position,
    applyQualityProfileSettings: tier => (calls.push(["apply", tier]), true),
    reportPlaybackEvent: (name, event) => calls.push([name, event]),
    autoQualityReasonLabel: reason => reason,
    performQualityProfileSwitch: plan => calls.push(["replay", plan.resumeAt]),
    setTimeout: fn => { const id = Symbol(); callbacks.set(id, fn); return id; },
    clearTimeout: id => callbacks.delete(id),
  });
  context.position = 10;
  vm.runInContext(lifecycle + arbitration, context);
  return { context, calls, run: () => { for (const [id, fn] of callbacks) { callbacks.delete(id); fn(); } } };
}

const decision = { action: "switch", from: "medium", to: "high", reason: "stable-headroom" };
const stats = { transport: "webcodecs", state: "playing" };

test("a deferred switch uses the latest position and cannot be replaced by a second decision", () => {
  const f = fixture();
  assert.equal(f.context.requestAutoQualityTier(decision, stats), true);
  assert.equal(f.context.adaptiveQualityAllowed(stats), false);
  f.context.position = 10.2;
  f.run();
  assert.deepEqual(f.calls.filter(([kind]) => kind !== "auto_quality_switch"), [["apply", "high"], ["replay", 10.2]]);
  assert.equal(f.calls.find(([kind]) => kind === "auto_quality_switch")?.[1].streamUrl, f.context.activeYoutubeSourceUrl);
});

test("a seek, pause, offline transition or pending video recovery prevents a queued quality replay", () => {
  for (const interrupt of [
    c => { c.streamAttempt++; }, c => { c.playbackPaused = true; },
    c => { c.navigator.onLine = false; }, c => { c.document.hidden = true; },
    c => { c.videoRecoveryPending = true; }, c => c.cancelAutoQualityTransition(),
  ]) {
    const f = fixture();
    assert.equal(f.context.requestAutoQualityTier(decision, stats), true);
    interrupt(f.context);
    f.run();
    assert.deepEqual(f.calls, [["cancel", "high"]]);
  }
});

test("only a current replacement can finish a switch, and a failed target restores its previous tier", () => {
  const f = fixture();
  f.context.pendingQualityRestore = { adaptive: true, replay: f.context.replayFn,
    minAttempt: 5, startedAt: 3500, decision };
  f.context.finishAutoQualityTransition("playing", 4);
  assert.equal(f.calls.length, 0);
  assert.ok(f.context.pendingQualityRestore);
  f.context.finishAutoQualityTransition("failed");
  assert.equal(f.context.pendingQualityRestore, null);
  assert.equal(f.calls[0][0], "auto_quality_transition");
  assert.deepEqual(f.calls.slice(1), [["reject", "high"], ["apply", "medium"]]);
});
