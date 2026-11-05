import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} exists`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function extractCancelCallback() {
  const marker = "activeCompat.cancelAudioRecovery = () => {";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "cancel callback exists");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("Could not extract cancel callback");
}

test("Pause or hidden hold cancels an in-flight repair and Resume requests a fresh audio attempt", async () => {
  let rejectRepair;
  let canceledTimers = 0;
  const events = [];
  const activeCompat = { bufferedPlayer: {}, buffered: true, audioUrl: "/audio", audioStatus: "retrying" };
  const context = vm.createContext({
    activeCompat,
    audioRepairActive: true,
    audioFailed: false,
    cancelAudioTimers: () => { canceledTimers += 1; },
    updateActivePlaybackStatus() {},
    settleAudioRepair(error) { rejectRepair?.(error); },
    soundOn: true,
    playbackPaused: false,
    document: { hidden: false },
    playbackRecoverySample: () => ({ key: "source", replay: () => {}, audioStatus: activeCompat.audioStatus }),
    playbackRecovery: { request: (...args) => { events.push(args); return true; } },
  });
  vm.runInContext(`${extractCancelCallback()};`, context);
  vm.runInContext(`${extractFunction("suspendBufferedAudioRepairForHold")};`, context);
  vm.runInContext(`${extractFunction("resumeSilentBufferedAudioRepair")};`, context);

  const repair = new Promise((_, reject) => { rejectRepair = reject; });
  const canceled = context.suspendBufferedAudioRepairForHold();
  assert.equal(canceled, true);
  assert.equal(activeCompat.audioStatus, "silent");
  assert.equal(context.audioRepairActive, false);
  assert.equal(canceledTimers, 1);
  await assert.rejects(repair, { name: "AbortError" });

  assert.equal(context.resumeSilentBufferedAudioRepair(), true);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "audio");
  assert.equal(events[0][1].started, true);
  assert.equal(events[0][1].audioError, true);
  assert.notEqual(activeCompat.audioStatus, "retrying");

  context.document.hidden = true;
  assert.equal(context.resumeSilentBufferedAudioRepair(), false);
  context.document.hidden = false;
  context.playbackPaused = true;
  assert.equal(context.resumeSilentBufferedAudioRepair(), false);
});

test("a queued retry with no local promise is suspended to silent and resumed as audio only", () => {
  const activeCompat = { bufferedPlayer: {}, buffered: true, audioStatus: "retrying" };
  let updates = 0;
  const context = vm.createContext({ activeCompat,
    updateActivePlaybackStatus: () => { updates += 1; },
  });
  vm.runInContext(`${extractFunction("suspendBufferedAudioRepairForHold")};`, context);
  assert.equal(context.suspendBufferedAudioRepairForHold(), true);
  assert.equal(activeCompat.audioStatus, "silent");
  assert.equal(updates, 1);
});

test("Pause and visibility handlers use the cancellation and resume paths", () => {
  const pauseStart = source.indexOf("function pausePlayback()");
  const pauseEnd = source.indexOf("\nasync function resumePlayback", pauseStart);
  const resumeStart = source.indexOf("async function resumePlayback()");
  const resumeEnd = source.indexOf("\nfunction suspendBufferedAudioRepairForHold", resumeStart);
  const visibilityStart = source.indexOf('document.addEventListener("visibilitychange"');
  const visibilityEnd = source.indexOf("\n  setInterval(() => { void watchProgress.save();", visibilityStart);
  const interruptedStart = source.indexOf("function resumeInterruptedRecovery()");
  const interruptedEnd = source.indexOf("\n  window.addEventListener(\"online\"", interruptedStart);
  assert.match(source.slice(pauseStart, pauseEnd), /playbackRecovery\?\.hold\(\);[\s\S]*?suspendBufferedAudioRepairForHold\(\)/);
  assert.match(source.slice(resumeStart, resumeEnd), /resumeSilentBufferedAudioRepair\(\)/);
  assert.match(source.slice(visibilityStart, visibilityEnd), /suspendBufferedAudioRepairForHold\(\)/);
  assert.match(source.slice(interruptedStart, interruptedEnd), /suspendBufferedAudioRepairForHold\(\)/);
  assert.match(source.slice(interruptedStart, interruptedEnd), /resumeSilentBufferedAudioRepair\(\)/);
});
