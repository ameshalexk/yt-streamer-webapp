import test from "node:test";
import assert from "node:assert/strict";
import { selectedStreamInfo } from "../src/lib/ytdlp.js";

test("yt-dlp stream selection preserves per-format request headers", () => {
  const selected = selectedStreamInfo({
    http_headers: { "Accept-Language": "en-us" },
    requested_formats: [
      {
        url: "https://video.example.test/v",
        vcodec: "av01",
        acodec: "none",
        http_headers: { "User-Agent": "video-agent", Accept: "video/*" },
      },
      {
        url: "https://audio.example.test/a",
        vcodec: "none",
        acodec: "opus",
        http_headers: { "User-Agent": "audio-agent", Accept: "audio/*" },
      },
    ],
  });
  assert.equal(selected.videoUrl, "https://video.example.test/v");
  assert.equal(selected.audioUrl, "https://audio.example.test/a");
  assert.deepEqual(selected.videoHeaders, { "Accept-Language": "en-us", "User-Agent": "video-agent", Accept: "video/*" });
  assert.deepEqual(selected.audioHeaders, { "Accept-Language": "en-us", "User-Agent": "audio-agent", Accept: "audio/*" });
});

test("yt-dlp muxed selection keeps top-level headers", () => {
  const selected = selectedStreamInfo({
    url: "https://video.example.test/muxed",
    http_headers: { "User-Agent": "muxed-agent" },
  });
  assert.equal(selected.videoUrl, "https://video.example.test/muxed");
  assert.equal(selected.audioUrl, null);
  assert.deepEqual(selected.videoHeaders, { "User-Agent": "muxed-agent" });
});


test("yt-dlp stream selection propagates playback metadata used by WebCodecs", () => {
  const selected = selectedStreamInfo({
    title: "Long test video",
    duration: "7384.5",
    live_status: "not_live",
    requested_formats: [
      { url: "https://video.example.test/v", vcodec: "avc1", acodec: "none" },
      { url: "https://audio.example.test/a", vcodec: "none", acodec: "mp4a" },
    ],
  });
  assert.equal(selected.title, "Long test video");
  assert.equal(selected.duration, 7384.5);
  assert.equal(selected.isLive, false);
});

test("yt-dlp stream selection recognizes both live flags", () => {
  const viaBoolean = selectedStreamInfo({
    url: "https://video.example.test/live1",
    is_live: true,
  });
  const viaStatus = selectedStreamInfo({
    url: "https://video.example.test/live2",
    live_status: "is_live",
  });
  assert.equal(viaBoolean.isLive, true);
  assert.equal(viaStatus.isLive, true);
});

test("yt-dlp unknown duration stays null instead of becoming zero", () => {
  assert.equal(selectedStreamInfo({ url: "https://video.example.test/a", duration: null }).duration, null);
  assert.equal(selectedStreamInfo({ url: "https://video.example.test/b" }).duration, null);
  assert.equal(selectedStreamInfo({ url: "https://video.example.test/c", duration: "" }).duration, null);
});
