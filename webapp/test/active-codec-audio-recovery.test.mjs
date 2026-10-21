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
 assert.match(app,/JPEG XL · native JXL/);
 assert.match(app,/JPEG XL · WebAssembly/);
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

test("Codec mode visually distinguishes actual output and JXL requires explicit session opt-in",()=>{
 assert.match(app,/button\.classList\.toggle\("is-rendering", isOutput\)/);
 assert.match(app,/button\.dataset\.output = isOutput/);
 assert.match(css,/\.btn\.is-rendering[^{]*\{/);
 assert.match(html,/green outline and dot/);
 assert.match(app,/\["mjpeg", "webcodecs"\]\.includes\(localStorage\.getItem/);
 assert.match(app,/if \(next === "jxl"\) localStorage\.removeItem/);
});

test("JXL WebAssembly experimental mode is explicit and bounded with MJPEG fallback",()=>{
 const ui=app.match(/\$\("#playbackMethodToggle"\)\?\.addEventListener\("click", async \(event\) => \{[\s\S]*?(?=\$\("#playbackSpeedSelect"\))/)?.[0];
 assert.ok(ui, "mode-click handler missing");
 assert.match(ui,/if \(next === "jxl"\) \{/);
 assert.match(ui,/await import\("\/experimental\/jxl-wasm\/decoder-client\.mjs"\)/);
 assert.match(ui,/if \(next === "jxl"\) localStorage\.removeItem/);
 assert.match(ui,/releaseJxlWasmDecoder\(\)/);
 assert.match(app,/bufferedUrl = withUrlParam\(withUrlParam\(bufferedUrl, "height", "480"\), "fps", "12"\)/);
 assert.match(app,/frameDecoder: meta\.experimentalJxl && jxlWasmDecoder/);
 assert.match(app,/jxlFallbackInProgress = true/);
 assert.match(app,/JPEG XL · WebAssembly/);
});
