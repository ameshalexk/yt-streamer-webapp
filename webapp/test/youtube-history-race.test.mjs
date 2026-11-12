import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadYoutubeHistory() {');
const end = source.indexOf('\nasync function performYoutubeSearch()', start);
assert.ok(start >= 0 && end > start);

function setup() {
  const pending = [];
  const toasts = [];
  let renders = 0;
  const state = { youtubeHistory: [], youtubeHistoryLoaded: false, youtubeHistoryLoading: false, youtubeHistoryError: '' };
  const context = vm.createContext({
    state, Date, toast: message => toasts.push(message),
    api: { get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    renderYoutubeHistory: () => { renders++; }
  });
  vm.runInContext(source.slice(start, end), context);
  return { state, pending, toasts, context, getRenders: () => renders };
}

test('older history success cannot overwrite newer history', async () => {
  const { state, pending, context, getRenders } = setup();
  const old = context.loadYoutubeHistory();
  const recent = context.loadYoutubeHistory();
  pending[1].resolve([{ id: 'recent' }]);
  await recent;
  const renders = getRenders();
  pending[0].resolve([{ id: 'old' }]);
  await old;
  assert.equal(state.youtubeHistory[0].id, 'recent');
  assert.equal(state.youtubeHistoryLoaded, true);
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(getRenders(), renders);
});

test('older history failure cannot clear newer results or show a stale error', async () => {
  const { state, pending, context, toasts, getRenders } = setup();
  const old = context.loadYoutubeHistory();
  const recent = context.loadYoutubeHistory();
  pending[1].resolve([{ id: 'recent' }]);
  await recent;
  const renders = getRenders();
  pending[0].reject(new Error('obsolete failure'));
  await old;
  assert.equal(state.youtubeHistory[0].id, 'recent');
  assert.equal(state.youtubeHistoryError, '');
  assert.equal(state.youtubeHistoryLoaded, true);
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(toasts.length, 0);
  assert.equal(getRenders(), renders);
});


test('older history success settling first leaves latest refresh pending', async () => {
  const { state, pending, context, getRenders } = setup();
  const old = context.loadYoutubeHistory();
  const recent = context.loadYoutubeHistory();
  pending[0].resolve([{ id: 'old' }]);
  await old;
  assert.equal(state.youtubeHistory.length, 0);
  assert.equal(state.youtubeHistoryLoaded, false);
  assert.equal(state.youtubeHistoryLoading, true);
  const renders = getRenders();
  pending[1].resolve([{ id: 'recent' }]);
  await recent;
  assert.equal(state.youtubeHistory[0].id, 'recent');
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(getRenders(), renders + 1);
});

test('latest history failure wins even when older refresh succeeds first', async () => {
  const { state, pending, context, toasts } = setup();
  const old = context.loadYoutubeHistory();
  const recent = context.loadYoutubeHistory();
  pending[0].resolve([{ id: 'old' }]);
  await old;
  pending[1].reject(new Error('latest failure'));
  await recent;
  assert.equal(state.youtubeHistory.length, 0);
  assert.equal(state.youtubeHistoryLoaded, false);
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(state.youtubeHistoryError, 'latest failure');
  assert.deepEqual(toasts, ['latest failure']);
});

test('three overlapping refreshes ignore both stale completions', async () => {
  const { state, pending, context, toasts, getRenders } = setup();
  const first = context.loadYoutubeHistory();
  const second = context.loadYoutubeHistory();
  const third = context.loadYoutubeHistory();
  pending[1].reject(new Error('stale middle error'));
  await second;
  assert.equal(state.youtubeHistoryLoading, true);
  assert.equal(state.youtubeHistoryError, '');
  pending[2].resolve([{ id: 'latest' }]);
  await third;
  const renders = getRenders();
  pending[0].resolve([{ id: 'first' }]);
  await first;
  assert.equal(state.youtubeHistory[0].id, 'latest');
  assert.equal(state.youtubeHistoryLoaded, true);
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(toasts.length, 0);
  assert.equal(getRenders(), renders);
});

test('latest refresh failure remains authoritative after two older successes', async () => {
  const { state, pending, context, toasts } = setup();
  const first = context.loadYoutubeHistory();
  const second = context.loadYoutubeHistory();
  const third = context.loadYoutubeHistory();
  pending[2].reject(new Error('current failure'));
  await third;
  pending[0].resolve([{ id: 'first' }]);
  pending[1].resolve([{ id: 'second' }]);
  await Promise.all([first, second]);
  assert.equal(state.youtubeHistory.length, 0);
  assert.equal(state.youtubeHistoryLoaded, false);
  assert.equal(state.youtubeHistoryLoading, false);
  assert.equal(state.youtubeHistoryError, 'current failure');
  assert.deepEqual(toasts, ['current failure']);
});
