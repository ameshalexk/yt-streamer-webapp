import test from "node:test";
import assert from "node:assert/strict";
import { retroHostAllows } from "../src/lib/retro-tv-host.js";

test("retro virtual host allows only the two playback engines and guide", () => {
  for (const [method, path] of [
    ["GET","/"],["GET","/retro-tv/"],["GET","/retro-tv/retro-tv.js"],
    ["GET","/api/retro-tv/channels"],["GET","/stream/url"],["GET","/stream/audio/url"],
    ["GET","/cyberdash-embedded.mjs"],["GET","/mp4box.all.mjs"],
    ["POST","/api/experimental/cyberdash/start"],
    ["GET","/api/experimental/cyberdash/abc123/status"],
    ["POST","/api/experimental/cyberdash/abc123/stop"],
    ["GET","/stream/experimental/cyberdash/abc123/chunk-1-00001.m4s"],
    ["POST","/api/playback-event"],
  ]) assert.ok(retroHostAllows(method,path),method+" "+path);
  for (const [method,path] of [
    ["GET","/"], // tested separately as good below
    ["POST","/api/playlists"],["GET","/api/playlists"],
    ["GET","/app.js"],["GET","/money.html"],["GET","/api/money"],
    ["GET","/stream/ts/item/123"],["POST","/api/teslamon/plan"],
    ["PUT","/api/experimental/cyberdash/start"],
    ["GET","/api/experimental/cyberdash/../status"],
  ].slice(1)) assert.equal(retroHostAllows(method,path),false,method+" "+path);
});
