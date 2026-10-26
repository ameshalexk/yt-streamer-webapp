import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const game = path.join(root, 'games');
const read = file => readFile(path.join(game, file));

test('the Streamer immutable package contains the complete independently hosted game', async () => {
  const manifest = JSON.parse(await read('assets-manifest.json'));
  assert.equal(manifest.transformers, '3.8.1');
  assert.equal(manifest.model, 'Xenova/whisper-tiny.en');
  assert.equal(manifest.revision, '79fb389fc764e7c395bd330e9531d9d32ada7049');
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const bytes = await read(relative);
    assert.equal(bytes.length, expected.bytes, relative + ' size');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, relative + ' SHA-256');
  }
  for (const relative of ['index.html', 'styles.css', 'app.js', 'audio-worklet.js',
    'audio-capture.js','voice-engine.js','voice-worker.js','model-cache-status.js',
    'voice-ui.js','recorded-audio.js','phrase-matcher.js','README.md']) {
    assert.ok((await stat(path.join(game, relative))).size > 0, 'missing game release file ' + relative);
  }
});

test('both pages import the same game-owned STT implementation and model URL', async () => {
  const pet = await readFile(path.join(root,'teslamon-pet.js'),'utf8');
  const adapter = await readFile(path.join(root,'teslamon-local-stt.js'),'utf8');
  const worker = await read('voice-worker.js').then(bytes => bytes.toString('utf8'));
  assert.match(pet, /createTeslaMonLocalStt/);
  assert.doesNotMatch(pet, /post\(['"]\/api\/teslamon\/transcribe/);
  assert.ok(pet.includes("teslamon-local-stt.js?v=20261025-stt-models1"));
  assert.ok(adapter.includes("import('./games/voice-engine.js?v=20261025-stt-models1')"));
  assert.ok(adapter.includes("import('./games/recorded-audio.js?v=20261024-shared-stt1')"));
  assert.match(worker, /new URL\('\.\/models\/', import\.meta\.url\)/);
  assert.match(worker, /numThreads = 1/);
  assert.match(worker, /allowRemoteModels = false/);
  const gameApp = await read('app.js').then(bytes => bytes.toString('utf8'));
  assert.doesNotMatch(gameApp, /\/api\/teslamon\/|\/api\/health|YTStreamerMediaAgent/);
});


test('base quality option ships only pinned same-origin q8 assets',async()=>{
  const manifest=JSON.parse(await read('base-model-manifest.json'));
  assert.equal(manifest.model,'Xenova/whisper-base.en');
  assert.equal(manifest.revision,'95bf40a508535962c6483ead40270b2e32267508');
  assert.equal(Object.keys(manifest.files).length,7);
  for(const [relative,expected] of Object.entries(manifest.files)){
    const bytes=await read(relative);
    assert.equal(bytes.length,expected.bytes,relative);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expected.sha256,relative);
    assert.ok(expected.source.includes('/'+manifest.revision+'/'));
  }
});
