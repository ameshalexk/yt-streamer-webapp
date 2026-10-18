import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/mobile-player-fixes.css",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../src/server.js",import.meta.url),"utf8");

test("all playback modes share one persistent, accessible quality entry and panel",()=>{
 for(const id of ["playerQualityBtn","playerQualityPanel","playerQualityPresets","playerQualityCloseBtn","playerQualityContext"]){
  assert.equal((html.match(new RegExp('id="'+id+'"',"g"))||[]).length,1,id+" must be unique");
 }
 assert.match(html,/id="playerQualityBtn"[^>]*aria-expanded="false"[^>]*aria-controls="playerQualityPanel"/);
 assert.match(app,/qualityProfilesAvailableForCurrentMode/);
 assert.match(app,/Quality · Source/);
 assert.match(css, /\.screen > \.player-quality-trigger/);
 assert.match(css, /\.screen:not\(\.playing\) > \.player-quality-trigger/);
});
test("phone playback autoscrolls on a new selection, not on replay or quality changes",()=>{
 assert.match(app,/function beginNewPlaybackQuality\(\) \{\s*scheduleMobilePlayerReveal\(\);/);
 assert.match(app,/function maybeRevealMobilePlayer\(/);
 assert.match(app,/screen\.scrollIntoView\(\{ block: "start"/);
 assert.match(app,/new MutationObserver\(maybeRevealMobilePlayer\)/);
 assert.match(app,/function stopPlayback\(\) \{\s*mobilePlayerRevealPending = false/);
 assert.doesNotMatch(app,/function performQualityProfileSwitch\([^)]*\) \{[\s\S]{0,240}scheduleMobilePlayerReveal\(/);
});
test("iPhone viewport styles handle narrow widths and no video-covering preset grid",()=>{
 assert.match(html,/mobile-player-fixes\.css\?v=/);
 assert.match(css,/@media \(max-width: 520px\)/);
 assert.match(css,/@media \(max-width: 355px\)/);
 assert.match(css,/player-body > \.screen \{ order: 0/);
 assert.match(css,/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
 assert.match(css,/min-height: 44px/);
});
test("APNE native player has the same nearby honest quality disclosure",()=>{
 assert.match(server,/id="apneQualityDetails"/);
 assert.match(server,/id="apneQualitySummary">Quality · Source/);
 assert.match(server,/video id="apneLiveVideo"[\s\S]*?id="apneQualityDetails"/);
});


test("MJPEG and WebCodecs are directly below video, never inside hidden playback accordion",()=>{
 const screen=html.indexOf('id="screen"');
 const videoModes=html.indexOf('id="playerVideoModes"');
 const qualityPanel=html.indexOf('id="playerQualityPanel"');
 const hiddenToolbar=html.indexOf('class="player-toolbar"');
 assert.ok(screen > hiddenToolbar, "video appears after the expandable Playback controls section");
 assert.ok(videoModes > screen && videoModes < qualityPanel, "playback-mode switch must be a direct sibling below the active video");
 assert.equal((html.match(/id="playbackMethodToggle"/g)||[]).length, 1);
 assert.deepEqual([...html.matchAll(/data-playback-method="([^"]+)"/g)].map(x=>x[1]),["mjpeg","webcodecs"]);
 assert.match(css,/\.player-body > \.player-video-modes \{ order: 1/);
 assert.match(css,/\.player-video-modes \.playback-method-toggle \.btn \{[^}]*min-height: 44px/s);
 assert.match(app,/\$\("#playbackMethodToggle"\)\?\.addEventListener\("click"/);
});
