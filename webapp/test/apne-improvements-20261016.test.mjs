import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {validApneThumbnailKey} from '../src/lib/apne-thumbnails.js';
import {filterApneEpisodesByMonths} from '../src/lib/apne-daily.js';
const read=path=>fs.readFileSync(new URL(path,import.meta.url),'utf8');
const context={window:{}};
vm.runInNewContext(read('../public/apne/apne-mobile-browser.js'),context);
const helpers=context.window.ApneMobileBrowser;
const list=(episodes,filters={},progress={})=>Array.from(helpers.selectEpisodes(episodes,filters,progress,'show'));
test('numbered episode previews accept safe exact episode keys and reject unsafe keys',()=>{
  assert.equal(validApneThumbnailKey('show','2026-10-12-e15'),true);
  assert.equal(validApneThumbnailKey('show','2026-10-12-e0'),false);
  assert.equal(validApneThumbnailKey('show','2026-10-12-e15/..'),false);
  assert.equal(validApneThumbnailKey('show','2026-02-30-e15'),false);
  assert.match(read('../public/apne/app.js'),/data-preview-valid/);
  assert.match(read('../public/apne/app.js'),/e\[1-9\]/);
});
test('multipart episodes sort numerically and independently of lexicographic suffix',()=>{
  const episodes=[6,9,10,8,15].map(n=>({dateKey:`2026-10-12-e${n}`,episodeNumber:n}));
  assert.deepEqual(list(episodes).map(x=>x.episodeNumber),[15,10,9,8,6]);
  assert.deepEqual(list(episodes,{order:'oldest'}).map(x=>x.episodeNumber),[6,8,9,10,15]);
});
test('status filter distinguishes watched, in progress, and never started',()=>{
  const episodes=[1,2,3].map(n=>({dateKey:`2026-10-0${n}`}));
  const progress={
    'show:2026-10-01':{positionSeconds:0,completed:false},
    'show:2026-10-02':{positionSeconds:200,completed:false},
    'show:2026-10-03':{positionSeconds:1200,completed:true},
  };
  assert.equal(list(episodes,{watchFilter:'not-started'},progress).length,1);
  assert.equal(list(episodes,{watchFilter:'in-progress'},progress)[0].dateKey,'2026-10-02');
  assert.equal(list(episodes,{watchFilter:'watched'},progress)[0].dateKey,'2026-10-03');
  assert.equal(list(episodes,{onlyUnwatched:true},progress).length,2);
});
test('default history expands to 12 months; catalog and search remain bounded',()=>{
  const episodes=[{dateKey:'2026-10-12'},{dateKey:'2026-04-20'},{dateKey:'2025-10-01'}];
  assert.deepEqual(filterApneEpisodesByMonths(episodes).map(e=>e.dateKey),['2026-10-12','2026-04-20']);
  const server=read('../src/lib/apne-daily.js');
  assert.match(server,/APNE_HISTORY_MONTHS = 12/);
  assert.match(server,/APNE_HISTORY_FETCH_LIMIT = 500/);
});
test('new catalog search and adjacent episode links use only first-party URLs',()=>{
  const index=read('../public/apne/index.html');
  const app=read('../public/apne/app.js');
  const nav=read('../public/apne-episode-nav.js');
  const server=read('../src/server.js');
  assert.match(index,/id="episodeSearch"/);
  assert.match(index,/id="watchFilter"/);
  assert.match(app,/function renderSearch/);
  assert.match(nav,/\/api\/apne-daily/);
  assert.match(nav,/\/apne\/live\/watch\//);
  assert.match(nav,/video\.addEventListener\('ended'/);
  assert.match(server,/id="apneEpisodeNavigation"/);
});
test('private thumbnail caching stays behind authenticated routes',()=>{
  const server=read('../src/server.js');
  for(const path of ['/apne/thumb','/apne/live-thumb','/apne/official-thumb'])
    assert.match(server,new RegExp('app\\.get\\("'+path+'/.+requireApneNativeAccess'));
  assert.match(server,/private, max-age=1800/);
  assert.doesNotMatch(read('../public/apne/app.js'),/method:\s*["']POST/);
});
test('quality text is derived from decoded media height rather than assumed HD',()=>{
  const ui=read('../public/apne-episode-ui.js');
  assert.match(ui,/video\.videoHeight/);
  assert.match(ui,/height >= 720/);
  assert.match(ui,/Below 720p/);
});
