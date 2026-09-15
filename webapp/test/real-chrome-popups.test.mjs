import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isAllowedPopupUrl, isApneTvDevtoolFallbackUrl } from "../src/lib/real-chrome-renderer.js";

const renderer = fs.readFileSync(new URL("../src/lib/real-chrome-renderer.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("Real Chrome popup allowlist accepts only mediagraming.com and subdomains", () => {
  assert.equal(isAllowedPopupUrl("https://mediagraming.com/watch/123"), true);
  assert.equal(isAllowedPopupUrl("https://www.mediagraming.com/watch/123"), true);
  assert.equal(isAllowedPopupUrl("https://cdn.mediagraming.com/player"), true);
  assert.equal(isAllowedPopupUrl("https://evilmediagraming.com/"), false);
  assert.equal(isAllowedPopupUrl("https://mediagraming.com.evil.example/"), false);
  assert.equal(isAllowedPopupUrl("https://example.com/"), false);
  assert.equal(isAllowedPopupUrl("about:blank"), false);
});


test("APNE TV disable-devtool fallback is recognized narrowly", () => {
  assert.equal(isApneTvDevtoolFallbackUrl("https://theajack.github.io/disable-devtool/404.html?h=apnetv.xyz"), true);
  assert.equal(isApneTvDevtoolFallbackUrl("https://theajack.github.io/disable-devtool/404.html?h=www.apnetv.xyz"), true);
  assert.equal(isApneTvDevtoolFallbackUrl("https://theajack.github.io/disable-devtool/404.html?h=example.com"), false);
  assert.equal(isApneTvDevtoolFallbackUrl("https://apnetv.xyz/"), false);
});

test("Real Chrome installs the anti-devtool block before initial navigation", () => {
  assert.match(renderer, /REMOTE_BROWSER_BLOCKED_URLS = \[[\s\S]*cdn\.jsdelivr\.net\/npm\/disable-devtool/);
  assert.match(renderer, /Network\.setBlockedURLs/);
  assert.match(renderer, /"--new-window",\s*"about:blank"/);
  assert.match(renderer, /await preparePage\(session\);[\s\S]*Page\.navigate", \{ url \}/);
});

test("APNE TV astronaut redirect self-recovers to previous APNE history entry", () => {
  assert.match(renderer, /recoverMainFromApneTvDevtoolRedirect/);
  assert.match(renderer, /Page\.getNavigationHistory/);
  assert.match(renderer, /Page\.navigateToHistoryEntry/);
  assert.match(renderer, /session\.mainSafeUrl/);
});

test("popup guard blocks other page targets and watches allowed redirects", () => {
  assert.match(renderer, /const POPUP_ALLOWED_HOSTS = \["mediagraming\.com"\]/);
  assert.match(renderer, /POPUP_GUARD_INTERVAL_MS = 250/);
  assert.match(renderer, /popupUrlDecision\(activeSecondary\.url\) === "block"/);
  assert.match(renderer, /closeChromeTarget\(session\.port, target\.id\)/);
  assert.match(renderer, /activateAllowedSecondaryTab\(session, target\)/);
  assert.match(renderer, /restoreMainTab\(session, \{ closeTargetId: blockedId \}\)/);
});

test("remote X closes only the secondary Real Chrome tab", () => {
  assert.match(server, /\/api\/real-chrome\/:id\/close-tab/);
  assert.match(app, /closeRealChromePopup/);
  assert.match(app, /\/close-tab/);
  assert.match(html, /id="browserClosePopupBtn"[^>]*>×<\/button>/);
  assert.match(css, /\.browser-close-popup \{[\s\S]*right: 16px;/);
  assert.match(renderer, /if \(!session\.secondaryTargetId\) \{[\s\S]*closed: false/);
});
