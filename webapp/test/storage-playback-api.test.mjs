import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

test('storage HTTP policy, pins, completion and saved-video extraction fallback work with isolated files', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-storage-api-'));
  const videoDir = path.join(root, 'processed-library', 'fixture'); await fs.mkdir(videoDir, { recursive: true });
  const media = path.join(videoDir, 'video_240.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-c:a','aac',media]);
  await fs.writeFile(path.join(videoDir, 'info.json'), JSON.stringify({ id: 'fixture', title: 'Fixture', duration: 2, originalYoutubeId: 'fixture' }));
  const resolver = path.join(root, 'resolver.mjs');
  await fs.writeFile(resolver, '#!/usr/bin/env node\nif(process.argv.includes("--version")) console.log("2026.10.01"); else { console.error("Unable to extract fixture"); process.exit(1); }\n', { mode: 0o755 });
  const socket = net.createServer(); await new Promise(r => socket.listen(0,'127.0.0.1',r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOST:'127.0.0.1', PORT:String(port), DATA_DIR:root, LIBRARY_DIR:path.join(root,'library'), APNE_ICLOUD_DIR:path.join(root,'apne'), YTDLP_PATH:resolver, YTDLP_FALLBACK_PATH:'', VIDEO_ENCODER:'libx264', CATALOG_COUNTRIES_URL:'http://127.0.0.1:1/disabled' }, stdio:['ignore','ignore','pipe'] });
  let errors = ''; child.stderr.on('data', d => errors += d);
  t.after(async () => { if(child.exitCode === null) { const done = new Promise(r => child.once('exit',r)); child.kill('SIGTERM'); await done; } await fs.rm(root,{recursive:true,force:true}); });
  let ready = false;
  for(let i=0; i<100; i++) { try { ready = (await fetch(base+'/api/health')).ok; } catch {} if(ready) break; if(child.exitCode !== null) throw new Error(errors); await new Promise(r => setTimeout(r,50)); }
  assert.ok(ready, errors);
  const request = (url, method, body) => fetch(base+url, { method, headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  const status = await (await fetch(base+'/api/storage')).json(); assert.equal(status.policy.enabled, false); assert.ok(status.usage.libraryBytes > 0);
  assert.equal((await request('/api/storage/policy','PATCH',{enabled:'yes'})).status,400);
  assert.equal((await request('/api/storage/downloads/fixture','PATCH',{pinned:true})).status,200);
  assert.equal((await request('/api/storage/downloads/fixture/watched','POST',{completed:false})).status,400);
  assert.equal((await request('/api/storage/downloads/fixture/watched','POST',{completed:true})).status,200);
  const downloads = (await (await fetch(base+'/api/storage')).json()).downloads; assert.equal(downloads[0].pinned,true); assert.ok(downloads[0].watchedAt);
  const preview = await (await request('/api/storage/cleanup','POST',{apply:false})).json(); assert.deepEqual(preview.candidates,[]);
  assert.equal((await request('/api/storage/cleanup','POST',{apply:true,ids:['fixture']})).status,409); await fs.access(media);
  const metadata = await (await fetch(base+'/api/youtube/info?url=https://youtu.be/fixture')).json(); assert.equal(metadata.savedFallback,true); assert.equal(metadata.title,'Fixture');
  const frames = await fetch(base+'/stream/youtube?url=https://youtu.be/fixture&buffered=1&height=240&fps=12'); assert.equal(frames.status,200);
  assert.ok(Buffer.from(await frames.arrayBuffer()).includes(Buffer.from([255,216])));
  const sound = await fetch(base+'/stream/audio/youtube?url=https://youtu.be/fixture'); assert.equal(sound.status,200); assert.ok((await sound.arrayBuffer()).byteLength > 100);
  const tools = await (await fetch(base+'/api/youtube/extractor/status')).json(); assert.equal(tools.candidates[0].available,true);
});
