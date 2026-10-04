import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("production server keeps the CyberDash WebCodecs API wired", () => {
  assert.match(server, /import \* as cyberdashDash from "\.\/lib\/cyberdash-dash\.js"/);
  assert.match(server, /app\.post\("\/api\/experimental\/cyberdash\/start"/);
  assert.match(server, /app\.get\("\/api\/experimental\/cyberdash\/:id\/status"/);
  assert.match(server, /app\.post\("\/api\/experimental\/cyberdash\/:id\/stop"/);
  assert.match(server, /app\.get\("\/stream\/experimental\/cyberdash\/:id\/:file"/);
  assert.match(server, /cyberdashDash\.cleanupStaleDashFiles\(\)/);
});

test("CyberDash start route receives YouTube VOD metadata", () => {
  const proxy = server.match(/function proxyYouTubeStreams\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(proxy, /isLive: Boolean\(resolved\.isLive\)/);
  assert.match(proxy, /duration:/);
  assert.match(proxy, /title: resolved\.title \|\| null/);

  const start = server.match(/app\.post\("\/api\/experimental\/cyberdash\/start"[\s\S]*?\n\}\)\);/)?.[0] || "";
  assert.match(start, /startYouTubeDashSession/);
  assert.match(start, /if \(isLive\)/);
  assert.match(start, /fallback: "mjpeg"/);
});
