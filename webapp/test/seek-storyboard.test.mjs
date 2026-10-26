import test from "node:test";
import assert from "node:assert/strict";
import { extractStoryboard } from "../src/lib/ytdlp.js";

const sourceId = "dQw4w9WgXcQ";
const sheet = (n) => "https://i.ytimg.com/sb/" + sourceId + "/storyboard3_L2/M" + n + ".jpg?sigh=valid";
const metadata = () => ({
  id: sourceId, duration: 210, is_live: false, formats: [
    { format_id: "sb2", format_note: "storyboard", width: 80, height: 45, fps: 0.5,
      columns: 10, rows: 10, fragments: [{ url: sheet(0) }] },
    { format_id: "sb1", format_note: "storyboard", width: 160, height: 90, fps: 0.5,
      columns: 5, rows: 5, fragments: [{ url: sheet(0) }, { url: sheet(1) }] },
  ],
});

test("seek preview selects the YouTube 160x90 sprite without media transcoding", () => {
  assert.deepEqual(extractStoryboard(metadata()), {
    width: 160, height: 90, fps: 0.5, rows: 5, columns: 5, urls: [sheet(0), sheet(1)],
  });
});

test("seek previews omit live videos, invalid metadata and untrusted sprite URLs", () => {
  const live = metadata();
  live.is_live = true;
  assert.equal(extractStoryboard(live), null);
  assert.equal(extractStoryboard({ ...metadata(), duration: 0 }), null);
  assert.equal(extractStoryboard({ ...metadata(), id: "invalid" }), null);
  const hostile = metadata();
  hostile.formats[1].fragments[0].url = "http://i.ytimg.com/sb/" + sourceId + "/bad.jpg";
  hostile.formats[0].fragments[0].url = "https://evil.example/sb/" + sourceId + "/M0.jpg";
  assert.equal(extractStoryboard(hostile), null);
});

test("seek preview rejects unreasonable sizes and bounds long-video metadata", () => {
  const oversized = metadata();
  oversized.formats[1].columns = 99;
  assert.equal(extractStoryboard(oversized).width, 80);
  const huge = metadata();
  huge.formats[1].fragments = Array.from({length: 1100}, (_, i) => ({url: sheet(i)}));
  assert.equal(extractStoryboard(huge).urls.length, 1000);
});
