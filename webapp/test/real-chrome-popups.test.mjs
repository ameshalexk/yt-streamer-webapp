import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isAllowedPopupUrl, isApneTvDevtoolFallbackUrl } from "../src/lib/real-chrome-renderer.js";

const renderer = fs.readFileSync(new URL("../src/lib/real-chrome-renderer.js", import.meta.url), "utf8");
const apneDaily = fs.readFileSync(new URL("../src/lib/apne-daily.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("browser MJPEG supports 60 FPS defaults and JPEG quality 100", () => {
  assert.match(renderer, /const DEFAULT_FPS = 60/);
  assert.match(renderer, /clampInt\(value, 20, 100, fallback\)/);
});

test("Real Chrome popup allowlist accepts only mediagraming.com and subdomains", () => {
  assert.equal(isAllowedPopupUrl("https://mediagraming.com/watch/123"), true);
  assert.equal(isAllowedPopupUrl("https://www.mediagraming.com/watch/123"), true);
  assert.equal(isAllowedPopupUrl("https://cdn.mediagraming.com/player"), true);
  assert.equal(isAllowedPopupUrl("https://evilmediagraming.com/"), false);
  assert.equal(isAllowedPopupUrl("https://mediagraming.com.evil.example/"), false);
  assert.equal(isAllowedPopupUrl("https://example.com/"), false);
  assert.equal(isAllowedPopupUrl("about:blank"), false);
});


test("APNE TV injected Flash guard compiles as browser JavaScript", () => {
  const match = renderer.match(/const APNE_FLASH_GUARD = `([\s\S]*?)`;/);
  assert.ok(match, "APNE flash guard source should exist");
  const runtimeSource = new Function(`return \`${match[1]}\`;`)();
  assert.doesNotThrow(() => new Function(runtimeSource));
  assert.match(runtimeSource, /hostname !== "apnetv\.xyz"/);
});

test("APNE TV Flash Link gesture bypasses page ad handlers", () => {
  assert.match(renderer, /const APNE_FLASH_GUARD/);
  assert.match(renderer, /__ytApneFlashGuardInstalled/);
  assert.match(renderer, /pointerdown/);
  assert.match(renderer, /newsportaling/);
  assert.match(renderer, /form\.method = "POST"/);
  assert.match(renderer, /form\.target = "_blank"/);
  assert.match(renderer, /installApneFlashGuard\(cdp\)/);
  assert.match(renderer, /source: APNE_FLASH_GUARD/);
});

test("APNE TV injects a top-level Download overlay", () => {
  assert.match(renderer, /PLAY_NOW_CLASS = "yt-apne-play-now"/);
  assert.match(renderer, /button\.textContent = "Download"/);
  assert.match(renderer, /Download this episode to the Mac/);
  assert.match(renderer, /document\.querySelectorAll\("body > \." \+ PLAY_NOW_CLASS\)/);
  assert.match(renderer, /document\.body\.appendChild\(button\)/);
  assert.match(renderer, /pointerEvents: "auto"/);
  assert.match(renderer, /zIndex: "2147483647"/);
  assert.match(renderer, /__ytApnePlayNowRequestedAt/);
  assert.match(renderer, /MutationObserver/);
});

test("APNE Download resolves the JW HLS stream and saves one synced MP4 on the Mac", () => {
  assert.match(renderer, /mediagramingHlsUrl/);
  assert.match(renderer, /videoapne\.to/);
  assert.match(renderer, /downloadMediagramingEpisode/);
  assert.match(renderer, /downloadApneHls/);
  assert.match(apneDaily, /config\.libraryDir/);
  assert.match(apneDaily, /"-map", "0:v:0\?"/);
  assert.match(apneDaily, /"-map", "0:a:0\?"/);
  assert.match(apneDaily, /"-c", "copy"/);
  assert.match(renderer, /APNE download completed/);
});

test("Real Chrome pins a gesture to one CDP target and self-paces capture", () => {
  assert.match(renderer, /const cdp = session\.cdp/);
  assert.match(renderer, /Input\.dispatchTouchEvent/);
  assert.match(renderer, /CAPTURE_CONTROL_HEADROOM_MS = 8/);
  assert.match(renderer, /CAPTURE_COMMAND_TIMEOUT_MS = 1500/);
  assert.match(renderer, /scheduleNextCapture/);
  assert.match(renderer, /session\.cdp !== cdp/);
});

test("Download tap is intercepted by coordinates and resolved in a background popup", () => {
  assert.match(renderer, /tryApnePlayNowAtPoint/);
  assert.match(renderer, /body > \.yt-apne-play-now/);
  assert.match(renderer, /userGesture: true/);
  assert.match(renderer, /return \{ ok: true, download: playNow \}/);
  assert.match(renderer, /backgroundTargetIds/);
  assert.match(renderer, /resolving APNE download/);
  assert.match(app, /Preparing download on Mac/);
});

test("APNE TV Flash Link transit is hidden and narrowly scoped", () => {
  assert.match(renderer, /APNE_TRANSIT_TIMEOUT_MS = 5000/);
  assert.match(renderer, /hostname === "newsportaling\.com"/);
  assert.match(renderer, /url\.pathname\.startsWith\("\/finnance-"\)/);
  assert.match(renderer, /isApneTvTransitUrl/);
  assert.match(renderer, /return "transit"/);
  assert.match(renderer, /decision === "transit"/);
  assert.match(renderer, /apneMainActive/);
  assert.match(renderer, /allowing hidden APNE transit/);
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

test("APNE downloads register as hidden local-file library items with duration", () => {
  assert.match(renderer, /downloadApneHls/);
  assert.match(apneDaily, /ensureDownloadedVideosPlaylist/);
  assert.match(apneDaily, /kind: "downloaded-files"/);
  assert.match(apneDaily, /registerDownloadedVideo/);
  assert.match(apneDaily, /probeLocalVideoDuration/);
  assert.match(apneDaily, /ffprobe/);
  assert.match(apneDaily, /mirrorApneVideoToICloud\(finalPath\)/);
  assert.match(apneDaily, /const savedMeta = \{ \.\.\.meta, iCloudPath/);
  assert.match(apneDaily, /type: "file"/);
  assert.match(apneDaily, /source: "apnetv"/);
});

test("Downloaded Videos drawer includes local MP4 items and plays them through the normal local-file player", () => {
  assert.match(app, /function downloadedLocalItems\(\)/);
  assert.match(app, /Local MP4 · synced video \+ audio/);
  assert.match(app, /data-local-id/);
  assert.match(app, /await playItem\(item\)/);
  assert.match(app, /visibleSavedPlaylists/);
});
