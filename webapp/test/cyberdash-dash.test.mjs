import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { buildCyberdashDashArgs, parseDashManifest } from "../src/lib/cyberdash-dash.js";

test("CyberDash DASH args use hardware H.264, AAC, fMP4 DASH, and separate audio mapping", () => {
  const manifestPath = path.join("/tmp", "session", "manifest.mpd");
  const args = buildCyberdashDashArgs({
    videoInput: "http://127.0.0.1/video",
    audioInput: "http://127.0.0.1/audio",
    height: 720,
    fps: 30,
    manifestPath,
  });
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "0:v:0", "-map", "1:a:0"]);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_videotoolbox");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-f") + 1], "dash");
  assert.equal(args[args.indexOf("-seg_duration") + 1], "1");
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
});


test("CyberDash session status uses the same low-FPS range as ffmpeg", () => {
  const source = fs.readFileSync(new URL("../src/lib/cyberdash-dash.js", import.meta.url), "utf8");
  assert.match(source, /fps: clampInt\(fps, 5, 60, 30\)/);
});
