import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("iOS standalone web app metadata is present", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /apple-mobile-web-app-capable.*yes/);
  assert.match(html, /apple-mobile-web-app-status-bar-style.*black-translucent/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /viewport-fit=cover/);
});

test("web app manifest launches standalone without service-worker caching", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.name, "YT Streamer");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.display_override, ["fullscreen", "standalone"]);
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.equal(fs.existsSync(new URL("../public/service-worker.js", import.meta.url)), false);
});
