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
