import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/mobile-player-fixes.css",import.meta.url),"utf8");
const stream=fs.readFileSync(new URL("../src/lib/stream.js",import.meta.url),"utf8");

test("Actual codec is distinct from selected playback preference and visible at phone size",()=>{
 for(const id of ["activePlaybackCodec","activePlaybackAudio","playerRetryAudioBtn"]){
  assert.equal((html.match(new RegExp('id="'+id+'"',"g"))||[]).length,1,id+" should exist exactly once");
 }
 assert.match(app,/function updateActivePlaybackStatus\(\)/);
 assert.match(app,/activeCompat\?\.frameFormat === "jxl"/);
 assert.match(app,/screen\?\.classList\.contains\("cyberdash-mode"\)/);
 assert.match(app,/JPEG XL · JXL/);
 assert.match(app,/WebCodecs · H\.264/);
 assert.match(app,/MJPEG · JPEG frames/);
 assert.match(html,/aria-live="polite"/);
 assert.match(css,/@media \(max-width: 520px\)[\s\S]*?\.player-active-status \{/);
});
test("Buffered sound failure retries and exposes visible manual recovery rather than a silent false-success",()=>{
 assert.match(app,/const handleBufferedAudioFailure = \(reason\) =>/);
 assert.match(app,/audioRetryCount < 3/);
 assert.match(app,/player\.setAudioDisabled\(true, clockPosition\)/);
 assert.match(app,/url\.searchParams\.set\("_", String\(Date\.now\(\)\)\)/);
 assert.match(app,/url\.searchParams\.set\("timestamp", String\(absoluteTime\)\)/);
 assert.match(app,/Sound unavailable · video continues silently/);
 assert.match(app,/audio\.onplaying = \(\) =>/);
 assert.match(app,/\$\("#playerRetryAudioBtn"\)\.onclick =/);
 assert.match(app,/Audio: unavailable · video clock \(silent\)/);
});
test("Audio response cannot report HTTP 200 until real MP3 data exists",()=>{
 const block=stream.match(/export function streamAudio\([\s\S]*?\n}\n\n\/\/ Quick probe/);
 assert.ok(block, "Dedicated audio streaming function missing");
 assert.match(block[0],/ff\.stdout\.on\("data"/);
 assert.match(block[0],/res\.writeHead\(200/);
 assert.match(block[0],/if \(!sentAudio\) return fail/);
 assert.match(block[0],/res\.on\("close", cleanup\)/);
 assert.doesNotMatch(block[0],/req\.on\("close"/);
 assert.match(block[0],/res\.status\(502\)\.json/);
});
