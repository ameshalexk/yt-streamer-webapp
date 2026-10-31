import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecentEpisodesFromShowHtml, filterApneEpisodesByMonths, parseApneDateLabel, episodePageState } from '../src/lib/apne-daily.js';

const ep = (id,label) => '<option value="_self#@#https://apnetv.xyz/Hindi-Serial/show/' + id + '/Shayad-Yahi-Hai-Pyaar">' + label + '</option>';

test('APNE differentiates numbered episodes on the same date', () => {
  const html = [ep(3,'12th October Episode 13 2026'),ep(5,'12th October Episode 15 2026'),
    ep(4,'12th October Episode 14 2026'),ep(1,'28th September Episode 1 2026')].join('');
  const data = filterApneEpisodesByMonths(parseRecentEpisodesFromShowHtml(html,{name:'Shayad Yahi Hai Pyaar'},20));
  assert.deepEqual(data.map(e=>e.dateKey),['2026-10-12-e15','2026-10-12-e14','2026-10-12-e13','2026-09-28-e1']);
  assert.deepEqual(data.map(e=>e.episodeNumber),[15,14,13,1]);
  assert.equal(new Set(data.map(e=>e.dateKey)).size,4);
  assert.equal(data[0].airDateKey,'2026-10-12');
});

test('APNE standard dated episodes keep their original IDs', () => {
  const data = parseRecentEpisodesFromShowHtml(ep(1,'16th October 2026'),{name:'Anupamaa'},10);
  assert.equal(data[0].dateKey,'2026-10-16');
  assert.equal(data[0].airDateKey,'2026-10-16');
  assert.equal(parseApneDateLabel('12th October Episode 14 2026').episodeNumber,14);
  assert.equal(parseApneDateLabel('12th October Episode 0 2026'),null);
});

test('APNE includes current labels with the year before and after the episode number', () => {
  const current = [25,24,23,22,21].map(n=>ep(287793+n,`26th October 2026 Episode ${n} 2026`));
  const data = parseRecentEpisodesFromShowHtml([
    ...current,
    ep(287570,'19th October Episode 20 2026'),
    ep(286829,'28th September Episode 1 2026'),
  ].join(''),{name:'Shayad Yahi Hai Pyaar'},100);
  assert.deepEqual(data.map(e=>e.episodeNumber),[25,24,23,22,21,20,1]);
  assert.equal(data[0].dateKey,'2026-10-26-e25');
  assert.equal(data[0].airDateKey,'2026-10-26');
  assert.equal(data[0].url,'https://apnetv.xyz/Hindi-Serial/show/287818/Shayad-Yahi-Hai-Pyaar');
  assert.equal(data.at(-1).dateKey,'2026-09-28-e1');
  assert.equal(data.at(-1).url,'https://apnetv.xyz/Hindi-Serial/show/286829/Shayad-Yahi-Hai-Pyaar');
});

test('APNE duplicated-year labels reject conflicting years and invalid episode numbers', () => {
  for(const label of [
    '26th October 2025 Episode 25 2026',
    '26th October 2026 2026',
    '26th October 2026 Episode 0 2026',
    '26th October 2026 Episode -1 2026',
    '26th October 2026 Episode 25 2026 unrelated text',
  ]) assert.equal(parseApneDateLabel(label),null,label);
});


test('numbered APNE episodes retain local download controls but never match generic YoDesi dates', async () => {
  const state = await episodePageState('anupamaa', '2026-10-16-e15');
  assert.equal(state.dateKey, '2026-10-16-e15');
  assert.deepEqual(state.sources.map(item => item.id), ['apne']);
  assert.equal(typeof state.download.status, 'string');
  await assert.rejects(() => episodePageState('anupamaa','2026-10-16-e0'), /Invalid APNE episode/);
});
