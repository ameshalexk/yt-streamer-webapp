import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function performYoutubeSearch() {');
const end = source.indexOf('\nasync function streamYoutubeSearchResult(', start);
assert.ok(start >= 0 && end > start);

test('an old search failure cannot clear newer search results or unlock its button', async () => {
  const pending = [];
  const input = { value: 'same', focus() {} };
  const button = { disabled: false, textContent: 'Search' };
  const state = { youtubeSearchQuery: '', youtubeSearchLoading: false, youtubeSearchResults: [], youtubeSearchError: '' };
  const toasts = [];
  let renders = 0;
  const context = vm.createContext({
    state,
    $: selector => selector === '#ytSearchInput' ? input : button,
    api: { get: () => new Promise((resolve, reject) => pending.push({resolve,reject})) },
    renderYoutubeSearch: () => { renders++; },
    toast: message => toasts.push(message),
    encodeURIComponent
  });
  vm.runInContext(source.slice(start, end), context);
  const older = context.performYoutubeSearch();
  const newer = context.performYoutubeSearch();
  assert.equal(pending.length, 2);
  pending[1].resolve({ items: [{ id: 'new' }] });
  await newer;
  assert.equal(state.youtubeSearchResults[0].id, 'new');
  pending[0].reject(new Error('old failure'));
  await older;
  assert.equal(state.youtubeSearchResults[0].id, 'new');
  assert.equal(state.youtubeSearchError, '');
  assert.equal(toasts.length, 0);
  assert.equal(state.youtubeSearchLoading, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Search');
  assert.ok(renders >= 2);
});

test('an old successful response cannot replace a newer query', async () => {
  const pending = [];
  const input = { value: 'first', focus() {} };
  const button = { disabled: false, textContent: 'Search' };
  const state = { youtubeSearchQuery: '', youtubeSearchLoading: false, youtubeSearchResults: [], youtubeSearchError: '' };
  const context = vm.createContext({
    state, $: selector => selector === '#ytSearchInput' ? input : button,
    api: { get: () => new Promise((resolve, reject) => pending.push({resolve,reject})) },
    renderYoutubeSearch: () => {}, toast: () => {}, encodeURIComponent
  });
  vm.runInContext(source.slice(start, end), context);
  const older = context.performYoutubeSearch();
  input.value = 'second';
  const newer = context.performYoutubeSearch();
  pending[1].resolve({items: [{id:'second'}]});
  await newer;
  pending[0].resolve({items: [{id:'first'}]});
  await older;
  assert.equal(state.youtubeSearchResults[0].id, 'second');
});

test('stale failure while latest search is pending keeps loading and does not toast', async () => {
  const pending = [];
  const input = { value: 'first', focus() {} };
  const button = { disabled: false, textContent: 'Search' };
  const state = { youtubeSearchQuery: '', youtubeSearchLoading: false, youtubeSearchResults: [], youtubeSearchError: '' };
  const toasts = [];
  const context = vm.createContext({
    state, $: selector => selector === '#ytSearchInput' ? input : button,
    api: { get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    renderYoutubeSearch: () => {}, toast: message => toasts.push(message), encodeURIComponent
  });
  vm.runInContext(source.slice(start, end), context);
  const older = context.performYoutubeSearch();
  input.value = 'latest';
  const newer = context.performYoutubeSearch();
  pending[0].reject(new Error('obsolete failure'));
  await older;
  assert.equal(state.youtubeSearchLoading, true);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '...');
  assert.equal(state.youtubeSearchError, '');
  assert.deepEqual(toasts, []);
  pending[1].resolve({ items: [{ id: 'latest' }] });
  await newer;
  assert.equal(state.youtubeSearchResults[0].id, 'latest');
  assert.equal(state.youtubeSearchLoading, false);
  assert.equal(button.disabled, false);
});

test('latest failed search can recover on retry despite a stale earlier success', async () => {
  const pending = [];
  const input = { value: 'first', focus() {} };
  const button = { disabled: false, textContent: 'Search' };
  const state = { youtubeSearchQuery: '', youtubeSearchLoading: false, youtubeSearchResults: [], youtubeSearchError: '' };
  const toasts = [];
  const context = vm.createContext({
    state, $: selector => selector === '#ytSearchInput' ? input : button,
    api: { get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    renderYoutubeSearch: () => {}, toast: message => toasts.push(message), encodeURIComponent
  });
  vm.runInContext(source.slice(start, end), context);
  const older = context.performYoutubeSearch();
  input.value = 'second';
  const failed = context.performYoutubeSearch();
  pending[1].reject(new Error('latest failure'));
  await failed;
  assert.equal(state.youtubeSearchError, 'latest failure');
  assert.equal(button.disabled, false);
  pending[0].resolve({ items: [{ id: 'obsolete' }] });
  await older;
  assert.equal(state.youtubeSearchError, 'latest failure');
  assert.equal(state.youtubeSearchResults.length, 0);
  input.value = 'retry';
  const retry = context.performYoutubeSearch();
  pending[2].resolve({ items: [{ id: 'recovered' }] });
  await retry;
  assert.equal(state.youtubeSearchError, '');
  assert.equal(state.youtubeSearchResults[0].id, 'recovered');
  assert.equal(toasts.length, 1);
});
