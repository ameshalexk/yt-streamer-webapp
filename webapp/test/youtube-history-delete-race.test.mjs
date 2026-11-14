import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const refresh = source.slice(source.indexOf('async function loadYoutubeHistory() {'), source.indexOf('\nasync function performYoutubeSearch()'));
const mutations = source.slice(source.indexOf('async function removeYoutubeHistoryItem(item) {'), source.indexOf('\n// ---- Channels browser', source.indexOf('async function removeYoutubeHistoryItem(item) {')));

function setup() {
  const gets = [], deletes = [], toasts = [], barriers = [];
  const state = { youtubeHistory: [{ id: 'old' }], youtubeHistoryLoaded: true, youtubeHistoryLoading: false, youtubeHistoryError: '', youtubeHistoryPlayingId: 'old' };
  const context = vm.createContext({ state, watchProgress: { runHistoryMutation(mutation, options) { barriers.push(options?.clearAll ? 'clear' : options?.deletedEntry?.id); return mutation(); } }, Date, encodeURIComponent, confirm: () => true, toast: msg => toasts.push(msg), renderYoutubeHistory: () => {}, api: {
    get: () => new Promise((resolve, reject) => gets.push({ resolve, reject })),
    del: () => new Promise((resolve, reject) => deletes.push({ resolve, reject })),
  } });
  vm.runInContext(refresh + '\n' + mutations, context);
  return { context, state, gets, deletes, toasts, barriers };
}

for (const operation of ['remove', 'clear']) {
  test('pending refresh cannot restore history after successful ' + operation, async () => {
    const { context, state, gets, deletes, barriers } = setup();
    const refreshPromise = context.loadYoutubeHistory();
    const mutationPromise = operation === 'remove'
      ? context.removeYoutubeHistoryItem({ id: 'old' })
      : context.clearYoutubeHistory();
    deletes[0].resolve();
    await mutationPromise;
    assert.deepEqual(barriers, [operation === 'remove' ? 'old' : 'clear']);
    gets[0].resolve([{ id: 'old' }]);
    await refreshPromise;
    assert.deepEqual(Array.from(state.youtubeHistory), []);
    assert.equal(state.youtubeHistoryLoading, false);
    assert.equal(state.youtubeHistoryPlayingId, null);
  });
}
