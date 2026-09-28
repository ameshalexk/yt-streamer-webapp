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
  assert.match(server, /const startAt = Math\.max\(0,[\s\S]*body\.startAt/);
  assert.match(server, /startYouTubeDashSession\(\{[\s\S]*startAt,/);
  assert.match(dash, /if \(seek\) args\.push\("-ss", String\(seek\)\)/);
});

test("WebCodecs captures AudioContext resume before awaiting old-player cleanup", () => {
  const playBody = embedded.match(/async function play\(\{[\s\S]*?\n  \}\n\n  function currentTime/)?.[0] || "";
  const resumeIndex = playBody.indexOf("const resumePromise = audioCtx.resume()");
  const stopIndex = playBody.indexOf("await stop()");
  assert.ok(resumeIndex >= 0);
  assert.ok(stopIndex >= 0);
  assert.ok(resumeIndex < stopIndex);
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
