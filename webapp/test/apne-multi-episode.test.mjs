import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRecentEpisodesFromShowHtml, filterApneEpisodesByMonths } from '../src/lib/apne-daily.js';
import { createApneProgressStore, validEpisode } from '../src/lib/apne-watch-progress.js';

const makeOption = (id, label) => `<option value="_self#@#https://apnetv.xyz/Hindi-Serial/show/${id}/Shayad-Yahi-Hai-Pyaar">${label}</option>`;

test('APNE numbered same-day episodes retain unique IDs and chronological order', () => {
  const html = [makeOption(1,'12th October Episode 14 2026'),makeOption(2,'12th October Episode 15 2026'),
    makeOption(3,'5th October Episode 10 2026'),makeOption(4,'28th September Episode 1 2026')].join('');
  const result=filterApneEpisodesByMonths(parseRecentEpisodesFromShowHtml(html,{name:'Shayad Yahi Hai Pyaar'},50));
  assert.deepEqual(result.map(e=>e.dateKey), ['2026-10-12-e15','2026-10-12-e14','2026-10-05-e10','2026-09-28-e1']);
  assert.deepEqual(result.map(e=>e.airDateKey), ['2026-10-12','2026-10-12','2026-10-05','2026-09-28']);
  assert.deepEqual(result.map(e=>e.episodeNumber), [15,14,10,1]);
  assert.ok(result.every(e=>validEpisode('shayad-yahi-hai-pyaar',e.dateKey)));
  assert.equal(validEpisode('shayad-yahi-hai-pyaar','2026-10-12-e0'),false);
  assert.equal(validEpisode('shayad-yahi-hai-pyaar','2026-10-12-e15/anything'),false);
});

test('APNE single-episode dates are backward-compatible', () => {
  const result=parseRecentEpisodesFromShowHtml(makeOption(3,'12th October 2026'),{name:'Other'},5);
  assert.equal(result[0].dateKey,'2026-10-12');
  assert.equal(result[0].airDateKey,'2026-10-12');
});

test('APNE progress is independent for same-day numbered episodes', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'apne-multiepisode-'));
  try {
    const store=createApneProgressStore({filePath:path.join(dir,'progress.json')});
    await store.mark('shayad-yahi-hai-pyaar','2026-10-12-e14',true);
    await store.mark('shayad-yahi-hai-pyaar','2026-10-12-e15',false);
    assert.equal((await store.get('shayad-yahi-hai-pyaar','2026-10-12-e14')).completed,true);
    assert.equal((await store.get('shayad-yahi-hai-pyaar','2026-10-12-e15')).completed,false);
    assert.equal((await store.list()).length,2);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
