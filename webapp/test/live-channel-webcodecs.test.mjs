import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildCyberdashDashArgs } from "../src/lib/cyberdash-dash.js";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../public/cyberdash-embedded.mjs", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("Browse channels and saved IPTV pass live metadata to the selected WebCodecs engine", () => {
  assert.match(app, /replayFn = \(\) => playStream\(channelStreamSrc\(c\), c\.name, \{/);
  assert.match(app, /isLive: true, seekable: false, liveUrl: c\.url/);
  assert.match(app, /liveUrl: item\.type !== "youtube" && item\.type !== "file" \? item\.url/);
  assert.match(app, /if \(meta\.isLive && meta\.liveUrl && youtubePlaybackMethod === "webcodecs" && !meta\.skipWebcodecs\)/);
  assert.match(app, /fallbackLive: \(\) => playStream\(sources, label, \{ \.\.\.meta, skipWebcodecs: true \}\)/);
});

test("live WebCodecs uses its dedicated server path and retains one A/V source", () => {
  assert.match(client, /live \? "\/api\/experimental\/cyberdash\/live\/start"/);
  assert.match(client, /userAgent: live \? String\(userAgent/);
  assert.match(server, /app\.post\("\/api\/experimental\/cyberdash\/live\/start"/);
  assert.match(server, /videoInput: source\.href,[\s\S]*live: true, playbackRate: 1/);
  assert.match(server, /A remote HTTP\(S\) channel URL is required/);
});

test("live DASH encoder reads live input without VOD readrate and preserves channel headers", () => {
  const live = buildCyberdashDashArgs({
    videoInput: "https://public.example/abc/playlist.m3u8", live: true,
    userAgent: "IPTV test", referer: "https://public.example/",
    manifestPath: "/tmp/stream.mpd", encoder: "libx264",
  });
  assert.equal(live.includes("-readrate"), false);
  assert.equal(live.includes("-readrate_initial_burst"), false);
  assert.deepEqual(live.slice(live.indexOf("-user_agent"), live.indexOf("-i") + 2),
    ["-user_agent", "IPTV test", "-headers", "Referer: https://public.example/\r\n", "-rw_timeout", "15000000", "-i", "https://public.example/abc/playlist.m3u8"]);
  assert.deepEqual(live.slice(live.indexOf("-window_size"), live.indexOf("-remove_at_exit")),
    ["-window_size", "60", "-extra_window_size", "60"]);
  const vod = buildCyberdashDashArgs({videoInput: "/tmp/clip.mp4", live: false, manifestPath: "/tmp/out.mpd"});
  assert.ok(vod.includes("-readrate"));
  assert.deepEqual(vod.slice(vod.indexOf("-window_size"), vod.indexOf("-remove_at_exit")),
    ["-window_size", "0", "-extra_window_size", "0"]);
});

test("live WebCodecs fallback preserves the playback preference and old player remains usable", () => {
  const block = app.slice(app.indexOf("async function playCyberdashStream"), app.indexOf("// Play one synced MPEG-TS"));
  assert.match(block, /if \(meta\.liveUrl && typeof meta\.fallbackLive === "function"\)/);
  assert.match(block, /meta\.fallbackLive\(\)/);
  assert.match(block, /effectiveRate = meta\.liveUrl \? 1 : youtubePlaybackRate/);
  assert.doesNotMatch(block.slice(block.indexOf("if (meta.liveUrl && typeof meta.fallbackLive"), block.indexOf("if (isBlockedWebAudioStartup")), /localStorage\.setItem/);
});

test("MJPEG live audio failure retries independently from video and is cancelable", () => {
  const block = app.slice(app.indexOf("function playCompatStream"), app.indexOf("async function playCyberdashStream"));
  assert.match(block, /let liveAudioRetryCount = 0/);
  assert.match(block, /if \(liveAudioRetryCount >= 3\)/);
  assert.match(block, /activeCompat\.cancelAudioRecovery =/);
  assert.match(block, /if \(meta\.isLive && activeCompat\.playbackStarted\)/);
  assert.match(block, /scheduleLiveAudioRetry\(\)/);
  assert.doesNotMatch(block, /Audio failed, starting video/);
});

test("live WebCodecs startup computes its clock before rendering the first status badge", () => {
  const block = app.slice(app.indexOf("async function playCyberdashStream"), app.indexOf("// Play one synced MPEG-TS"));
  const rateDeclaredAt = block.indexOf("const effectiveRate = meta.liveUrl ? 1 : youtubePlaybackRate");
  const firstBadgeAt = block.indexOf("setBadge(\"reconnecting\", `↻ WebCodecs · ${effectiveRate}×…`)");
  assert.ok(rateDeclaredAt >= 0 && firstBadgeAt > rateDeclaredAt, "clock must be defined before first badge");
});
