import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import { config } from "../src/config.js";
import { buildCyberdashDashArgs, parseDashManifest } from "../src/lib/cyberdash-dash.js";

test("CyberDash DASH args use configured H.264, AAC, fMP4 DASH, and separate audio mapping", () => {
  const manifestPath = path.join("/tmp", "session", "manifest.mpd");
  const args = buildCyberdashDashArgs({
    videoInput: "http://127.0.0.1/video",
    audioInput: "http://127.0.0.1/audio",
    height: 720,
    fps: 30,
    manifestPath,
  });
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "0:v:0", "-map", "1:a:0"]);
  assert.equal(args[args.indexOf("-c:v") + 1], config.video.dashEncoder);
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-f") + 1], "dash");
  assert.equal(args[args.indexOf("-seg_duration") + 1], "0.5");
  assert.equal(args[args.indexOf("-frag_duration") + 1], "0.5");
  assert.equal(args[args.indexOf("-g") + 1], "15");
  assert.equal(args[args.indexOf("-init_seg_name") + 1], "init-$RepresentationID$.m4s");
  assert.equal(args[args.indexOf("-media_seg_name") + 1], "chunk-$RepresentationID$-$Number%05d$.m4s");
  assert.equal(args.at(-1), manifestPath);
});

test("CyberDash DASH args support muxed input audio mapping and seek", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "/tmp/input.mp4",
    height: 480,
    fps: 24,
    startAt: 12.5,
    manifestPath: "/tmp/manifest.mpd",
  });
  const maps = args.flatMap((value, index) => value === "-map" ? [args[index + 1]] : []);
  assert.deepEqual(maps, ["0:v:0", "0:a:0?"]);
  assert.equal(args[args.indexOf("-ss") + 1], "12.5");
  assert.match(args[args.indexOf("-vf") + 1], /scale=-2:480,fps=24/);
});

test("DASH manifest parser identifies video/audio representation metadata", () => {
  const parsed = parseDashManifest(`<?xml version="1.0"?>
    <MPD mediaPresentationDuration="PT12.340S">
      <Period>
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <Representation id="0" mimeType="video/mp4" codecs="avc1.64001f" bandwidth="2500000" width="1280" height="720" frameRate="30/1" />
        </AdaptationSet>
        <AdaptationSet contentType="audio" mimeType="audio/mp4">
          <Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000" />
        </AdaptationSet>
      </Period>
    </MPD>`);
  assert.equal(parsed.durationSec, 12.34);
  assert.deepEqual(parsed.video, {
    id: "0",
    codec: "avc1.64001f",
    bandwidth: 2500000,
    width: 1280,
    height: 720,
    frameRate: "30/1",
  });
  assert.deepEqual(parsed.audio, {
    id: "1",
    codec: "mp4a.40.2",
    bandwidth: 128000,
    width: null,
    height: null,
    frameRate: null,
  });
});

test("CyberDash DASH args seek both separate video and audio inputs", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "https://example.test/video",
    audioInput: "https://example.test/audio",
    height: 720,
    fps: 30,
    startAt: 3661.25,
    manifestPath: "/tmp/manifest.mpd",
  });
  const seekIndexes = args.flatMap((value, index) => value === "-ss" ? [index] : []);
  assert.equal(seekIndexes.length, 2);
  assert.deepEqual(seekIndexes.map((index) => args[index + 1]), ["3661.25", "3661.25"]);
  assert.ok(seekIndexes[0] < args.indexOf("https://example.test/video"));
  assert.ok(seekIndexes[1] < args.indexOf("https://example.test/audio"));
});

test("CyberDash DASH args clamp invalid size/fps and ignore negative seek", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "/tmp/input.mp4",
    height: 80,
    fps: 999,
    startAt: -42,
    manifestPath: "/tmp/manifest.mpd",
  });
  assert.match(args[args.indexOf("-vf") + 1], /scale=-2:240,fps=60/);
  assert.equal(args.includes("-ss"), false);
});

test("DASH manifest parser supports long ISO-8601 hour/minute durations", () => {
  const parsed = parseDashManifest(`<?xml version="1.0"?>
    <MPD mediaPresentationDuration="PT2H3M4.5S">
      <Period>
        <AdaptationSet contentType="video">
          <Representation id="v0" codecs="avc1.64001f" bandwidth="1400000" width="854" height="480" frameRate="30/1" />
        </AdaptationSet>
        <AdaptationSet contentType="audio">
          <Representation id="a0" codecs="mp4a.40.2" bandwidth="128000" />
        </AdaptationSet>
      </Period>
    </MPD>`);
  assert.equal(parsed.durationSec, 7384.5);
});

test("DASH manifest parser leaves unknown duration formats unset", () => {
  const parsed = parseDashManifest(`<MPD mediaPresentationDuration="forever"></MPD>`);
  assert.equal(parsed.durationSec, null);
});


test("CyberDash DASH args honor low-FPS player selections", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "/tmp/input.mp4",
    height: 360,
    fps: 5,
    manifestPath: "/tmp/manifest.mpd",
  });
  assert.match(args[args.indexOf("-vf") + 1], /scale=-2:360,fps=5/);
  assert.equal(args[args.indexOf("-seg_duration") + 1], "1");
  assert.equal(args[args.indexOf("-g") + 1], "5");
});


test("CyberDash session status uses the same low-FPS range as ffmpeg", () => {
  const source = fs.readFileSync(new URL("../src/lib/cyberdash-dash.js", import.meta.url), "utf8");
  assert.match(source, /fps: clampInt\(fps, 5, 60, 30\)/);
});


test("CyberDash DASH producer scales input readrate with playback speed", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "https://example.test/video",
    audioInput: "https://example.test/audio",
    height: 480,
    fps: 24,
    playbackRate: 3,
    manifestPath: "/tmp/manifest.mpd",
  });
  const readrateIndexes = args.flatMap((value, index) => value === "-readrate" ? [index] : []);
  assert.equal(readrateIndexes.length, 2);
  const rates = readrateIndexes.map((index) => Number(args[index + 1]));
  assert.ok(rates.every((rate) => rate > 3));
  const burstIndexes = args.flatMap((value, index) => value === "-readrate_initial_burst" ? [index] : []);
  assert.equal(burstIndexes.length, 2);
  assert.ok(burstIndexes.every((index) => Number(args[index + 1]) >= 9));
});

test("CyberDash DASH producer clamps playback speed to 1x-4x", () => {
  const slow = buildCyberdashDashArgs({
    videoInput: "/tmp/input.mp4",
    playbackRate: 0.25,
    manifestPath: "/tmp/manifest.mpd",
  });
  const fast = buildCyberdashDashArgs({
    videoInput: "/tmp/input.mp4",
    playbackRate: 99,
    manifestPath: "/tmp/manifest.mpd",
  });
  assert.equal(Number(slow[slow.indexOf("-readrate") + 1]), 1.15);
  assert.ok(Number(fast[fast.indexOf("-readrate") + 1]) >= 4.5);
  assert.ok(Number(fast[fast.indexOf("-readrate") + 1]) <= 5);
});

test("FFmpeg without initial burst support retains readrate and separate input seek", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "https://example.test/video",
    audioInput: "https://example.test/audio",
    startAt: 12.5,
    playbackRate: 1.5,
    encoder: "libx264",
    initialBurstSupported: false,
    manifestPath: "/tmp/manifest.mpd",
  });
  assert.equal(args.includes("-readrate_initial_burst"), false);
  const inputs = args.flatMap((value, index) => value === "-i" ? [index] : []);
  assert.equal(inputs.length, 2);
  for (const index of inputs) {
    assert.deepEqual(args.slice(index - 4, index - 1), ["-ss", "12.5", "-readrate"]);
    assert.ok(Math.abs(Number(args[index - 1]) - 2.4) < 0.0001);
  }
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-af") + 1], "atempo=1.5");
});

test("server FFmpeg option errors are not reported as missing stream URLs", () => {
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const source = app.match(/function streamErrorDetail\(reason\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const detail = vm.runInNewContext(`(${source})`);
  const result = detail("Unrecognized option 'readrate_initial_burst'. | Error splitting the argument list: Option not found");
  assert.match(result, /server could not encode/);
  assert.doesNotMatch(result, /stream URL was not found/);
  assert.match(detail("HTTP 404: not found"), /stream URL was not found/);
});


test("CyberDash DASH producer uses pitch-preserving atempo for playback speed", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "https://example.test/video",
    audioInput: "https://example.test/audio",
    playbackRate: 1.5,
    manifestPath: "/tmp/manifest.mpd",
  });
  assert.equal(args[args.indexOf("-af") + 1], "atempo=1.5");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
});

test("CyberDash DASH atempo is clamped with the supported playback range", () => {
  const args = buildCyberdashDashArgs({
    videoInput: "/tmp/input.mp4",
    playbackRate: 99,
    manifestPath: "/tmp/manifest.mpd",
  });
  assert.equal(args[args.indexOf("-af") + 1], "atempo=4");
});

 test("portable DASH supports the Linux software encoder", () => {
  const args = buildCyberdashDashArgs({videoInput:"/tmp/video.mp4",encoder:"libx264",manifestPath:"/tmp/manifest.mpd"});
  assert.equal(args[args.indexOf("-c:v")+1],"libx264");
});


test("real FFmpeg produces independently decodable half-second DASH video and audio after seeking", { timeout: 20_000 }, async (t) => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 3_000 });
  if (probe.error?.code === "ENOENT") return t.skip("FFmpeg not installed");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ytstreamer-half-second-dash-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "test-input.mp4");
  const source = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", input,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(source.status, 0, source.stderr);

  const output = path.join(directory, "manifest.mpd");
  const encode = spawnSync("ffmpeg", buildCyberdashDashArgs({
    videoInput: input,
    height: 240,
    fps: 30,
    startAt: 1.25,
    encoder: "libx264",
    initialBurstSupported: false,
    manifestPath: output,
  }), { encoding: "utf8", timeout: 10_000 });
  assert.equal(encode.status, 0, encode.stderr);
  const manifest = parseDashManifest(fs.readFileSync(output, "utf8"));
  assert.ok(manifest.video?.id != null, "DASH video representation");
  assert.ok(manifest.audio?.id != null, "DASH audio representation");
  const files = fs.readdirSync(directory);
  for (const id of [manifest.video.id, manifest.audio.id]) {
    assert.ok(files.includes(`init-${id}.m4s`), "codec init segment exists");
    const segments = files.filter((name) => name.startsWith(`chunk-${id}-`) && name.endsWith(".m4s"));
    assert.ok(segments.length >= 2, "multiple seeked A/V fragments exist");
    assert.ok(segments.every((name) => fs.statSync(path.join(directory, name)).size > 0));
  }
});
