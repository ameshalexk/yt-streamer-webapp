import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(file)=>readFileSync(new URL(file,import.meta.url),"utf8");
test("Experimental is directly after APNE Daily on stable menu",()=>{
 const html=source("../public/index.html");
 assert.match(html,/<button class="mode-tab"[^>]+data-mode="apne">APNE Daily<\/button>\s*<a class="experimental-menu-link" href="\/experimental\/"/);
 assert.doesNotMatch(html, /data-mode="experimental"/);
});
test("Experimental serves namespaced static assets and stable back link",()=>{
 const html=source("../public/experimental/index.html");
 assert.match(html,/\/experimental\/app.js\?/);
 assert.match(html,/\/experimental\/styles.css\?/);
 assert.match(html,/\/experimental\/apne-mobile-browser.js\?/);
 assert.match(html,/href="\/\?mode=apne"/);
 assert.match(html,/noindex, nofollow, nosnippet/);
});
test("Experimental uses read-only API calls",()=>{
 const js=source("../public/experimental/app.js");
 assert.match(js,/fetch\("\/api\/apne-daily"/);
 assert.match(js,/fetch\("\/api\/apne\/progress"/);
 assert.doesNotMatch(js,/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
 assert.match(js,/ApneMobileBrowser/);
});
