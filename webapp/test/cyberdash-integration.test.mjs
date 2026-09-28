import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const embedded = fs.readFileSync(new URL("../public/cyberdash-embedded.mjs", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const dash = fs.readFileSync(new URL("../src/lib/cyberdash-dash.js", import.meta.url), "utf8");

test("WebCodecs lives inside the existing player instead of a standalone page", () => {
  assert.match(html, /id="playbackMethodToggle"/);
  assert.match(html, /data-playback-method="mjpeg"/);
  assert.match(html, /data-playback-method="webcodecs"/);
  assert.match(html, /id="cyberdashCanvas"/);
  assert.equal(fs.existsSync(new URL("../public/cyberdash-player.html", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../public/cyberdash-player.js", import.meta.url)), false);
});

test("requested long YouTube video is prefilled in the normal Paste URL field", () => {
  assert.match(
    html,
    /id="quickUrl"[^>]+value="https:\/\/youtu\.be\/gF3X54sk0hc\?is=WNtys9VQQKxryft4"/
  );
});

test("playback-method choice persists and only sends YouTube VOD to WebCodecs", () => {
  assert.match(app, /const YOUTUBE_PLAYBACK_METHOD_KEY = "ytStreamerYoutubePlaybackMethod"/);
  assert.match(app, /localStorage\.setItem\(YOUTUBE_PLAYBACK_METHOD_KEY, youtubePlaybackMethod\)/);
  assert.match(
    app,
    /if \(youtubeUrl && youtubePlaybackMethod === "webcodecs" && !meta\.isLive\) \{\s*return playCyberdashStream/
  );
});

test("switching methods replays from the current seek position", () => {
  const toggle = app.match(/\$\("#playbackMethodToggle"\)[\s\S]*?\n\}\);\nrenderYoutubePlaybackMethod\(\);/)?.[0] || "";
  assert.match(toggle, /const resumeAt = streamSeek\.seekable \? streamReplayTime\(\) : 0/);
  assert.match(toggle, /replayFn\(resumeAt\)/);
});

test("WebCodecs quick-play retains MJPEG URLs so toggle-back works without a new link", () => {
  const block = app.match(/if \(youtubePlaybackMethod === "webcodecs"\) \{[\s\S]*?return;\n    \}/)?.[0] || "";
  assert.match(block, /mjpegUrl: `\/stream\/youtube\?url=\$\{u\}&\$\{q\}`/);
  assert.match(block, /audioUrl: `\/stream\/audio\/youtube\?url=\$\{u\}&\$\{audioQuery\(startAt\)\}`/);
  assert.match(block, /youtubeUrl: url/);
});

test("existing seek path reaches WebCodecs startAt and ffmpeg input seek", () => {
  assert.match(app, /function seekStreamTo\(time\)[\s\S]*?replayFn\(target\)/);
  assert.match(server, /const requestedStartAt = Math\.max\(0,[\s\S]*body\.startAt/);
  assert.match(server, /const startAt = Number\.isFinite\(duration\)[\s\S]*requestedStartAt/);
  assert.match(server, /startYouTubeDashSession\(\{[\s\S]*startAt,/);
  assert.match(dash, /if \(seek\) args\.push\("-ss", String\(seek\)\)/);
});

test("WebCodecs starts internal AudioContext playback from the user gesture path", () => {
  const playerBlock = app.match(/async function playCyberdashStream[\s\S]*?\n\}\n\n\/\/ Play one synced MPEG-TS/)?.[0] || "";
  assert.doesNotMatch(playerBlock, /audioElement:/);
  assert.doesNotMatch(playerBlock, /audioPlayPromise/);
  assert.match(playerBlock, /const module = cyberdashModule \|\| await ensureCyberdashModule\(\)/);
  const playBody = embedded.match(/async function play\(\{[\s\S]*?\n  \}\n\n  function currentTime/)?.[0] || "";
  assert.match(playBody, /resumePromise = audioCtx\.resume\(\)/);
  assert.ok(playBody.indexOf("resumePromise = audioCtx.resume()") < playBody.indexOf("await stop()"));
});

test("long playback releases ended audio source nodes instead of retaining them forever", () => {
  assert.match(embedded, /audioNodes: new Set\(\)/);
  assert.match(embedded, /node\.onended = \(\) => \{[\s\S]*state\.audioNodes\.delete\(node\)/);
  assert.match(embedded, /state\.audioNodes\.add\(node\)/);
});

test("WebCodecs completion and failure always release browser/server resources", () => {
  assert.match(embedded, /finally \{[\s\S]*if \(state === next\) await stop\(\)/);
  assert.match(embedded, /current\.audioCtx[\s\S]*await current\.audioCtx\.close\(\)/);
  assert.match(embedded, /await stopServerSession\(current\)/);
});


test("WebCodecs uses the shared player controls with adaptive fast-play FPS and a 30fps source cap", () => {
  assert.match(app, /function adaptiveCyberdashFps\(baseFps, playbackRate = youtubePlaybackRate\)/);
  assert.match(app, /const minimumFastFps = rate >= 2 \? 30 : 24/);
  assert.match(app, /return Math\.min\(30, Math\.max\(minimumFastFps, Math\.round\(base \* rate\)\)\)/);
  assert.match(app, /function currentCyberdashSettings\(\)[\s\S]*baseFps[\s\S]*fps: adaptiveCyberdashFps\(baseFps\)/);
  assert.match(app, /height: settings\.height,[\s\S]*fps: settings\.fps/);
});

test("Source height is preserved to the server instead of being silently forced to 720p", () => {
  assert.match(embedded, /height: Number\.isFinite\(Number\(height\)\) \? Number\(height\) : 0/);
  assert.match(server, /const maxHeight = requestedYouTubeMaxHeight\(body\.height\)/);
  assert.doesNotMatch(server, /requestedYouTubeMaxHeight\(body\.height \|\| 720\)/);
});

test("server clamps WebCodecs FPS to 5-30 and seek to the resolved video duration", () => {
  assert.match(server, /const fps = Math\.max\(5, Math\.min\(30,/);
  assert.match(server, /const requestedStartAt = Math\.max\(0,/);
  assert.match(server, /Math\.min\(requestedStartAt, Math\.max\(0, duration - 2\)\)/);
});

test("live pasted YouTube automatically falls back from WebCodecs to MJPEG", () => {
  const startRoute = server.match(/app\.post\("\/api\/experimental\/cyberdash\/start"[\s\S]*?\n\}\)\);/)?.[0] || "";
  assert.match(startRoute, /if \(isLive\)/);
  assert.match(startRoute, /status\(409\)/);
  assert.match(startRoute, /fallback: "mjpeg"/);
  assert.ok(startRoute.indexOf("if (isLive)") < startRoute.indexOf("startYouTubeDashSession"));

  assert.match(embedded, /error\.status = res\.status/);
  assert.match(embedded, /error\.body = body/);
  assert.match(app, /error\?\.body\?\.fallback === "mjpeg"/);
  assert.match(app, /youtubePlaybackMethod = "mjpeg"/);
  assert.match(app, /Live YouTube detected · using MJPEG/);
});

test("switching playback methods while paused restores the paused state", () => {
  const toggle = app.match(/\$\("#playbackMethodToggle"\)[\s\S]*?\n\}\);\nrenderYoutubePlaybackMethod\(\);/)?.[0] || "";
  assert.match(toggle, /const restorePause = playbackPaused/);
  assert.match(toggle, /const beforeAttempt = streamAttempt/);
  assert.match(toggle, /pendingPlaybackMethodRestore = restorePause[\s\S]*minAttempt: beforeAttempt \+ 1[\s\S]*replay: replayFn/);
  assert.match(app, /function maybeRestorePlaybackAfterMethodSwitch\(attempt\)[\s\S]*replayFn !== pending\.replay[\s\S]*requestAnimationFrame[\s\S]*pausePlayback\(\)/);
  assert.match(app, /maybeRestorePlaybackAfterMethodSwitch\(attempt\)/);
});


test("paused method-switch restore is cleared on failure or explicit Stop", () => {
  const fail = app.match(/function failStreamAttempt\(attempt, title, detail\) \{[\s\S]*?\n\}/)?.[0] || "";
  const stop = app.match(/function stopPlayback\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(fail, /pendingPlaybackMethodRestore = null/);
  assert.match(stop, /pendingPlaybackMethodRestore = null/);
});

test("YouTube proxy preserves unknown duration as null", () => {
  const proxy = server.match(/function proxyYouTubeStreams\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(proxy, /const durationValue = resolved\.duration/);
  assert.match(proxy, /durationValue != null && durationValue !== ""/);
  assert.match(proxy, /: null/);
});


test("WebCodecs reports partial telemetry when stopped, sought, or switched", () => {
  assert.match(app, /void stopCyberdashPlayback\(\{ report: true \}\);/);
  assert.match(app, /cleanupMedia\(\);[\s\S]*resetPauseControl\(false\)/);
  assert.match(embedded, /audioLateBlocks: state\.audioLateBlocks/);
  assert.match(embedded, /audioOverlapPrevented: state\.audioOverlapPrevented/);
  assert.match(embedded, /audioContinuityCorrections: state\.audioContinuityCorrections/);
  assert.match(embedded, /maxAudioScheduleSlipMs: round\(state\.maxAudioScheduleSlipMs, 1\)/);
});


test("intentional WebCodecs cancellation is not surfaced as playback failure", () => {
  const playBody = embedded.match(/async function play\(\{[\s\S]*?\n  \}\n\n  function currentTime/)?.[0] || "";
  assert.match(playBody, /if \(next\.stopRequested\) return/);
  const playerBlock = app.match(/async function playCyberdashStream[\s\S]*?\n\}\n\n\/\/ Play one synced MPEG-TS/)?.[0] || "";
  assert.match(playerBlock, /let fatalHandled = false/);
  assert.match(playerBlock, /if \(!fatalHandled\)/);
});

test("WebCodecs speed control offers 1x through 4x and persists the selection", () => {
  assert.match(html, /id="playbackSpeedSelect"/);
  for (const value of ["1", "1.25", "1.5", "2", "3", "4"]) {
    assert.ok(html.includes('option value="' + value + '"'));
  }
  assert.match(app, /const YOUTUBE_PLAYBACK_RATE_KEY = "ytStreamerYoutubePlaybackRate"/);
  assert.match(app, /const YOUTUBE_PLAYBACK_RATES = \[1, 1\.25, 1\.5, 2, 3, 4\]/);
  assert.match(app, /localStorage\.setItem\(YOUTUBE_PLAYBACK_RATE_KEY, String\(youtubePlaybackRate\)\)/);
  assert.match(app, /playbackRate: youtubePlaybackRate/);
});

test("WebCodecs speed uses server tempo audio and a faster video clock", () => {
  assert.match(embedded, /export function normalizePlaybackRate/);
  assert.match(embedded, /wallSeconds \* normalizePlaybackRate\(state\.playbackRate\)/);
  assert.doesNotMatch(embedded, /node\.playbackRate\.value = playbackRate/);
  assert.match(embedded, /Math\.max\(0, item\.timestamp \/ 1e6\);/);
  assert.match(embedded, /duration: item\.buffer\.duration,/);
  assert.match(dash, /"-af", `atempo=\$\{speed\}`/);
});

test("WebCodecs restart preserves user activation by avoiding awaited old-player cleanup", () => {
  const playerBlock = app.match(/async function playCyberdashStream[\s\S]*?\n\}\n\n\/\/ Play one synced MPEG-TS/)?.[0] || "";
  assert.doesNotMatch(playerBlock, /await stopCyberdashPlayback/);
  assert.match(playerBlock, /cleanupMedia\(\)/);
  assert.match(playerBlock, /const module = cyberdashModule \|\| await ensureCyberdashModule\(\)/);
  assert.match(app, /cyberdashModulePromise = import\("\/cyberdash-embedded\.mjs\?v=20260928-speed-v8"\)/);
});

test("WebCodecs playback rate is forwarded to the server and expands source-time buffer headroom", () => {
  assert.match(embedded, /playbackRate: next\.playbackRate/);
  assert.match(embedded, /const sourceLeadLimit = 6\.5 \* playbackRate/);
  assert.match(server, /const playbackRate = Math\.max\(1, Math\.min\(4,/);
  assert.match(server, /startYouTubeDashSession\(\{[\s\S]*playbackRate,/);
  assert.match(dash, /speed > 1[\s\S]*Math\.min\(5, Math\.max\(1\.6, speed \* 1\.6\)\)[\s\S]*: 1\.15/);
});

test("WebCodecs video queue uses long-stall detection instead of a 2.2 second fatal timeout", () => {
  const queueBlock = embedded.match(/async function waitForVideoQueue[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(queueBlock, /2200/);
  assert.match(queueBlock, /10000/);
  assert.match(queueBlock, /Video decoder stopped draining/);
});


test("WebCodecs avoids the fragile HTML audio sidecar at faster speeds", () => {
  const playerBlock = app.match(/async function playCyberdashStream[\s\S]*?\n\}\n\n\/\/ Play one synced MPEG-TS/)?.[0] || "";
  assert.doesNotMatch(playerBlock, /preservesPitch/);
  assert.doesNotMatch(playerBlock, /audioElement:/);
  assert.doesNotMatch(playerBlock, /audioPlayPromise/);
  assert.match(playerBlock, /FFmpeg applies pitch-preserving[\s\S]*atempo/);
  assert.match(embedded, /pitchMode: state\.externalAudioElement \? "browser-preserves-pitch" : "server-atempo"/);
});

test("WebCodecs pause resume and mute use the AudioContext path", () => {
  const pauseBlock = embedded.match(/async function pause\(\)[\s\S]*?\n  \}/)?.[0] || "";
  const resumeBlock = embedded.match(/async function resume\(\)[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(pauseBlock, /state\.audioCtx\.suspend\(\)/);
  assert.match(resumeBlock, /state\.audioCtx\.resume\(\)/);
  const muteHandler = app.match(/\$\("#muteBtn"\)\.onclick = \(\) => \{[\s\S]*?\n\};/)?.[0] || "";
  assert.match(muteHandler, /cyberdashPlayer\.setMuted\(!soundOn\)/);
});

test("WebCodecs source-time buffering scales audio PTS back from server-tempo output time", () => {
  assert.match(embedded, /async function holdIfTooFarAhead\(state, lastPtsSec, kind\)/);
  assert.match(embedded, /const sourcePtsSec = kind === "audio" \? lastPtsSec \* playbackRate : lastPtsSec/);
  assert.match(embedded, /holdIfTooFarAhead\(state, lastPtsSec, kind\)/);
});

test("adaptive WebCodecs FPS raises low MJPEG-style frame rates when playback is faster", () => {
  const fnSource = app.match(/function adaptiveCyberdashFps\(baseFps, playbackRate = youtubePlaybackRate\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(fnSource);
  const adaptiveCyberdashFps = Function("return (" + fnSource + ")")();
  assert.equal(adaptiveCyberdashFps(12, 1), 12);
  assert.equal(adaptiveCyberdashFps(12, 1.5), 24);
  assert.equal(adaptiveCyberdashFps(15, 1.5), 24);
  assert.equal(adaptiveCyberdashFps(24, 1.5), 30);
  assert.equal(adaptiveCyberdashFps(12, 2), 30);
  assert.equal(adaptiveCyberdashFps(30, 4), 30);
});

test("WebCodecs telemetry records the actual requested adaptive FPS", () => {
  assert.match(embedded, /requestedFps: Math\.max\(5, Math\.min\(60, Number\(fps\) \|\| 30\)\)/);
  assert.match(embedded, /fps: state\.requestedFps/);
});


test("fast WebCodecs playback waits for a real startup buffer instead of three frames", () => {
  assert.match(embedded, /fastPlaybackBufferTargets/);
  assert.match(embedded, /const startupWallSec = Math\.min\(4, 1\.5 \+ \(\(rate - 1\) \* 2\.5\)\)/);
  assert.match(embedded, /state\.decodedVideo\.length >= targets\.startupVideoFrames/);
  assert.match(embedded, /videoSourceSec >= targets\.startupVideoSourceSec/);
  assert.match(embedded, /audioWallSec >= targets\.startupAudioWallSec/);
  assert.match(embedded, /startupVideoBufferSec = decodedVideoAheadSec/);
  assert.match(embedded, /startupAudioBufferSec = state\.externalAudioElement \? null : pendingAudioBufferedSec/);
});

test("fast WebCodecs playback re-buffers by freezing and resuming the unlocked AudioContext", () => {
  const renderBlock = embedded.match(/function startRenderLoop\(state\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(renderBlock, /state\.rebufferCount\+\+/);
  assert.match(renderBlock, /state\.audioCtx\.suspend\(\)/);
  assert.match(renderBlock, /state\.audioCtx\.resume\(\)/);
  assert.match(renderBlock, /videoAhead < lowVideoSourceSec \|\| audioAhead < targets\.rebufferLowWallSec/);
  assert.match(renderBlock, /targets\.rebufferHighVideoSourceSec/);
  assert.match(renderBlock, /targets\.rebufferHighWallSec/);
});

test("main player shows WebCodecs buffering state while fast playback refills", () => {
  const playerBlock = app.match(/async function playCyberdashStream[\s\S]*?\n\}\n\n\/\/ Play one synced MPEG-TS/)?.[0] || "";
  assert.match(playerBlock, /onStatus\(status, detail = \{\}\)/);
  assert.match(playerBlock, /status === "buffering"/);
  assert.match(playerBlock, /Rebuffering/);
  assert.match(playerBlock, /status === "playing"/);
});

test("WebCodecs summary records startup buffer and rebuffer telemetry", () => {
  assert.match(embedded, /rebufferCount: state\.rebufferCount/);
  assert.match(embedded, /startupVideoBufferSec: round\(state\.startupVideoBufferSec, 2\)/);
  assert.match(embedded, /startupAudioBufferSec: round\(state\.startupAudioBufferSec, 2\)/);
  assert.match(embedded, /rebufferMs: round\(state\.rebufferMs, 1\)/);
  assert.match(embedded, /maxRebufferMs: round\(state\.maxRebufferMs, 1\)/);
});


test("fast WebCodecs playback uses larger producer margin and deeper refill targets", () => {
  assert.match(dash, /speed > 1[\s\S]*speed \* 1\.6/);
  assert.match(dash, /speed \* 5/);
  assert.match(embedded, /rebufferLowWallSec: 0\.65/);
  assert.match(embedded, /const rebufferHighWallSec = Math\.min\(3, 1\.5 \+ \(rate - 1\)\)/);
});
