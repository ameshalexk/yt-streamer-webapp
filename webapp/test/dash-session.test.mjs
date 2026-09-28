import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { config } from '../src/config.js';
import path from 'node:path';
import { buildDashArgs, serveSession, serveFile, remove, heartbeat, shutdown, activeCount } from '../src/lib/dash.js';

const app = express(); app.use(express.json());
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-test-'));
const fixture = path.join(fixtureDir, 'fixture.mp4');
execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-stream_loop', '5', '-i', path.resolve('public/tesla-probe-h264.mp4'), '-c', 'copy', fixture]);
app.get('/start', (req, res) => serveSession(req, res, { input: fixture, params: { fps: 24, height: 360 } }));
app.get('/stream/dash/:id/:file', serveFile); app.post('/api/dash/:id', heartbeat);
app.delete('/api/dash/:id', async (req, res) => { await remove(req.params.id); res.sendStatus(204); });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await shutdown(); await fs.rm(fixtureDir, { recursive: true, force: true }); await new Promise(resolve => server.close(resolve)); });

test('DASH args seek both source tracks, preserve request headers, and bound segment storage', () => {
  const args = buildDashArgs({ input: 'https://example.test/video', audioInput: 'https://example.test/audio', startAt: 12, params: { height: 480, fps: 24 }, userAgent: 'fixture-agent', referer: 'https://example.test/' }, '/tmp/test.mpd');
  assert.equal(args.filter(x => x === '-ss').length, 2);
  assert.equal(args.filter(x => x === 'fixture-agent').length, 2);
  assert.ok(args.includes('1:a:0?')); assert.ok(args.includes('aac')); assert.ok(args.includes('0'));
  assert.equal(args[args.indexOf('-window_size') + 1], '20');
  assert.equal(args[args.indexOf('-bf') + 1], '0');
});

test('real encoder session produces MPD and fMP4, rejects traversal, deletes output', async () => {
  const response = await fetch(`${base}/start`);
  assert.equal(response.status, 200);
  const { id, manifestUrl } = await response.json();
  assert.equal(activeCount(), 1);
  const mpd = await (await fetch(base + manifestUrl)).text();
  assert.match(mpd, /<MPD/); assert.match(mpd, /avc1\./); assert.match(mpd, /mp4a\.40\.2/);
  const init = await fetch(`${base}/stream/dash/${id}/init-stream0.m4s`);
  assert.equal(init.status, 200); assert.ok((await init.arrayBuffer()).byteLength > 100);
  assert.equal((await fetch(`${base}/stream/dash/${id}/%2e%2e%2fsecret`)).status, 404);
  const state = await fetch(`${base}/api/dash/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: 0, paused: true }) });
  assert.equal(state.status, 200);
  await new Promise(resolve => setTimeout(resolve, 500));
  const pausedManifest = await (await fetch(base + manifestUrl)).text();
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await (await fetch(base + manifestUrl)).text(), pausedManifest);
  await fetch(`${base}/api/dash/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: 1, paused: false }) });
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.notEqual(await (await fetch(base + manifestUrl)).text(), pausedManifest, 'encoder resumes segment production after pause');
  await fetch(`${base}/api/dash/${id}`, { method: 'DELETE' });
  assert.equal(activeCount(), 0);
  assert.equal((await fetch(base + manifestUrl)).status, 404);
});

test('cancelling startup releases its reserved session', async () => {
  const abort = new AbortController();
  const request = fetch(`${base}/start`, { signal: abort.signal }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 50)); abort.abort(); await request;
  const deadline = Date.now() + 2500;
  while (activeCount() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(activeCount(), 0);
});
