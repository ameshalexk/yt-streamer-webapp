import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Tesla Remote Play navigation is shared by both UI modes and stays hidden until authorized", () => {
  const html = read("../public/index.html");
  const nav = read("../public/tesla-remote-play-nav.js");

  assert.match(html, /id="teslaRemotePlayTab"[^>]*hidden/);
  assert.match(html, /src="\/tesla-remote-play-nav\.js/);
  assert.match(nav, /fetch\("\/api\/tesla-remote-play\/status", \{ credentials: "same-origin", cache: "no-store" \}\)/);
  assert.match(nav, /status\?\.available === true/);
  assert.match(nav, /window\.location\.assign\(`\/tesla-remote-play\/\?returnTo=/);
  assert.match(nav, /returnTo = `\/\?mode=browse&ui=\$\{ui\}`/);
});

test("returning from Tesla Remote Play restores Browse and retains the selected UI mode", () => {
  const app = read("../public/app.js");
  const nav = read("../public/tesla-remote-play-nav.js");

  assert.match(nav, /dataset\.ui === "new" \? "new" : "classic"/);
  assert.match(app, /const returnToBrowse = params\.get\("mode"\) === "browse"/);
  assert.match(app, /else if \(returnToBrowse\) openChannels\(\)/);
});
