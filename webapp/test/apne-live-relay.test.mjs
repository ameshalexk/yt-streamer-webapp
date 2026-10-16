import test from "node:test";
import assert from "node:assert/strict";
import { createApneLiveRelay, rewriteApneLivePlaylist, validatedApneLiveAsset } from "../src/lib/apne-live-relay.js";

const id = "0123456789abcdef0123456789abcdef";
const base = "https://cdn.justfingram.com/private/master.m3u8";
test("APNE live relay accepts only approved HTTPS media hosts and types", () => {
  assert.ok(validatedApneLiveAsset("https://segments.justfingram.com/scene1.ts"));
  assert.ok(validatedApneLiveAsset("https://cdn.justfingram.com/xyz.m3u8"));
  assert.ok(validatedApneLiveAsset("https://s2.videoapne.to/path/abc.ts"));
  assert.equal(validatedApneLiveAsset("https://justfingram.com/hls_key.php?id=abcd1234")?.ext, "key");
  assert.equal(validatedApneLiveAsset("https://justfingram.com/admin.php?id=abcd1234"), null);
  assert.equal(validatedApneLiveAsset("https://evil.justfingram.com/hls_key.php?id=abcd1234"), null);
  assert.equal(validatedApneLiveAsset("https://justfingram.com/hls_key.php?id=abcd1234&url=http://localhost"), null);
  for (const bad of [
    "http://segments.justfingram.com/scene1.ts",
    "https://segments.justfingram.com.evil.example/scene1.ts",
    "https://localhost/a.ts", "https://127.0.0.1/scene1.ts",
    "https://segments.justfingram.com:1234/a.ts",
    "https://user@segments.justfingram.com/a.ts",
    "https://segments.justfingram.com/secrets.txt",
    "https://cdn.justfingram.com/scene1.ts#access",
  ]) assert.equal(validatedApneLiveAsset(bad), null, bad);
});

test("APNE HLS playlist rewrites each media and key URI to scoped local request", () => {
  const session = { id, assets: new Map() };
  const source = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.justfingram.com/token.key"\n#EXTINF:8,\nhttps://segments.justfingram.com/part1.ts\n#EXTINF:8,\npart2.ts\n#EXT-X-ENDLIST\n';
  const result = rewriteApneLivePlaylist(source, base, session);
  assert.match(result, new RegExp('/apne/live/media/' + id + '/0.key'));
  assert.match(result, new RegExp('/apne/live/media/' + id + '/1.ts'));
  assert.match(result, new RegExp('/apne/live/media/' + id + '/2.ts'));
  assert.equal(session.assets.get('2.ts'), 'https://cdn.justfingram.com/private/part2.ts');
  assert.doesNotMatch(result, /https:\/\//);
  assert.equal(session.assets.size, 3);
});

test("APNE live relay rejects untrusted segment and invalid manifest", () => {
  const sess = { id, assets: new Map() };
  assert.throws(() => rewriteApneLivePlaylist('#EXTM3U\nhttp://127.0.0.1/x.ts', base, sess), /untrusted/);
  assert.throws(() => rewriteApneLivePlaylist('<html>bad</html>', base, sess), /Unexpected/);
});

test("APNE direct HLS creates an ephemeral request map without saving media", async () => {
  const seen = [];
  const relay = createApneLiveRelay({ fetchImpl: async (url, init) => {
    seen.push({url, init});
    return new Response('#EXTM3U\n#EXTINF:4,\nhttps://segments.justfingram.com/one.ts\n#EXT-X-ENDLIST', { status: 200, headers: {'content-type':'application/vnd.apple.mpegurl'} });
  }});
  const playlist = await relay.start({hlsUrl:base,referer:'https://justfingram.com/play.php?id=test'});
  assert.match(playlist, /\/apne\/live\/media\/[a-f0-9]{32}\/0\.ts/);
  assert.equal(relay.active(),1);
  assert.equal(seen.length,1);
  assert.equal(seen[0].url,base);
  assert.equal(seen[0].init.headers.Referer,'https://justfingram.com/play.php?id=test');
});
