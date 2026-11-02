import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function extractFunction(source, name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function makeFullscreenHarness({ native = false, requestFullscreen, realTimers = false } = {}) {
  const screen = { classList: { toggle() {} }, requestFullscreen };
  const notice = { hidden: true, _hideTimer: null };
  const listeners = new Map();
  const document = {
    fullscreenElement: native ? screen : null,
    body: { classList: { toggle() {} } },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); },
  };
  const context = vm.createContext({
    document,
    $: (selector) => selector === "#screen" ? screen : selector === "#fullscreenFallbackNotice" ? notice : null,
    fullscreenElement: () => document.fullscreenElement,
    syntheticFullscreen: false,
    fullscreenRequestSerial: 0,
    fullscreenExitRequested: false,
    setSyntheticFullscreen(enabled) { context.syntheticFullscreen = enabled; },
    updateFullscreenButton() {},
    clearTimeout: realTimers ? clearTimeout : () => {},
    setTimeout: realTimers ? setTimeout : (fn) => { context.hideNotice = fn; return 1; },
  });
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const name of ["hideFullscreenFallbackNotice", "handleObservedFullscreenChange", "enterScreenFullscreen", "exitScreenFullscreen"]) {
    vm.runInContext(extractFunction(app, name), context);
  }
  return { context, document, screen, notice };
}

test("periodic buffered stats do not keep waking fullscreen controls", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /markBufferedStreamPlaying\(attempt, stats, \{ revealControls: false \}\)/);
  assert.match(app, /if \(revealControls\) showFullscreenOverlays\(\{ withProgress: false \}\)/);
});

test("one shared player owns seek/pause and persistent in-player quality access", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const overlay = html.match(/<div class="video-controls-overlay"[\s\S]*?<div class="screen-empty"/)?.[0] || "";
  assert.match(overlay, /id="pauseBtn"/);
  assert.match(overlay, /id="muteBtn"/);
  assert.match(overlay, /id="fullscreenBtn"/);
  assert.match(overlay, /id="streamSeek"/);
  assert.match(overlay, /id="liveSeekStatus"/);
  assert.match(html, /id="playerQualityBtn"[^>]*aria-expanded="false"[^>]*aria-controls="playerQualityPanel"/);
  assert.match(html, /id="playerQualitySlot"[^>]*data-v2-story="quality-presets"/);
  assert.match(html, /id="playerQualityPresets"/);
  assert.doesNotMatch(overlay, /id="playerQualitySlot"/);
  assert.match(html, /id="playerQualityPanel"[^>]*hidden/);
  for (const id of ["pauseBtn", "muteBtn", "fullscreenBtn", "streamSeek"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must have one shared instance`);
  }
});

test("idle player overlay becomes invisible and non-interactive", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /body\.fullscreen-controls-idle \.video-controls-overlay \{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.video-control-btn \{[^}]*min-height:\s*52px;/s);
  const mobileCss = fs.readFileSync(new URL("../public/mobile-player-fixes.css", import.meta.url), "utf8");
  assert.match(mobileCss, /\.screen > \.player-quality-trigger/);
  assert.match(mobileCss, /body\.screen-fullscreen\.fullscreen-controls-idle \.screen > \.player-quality-trigger \{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
  assert.match(mobileCss, /\.screen > \.player-quality-trigger \{[^}]*min-height:\s*44px;/s);
  assert.match(mobileCss, /\.screen:not\(\.playing\) > \.player-quality-trigger/);
  assert.match(mobileCss, /\.player-quality-panel \.player-quality-btn \{[^}]*min-height:\s*46px;/s);
  assert.match(mobileCss, /@media \(max-width: 520px\)[\s\S]*\.player-quality-panel \.player-quality-presets/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.stream-badge \{[^}]*top:\s*8px;[^}]*bottom:\s*auto;/s);
});

test("auto-hide is limited to uninterrupted playback", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /FULLSCREEN_OVERLAY_HIDE_MS = 5000/);
  assert.match(app, /!screen\.classList\.contains\("loading"\)/);
  assert.match(app, /!screen\.classList\.contains\("controls-interacting"\)/);
  assert.match(app, /!playbackPaused/);
  assert.match(app, /!noticeVisible/);
  assert.match(app, /active\.matches\(\":focus-visible\"\)[\s\S]*catch \{ return fullscreenKeyboardModality; \}/);
  assert.match(app, /screen\.addEventListener\("focusin", \(\) => showFullscreenOverlays\(\)\)/);
});

test("a tap from the hidden state reveals controls without toggling playback", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /fullscreenTapRevealOnly = canAutoHideScreenOverlays\(\)[\s\S]*document\.body\.classList\.contains\("fullscreen-controls-idle"\)/);
  assert.match(app, /if \(fullscreenTapRevealOnly\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*return;[\s\S]*\}/);
});

test("fullscreen requests hidden browser chrome and reports in-page fallback honestly", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(app, /requestFullscreen\(\{ navigationUI: "hide" \}\)/);
  assert.match(app, /if \(fullscreenElement\(\) !== screen\) await observed/);
  assert.match(app, /syntheticFullscreen \? "Exit expanded player" : "Exit full screen"/);
  assert.match(app, /setSyntheticFullscreen\(true\);\s*announceFallback\(\)/);
  assert.match(app, /kind:\(\)=>isScreenFullscreen\(\)\?\(syntheticFullscreen\?'in_page':'native'\)/);
  assert.match(html, /id="fullscreenFallbackNotice" role="status" aria-live="polite" hidden/);
  assert.match(css, /body\.screen-fullscreen\.fullscreen-controls-idle \.browser-close-popup \{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
  assert.match(css, /body\.screen-fullscreen #aiMediaProductionPanel,[\s\S]*#aiMediaProductionReopen \{ display: none !important; \}/);
});

test("native fullscreen success is requested with hidden navigation UI and stays native", async () => {
  let options;
  const harness = makeFullscreenHarness({ requestFullscreen: async (value) => {
    options = value;
    harness.document.fullscreenElement = harness.screen;
  } });
  await vm.runInContext("enterScreenFullscreen()", harness.context);
  assert.equal(options?.navigationUI, "hide");
  assert.equal(harness.context.syntheticFullscreen, false);
  assert.equal(harness.notice.hidden, true);
});

test("rejected native fullscreen falls back without retrying after activation may be consumed", async () => {
  let calls = 0;
  const harness = makeFullscreenHarness({ requestFullscreen: async () => {
    calls += 1;
    throw new TypeError("fullscreen denied");
  } });
  await vm.runInContext("enterScreenFullscreen()", harness.context);
  assert.equal(calls, 1);
  assert.equal(harness.context.syntheticFullscreen, true);
  assert.equal(harness.notice.hidden, false);
});

test("missing native API and silent native no-op both produce an honest expanded-player fallback", async () => {
  const unsupported = makeFullscreenHarness();
  await vm.runInContext("enterScreenFullscreen()", unsupported.context);
  assert.equal(unsupported.context.syntheticFullscreen, true);
  assert.equal(unsupported.notice.hidden, false);

  const noOp = makeFullscreenHarness({ requestFullscreen: async () => {} });
  await vm.runInContext("enterScreenFullscreen()", noOp.context);
  assert.equal(noOp.document.fullscreenElement, null);
  assert.equal(noOp.context.syntheticFullscreen, true);
  assert.equal(noOp.notice.hidden, false);
});

test("legacy webkit fullscreen waits briefly for an observed fullscreen event", async () => {
  const harness = makeFullscreenHarness();
  harness.screen.webkitRequestFullscreen = () => {
    harness.document.fullscreenElement = harness.screen;
    harness.document.dispatch("webkitfullscreenchange");
  };
  await vm.runInContext("enterScreenFullscreen()", harness.context);
  assert.equal(harness.context.syntheticFullscreen, false);
  assert.equal(harness.notice.hidden, true);
});

test("late webkit fullscreen after fallback exit is immediately exited and its notice stays hidden", async () => {
  const harness = makeFullscreenHarness({ realTimers: true });
  let exitCalls = 0;
  harness.document.exitFullscreen = () => {
    exitCalls += 1;
    harness.document.fullscreenElement = null;
    harness.context.handleObservedFullscreenChange();
    return Promise.resolve();
  };
  harness.screen.webkitRequestFullscreen = () => {
    setTimeout(() => {
      harness.document.fullscreenElement = harness.screen;
      harness.context.handleObservedFullscreenChange();
    }, 350);
  };
  await vm.runInContext("enterScreenFullscreen()", harness.context);
  assert.equal(harness.context.syntheticFullscreen, true, "300ms timeout exposes fallback while native request is pending");
  assert.equal(harness.notice.hidden, false);
  await vm.runInContext("exitScreenFullscreen()", harness.context);
  assert.equal(harness.context.fullscreenExitRequested, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exitCalls, 1, "the late native entry is exited for the screen request canceled by the user");
  assert.equal(harness.document.fullscreenElement, null);
  assert.equal(harness.notice.hidden, true);
  assert.equal(harness.context.syntheticFullscreen, false);
});

test("late fullscreen on an unrelated element does not trigger an exit", () => {
  const harness = makeFullscreenHarness();
  let exitCalls = 0;
  harness.document.exitFullscreen = () => { exitCalls += 1; };
  harness.document.fullscreenElement = { id: "aura-or-other-player" };
  harness.context.fullscreenExitRequested = true;
  vm.runInContext("handleObservedFullscreenChange()", harness.context);
  assert.equal(exitCalls, 0);
  assert.equal(harness.context.fullscreenExitRequested, true);
});

test("exit intent cancels a pending native rejection without reopening the fallback", async () => {
  let reject;
  const harness = makeFullscreenHarness({requestFullscreen: () => new Promise((_, no) => { reject = no; })});
  const entering = vm.runInContext("enterScreenFullscreen()", harness.context);
  await vm.runInContext("exitScreenFullscreen()", harness.context);
  reject(new TypeError("denied after exit"));
  await entering;
  assert.equal(harness.context.syntheticFullscreen, false);
  assert.equal(harness.notice.hidden, true);
});

test("an observed native entry clears a preceding fallback announcement", () => {
  const harness = makeFullscreenHarness();
  harness.context.syntheticFullscreen = true;
  harness.notice.hidden = false;
  harness.document.fullscreenElement = harness.screen;
  vm.runInContext("handleObservedFullscreenChange()", harness.context);
  assert.equal(harness.notice.hidden, true);
  assert.equal(harness.context.syntheticFullscreen, false);
});
