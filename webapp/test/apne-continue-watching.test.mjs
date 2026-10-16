import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const js = fs.readFileSync(new URL('../public/apne/apne-continue-watching.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../public/apne/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/apne/app.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(js, context);
const select = (episodes, shows, limit) =>
  Array.from(context.window.ApneContinueWatching.select(episodes, shows, limit));

const shows = [
  { id:'anupamaa', name:'Anupamaa', recentEpisodes:[{dateKey:'2026-10-15',episodeTitle:'A big day',status:'Available'}] },
  { id:'shayad-yahi-hai-pyaar', name:'Shayad Yahi Hai Pyaar', recentEpisodes:[] },
];
test('Continue Watching combines shows, sorts by most recently played and preserves exact episode ID', () => {
  const result = select([
    {showId:'anupamaa',dateKey:'2026-10-15',positionSeconds:360,durationSeconds:1200,updatedAt:1000,completed:false},
    {showId:'shayad-yahi-hai-pyaar',dateKey:'2026-10-12-e15',positionSeconds:90,durationSeconds:1800,updatedAt:3000,completed:false},
  ], shows, 8);
  assert.equal(result.length,2);
  assert.equal(result[0].dateKey,'2026-10-12-e15');
  assert.equal(result[0].showName,'Shayad Yahi Hai Pyaar');
  assert.equal(result[1].showName,'Anupamaa');
  assert.equal(result[1].percent,30);
  assert.equal(result[1].episodeTitle,'A big day');
});

test('Continue Watching excludes completed, not started, finished, invalid and removed shows', () => {
  const base={showId:'anupamaa',dateKey:'2026-10-15',durationSeconds:100,updatedAt:100};
  const result=select([
    {...base,positionSeconds:10,completed:true},
    {...base,dateKey:'2026-10-14',positionSeconds:4,completed:false},
    {...base,dateKey:'2026-10-13',positionSeconds:98,completed:false},
    {...base,dateKey:'wrong',positionSeconds:35,completed:false},
    {...base,showId:'removed-show',positionSeconds:25,completed:false},
    {...base,dateKey:'2026-10-10',positionSeconds:20,completed:false},
  ], shows);
  assert.equal(result.length,1);
  assert.equal(result[0].dateKey,'2026-10-10');
});
test('Missing duration retains resume time without inventing percent', () => {
  const result=select([{showId:'anupamaa',dateKey:'2026-10-15',positionSeconds:12,durationSeconds:null,updatedAt:8,completed:false}],shows);
  assert.equal(result.length,1);
  assert.equal(result[0].durationSeconds,null);
  assert.equal(result[0].percent,null);
});
test('Limits count and avoids repeated episodes', () => {
  const episodes=Array.from({length:17},(_,n)=>({
    showId:'anupamaa',dateKey:`2026-10-${String(n+1).padStart(2,'0')}`,
    positionSeconds:70,durationSeconds:1000,updatedAt:n+1,completed:false,
  }));
  episodes.push({...episodes[0],positionSeconds:125,updatedAt:50});
  const result=select(episodes,shows,5);
  assert.equal(result.length,5);
  assert.equal(result[0].positionSeconds,125);
  assert.equal(new Set(result.map(e=>e.dateKey)).size,5);
});
test('Home section uses player resume URL and stays hidden for empty histories', () => {
  assert.match(page,/id="continueWatching"[^>]*hidden/);
  assert.match(page,/id="continueRail"/);
  assert.match(page,/apne-continue-watching\.js/);
  assert.match(app,/continueUx\?\.select/);
  assert.match(app,/episodePlayerUrl\(item\.showId,item\.dateKey\)/);
  assert.match(app,/\?resume=1/);
  assert.match(app,/visibilitychange/);
  assert.match(app,/pageshow/);
});
