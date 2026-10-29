import test from "node:test";
import assert from "node:assert/strict";
import { archiveVideoUrl, normalizeRetroGuide, createRetroTvSource } from "../src/lib/retro-tv-source.js";

const TIME = Date.UTC(2026, 9, 29, 17, 0, 0);
const guide = () => ({ now: TIME - 5000, channels: [
  { id:"classics",number:1,name:"Classic Films",now:{
    film:{id:"film-one", title:"Example",seconds:1800,url:"https://archive.org/download/test-video/test-video.mp4"},
    offset:60,startsAt:TIME-65000,endsAt:TIME+1735000,
  }, programmes:[{title:"Example",startsAt:TIME-65000}]},
]});

test("only HTTPS Internet Archive download URLs accepted", () => {
  assert.ok(archiveVideoUrl("https://archive.org/download/test/video.mp4"));
  for (const value of ["http://archive.org/download/a/b", "https://evil.invalid/download/a/b",
    "https://archive.org.evil.invalid/download/a/b", "https://archive.org/metadata/id",
    "https://user:pass@archive.org/download/a/b", "file:///etc/passwd"])
    assert.equal(archiveVideoUrl(value), null);
});
test("guide offset advances with source age, bounded by file duration", () => {
  const result = normalizeRetroGuide(guide(), TIME);
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].now.offset,65);
  assert.equal(result.channels[0].programmes[0].title,"Example");
  assert.equal(normalizeRetroGuide(guide(),TIME+1800000).channels.length, 0);
});
test("malformed/unsafe channels filtered", () => {
  const data = guide();
  data.channels.push({id:"unsafe",now:{film:{url:"https://internal.example.local/secret"}}});
  assert.equal(normalizeRetroGuide(data,TIME).channels.length,1);
  assert.throws(()=>normalizeRetroGuide({},TIME));
});
test("feed reads once while cached, refresh reads again", async () => {
  let count=0;
  const fetchImpl=async()=>{count++;return {
    ok:true, body:(async function*(){yield new TextEncoder().encode(JSON.stringify(guide()));})(),
  };};
  const source = createRetroTvSource({fetchImpl,now:()=>TIME});
  await source.read();await source.read(); assert.equal(count,1);
  await source.read({refresh:true});assert.equal(count,2);
});
test("feed byte cap enforced", async () => {
  const source = createRetroTvSource({fetchImpl:async()=>({
    ok:true,body:(async function*(){yield new Uint8Array(8*1024*1024+1)})(),
  })});
  await assert.rejects(source.read(), /too large/);
});
