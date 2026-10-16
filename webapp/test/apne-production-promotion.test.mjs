import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=file=>readFileSync(new URL(file,import.meta.url),"utf8");
test("Production APNE page serves separate UI and calendar",()=>{
 const html=source("../public/apne/index.html");
 assert.match(html,/\/apne\/app\.js\?/);
 assert.match(html,/\/apne\/styles\.css\?/);
 assert.match(html,/id="calendarPanel"/);
 assert.match(html,/id="exitCalendar"/);
 assert.match(html,/id="latestPreview"[^>]+href="/);
 assert.match(html,/href="\/\?mode=apne&amp;classic=1"/);
 assert.doesNotMatch(html,/Experimental preview/);
});
test("Thumbnail links point to existing authenticated player",()=>{
 const js=source("../public/apne/app.js");
 assert.match(js,/function episodePlayerUrl/);
 assert.match(js,/\/apne\/live\/watch\//);
 assert.match(js,/class="episode-art" href=/);
 assert.match(js,/hero\.href=episodePlayerUrl/);
 assert.match(js,/airDate\(ep\)===state\.date/);
 assert.doesNotMatch(js,/method:\s*["'](?:POST|PATCH|PUT|DELETE)["']/i);
 const server=source("../src/server.js");
 assert.match(server,/app\.get\("\/apne\/live\/watch\/:showId\/:dateKey", requireApneNativeAccess/);
 assert.match(server,/id="apneLiveVideo"/);
 assert.match(server,/data-apne-provider="apne"/);
 assert.match(server,/data-apne-provider="yodesi"/);
});
test("Home menu and original APNE return links use the production page",()=>{
 const app=source("../public/app.js");
 assert.match(app,/tab\.dataset\.mode === "apne"\) window\.location\.assign\("\/apne\/"\)/);
 assert.match(app,/params\.get\("classic"\) !== "1"/);
 assert.match(app,/window\.location\.replace\("\/apne\/"\)/);
 assert.match(app,/await openApneDaily\(\)/);
});
