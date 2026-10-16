import test from "node:test";
import assert from "node:assert/strict";
import "../../webapp/public/apne-mobile-browser.js";
const ux = globalThis.ApneMobileBrowser;
const episodes = [
  {dateKey:"2026-10-15"}, {dateKey:"2026-10-12"}, {dateKey:"2026-10-16"}, {dateKey:"2026-10-15"},
];
test("recent date chips sort actual listed dates and deduplicate", () => {
  assert.deepEqual(ux.recentDates(episodes,2), ["2026-10-16","2026-10-15"]);
});
test("date jump matches exact episode date and preserves duplicate parts", () => {
  assert.equal(ux.selectEpisodes(episodes,{date:"2026-10-15"}).length,2);
  assert.equal(ux.selectEpisodes(episodes,{date:"2026-10-14"}).length,0);
});
test("newest and oldest ordering", () => {
  assert.equal(ux.selectEpisodes(episodes)[0].dateKey, "2026-10-16");
  assert.equal(ux.selectEpisodes(episodes,{order:"oldest"})[0].dateKey,"2026-10-12");
});
test("unwatched excludes completed while retaining in-progress and unseen", () => {
  const progress={"anupamaa:2026-10-16":{completed:true},"anupamaa:2026-10-15":{completed:false}};
  assert.ok(!ux.selectEpisodes(episodes,{onlyUnwatched:true},progress).some(e=>e.dateKey==="2026-10-16"));
  assert.ok(ux.selectEpisodes(episodes,{onlyUnwatched:true},progress).some(e=>e.dateKey==="2026-10-15"));
});
test("invalid date filter cannot hide all episodes", () => {
  assert.equal(ux.selectEpisodes(episodes,{date:"javascript:alert(1)"}).length,4);
});
