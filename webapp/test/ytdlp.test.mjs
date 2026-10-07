import test from "node:test";
import assert from "node:assert/strict";
import { commonArgs, selectedStreamInfo } from "../src/lib/ytdlp.js";

test("shared yt-dlp arguments select the explicit Node challenge runtime", () => {
  assert.deepEqual(commonArgs(["-J"]), ["--ignore-config", "--js-runtimes", process.env.YTDLP_JS_RUNTIME || "node", "-J"]);
});

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

test("stream resolution retains live/VOD metadata for fallback and seek bounds", () => {
  for (const requested_formats of [undefined, [{ url: "/tmp/video", vcodec: "avc1" }]]) {
    const live = selectedStreamInfo({url:"/tmp/video", requested_formats, live_status:"is_live", title:"Live", duration:null});
    assert.equal(live.isLive,true);
    assert.equal(live.duration,null);
    assert.equal(live.title,"Live");
    const vod = selectedStreamInfo({url:"/tmp/video", requested_formats, duration:90, title:"VOD"});
    assert.equal(vod.isLive,false);
    assert.equal(vod.duration,90);
    assert.equal(vod.title,"VOD");
  }
});
