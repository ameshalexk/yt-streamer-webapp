import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { youtubeVideoId, createSavedPlaybackLookup } from '../src/lib/saved-playback.js';
test('YouTube IDs accept canonical hosts and reject lookalikes and credentials', () => {
  assert.equal(youtubeVideoId('https://youtu.be/video-a'), 'video-a');
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=video-a'), 'video-a');
  assert.equal(youtubeVideoId('https://youtube.com/shorts/video-a'), 'video-a');
  for (const url of ['https://youtube.com.evil.test/watch?v=a', 'https://user:pass@youtube.com/watch?v=a', 'file:///a', 'https://youtube.com:8443/watch?v=a', 'https://evil.test/?v=a']) assert.equal(youtubeVideoId(url), null);
});
test('saved fallback uses a matching local copy and rejects files outside its cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-saved-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'prepared-cache'); await fs.mkdir(cache);
  const file = path.join(cache, 'video.mp4'); await fs.writeFile(file, 'local fixture');
  let candidate = { title: 'Prepared', duration: 100, filePath: file };
  const lookup = createSavedPlaybackLookup({ dataDir: root, getPrepared: async () => candidate, listProcessed: async () => [], listPlaylists: async () => [] });
  const saved = await lookup('https://youtu.be/video-a'); assert.equal(saved.videoPath, file); assert.equal(saved.audioPath, file);
  const outside = path.join(root, 'outside'); await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(cache, 'escape'));
  candidate = { filePath: path.join(cache, 'escape') }; assert.equal(await lookup('https://youtu.be/video-a'), null);
  candidate = { filePath: outside }; assert.equal(await lookup('https://youtu.be/video-a'), null);
});
