// Local FFmpeg A/V fixture. Does not contact production or deploy anything.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ytstreamer-live-dash-'));
process.env.DATA_DIR = temp;
process.env.VIDEO_ENCODER = 'libx264';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const {startYouTubeDashSession, getSessionStatus, stopSession} =
  await import('../src/lib/cyberdash-dash.js');
const source = path.join(temp, 'fixture.mp4');
let session = null;
try {
  const made = spawnSync(ffmpeg, [
    '-hide_banner','-loglevel','error', '-f','lavfi','-i','testsrc2=s=320x180:r=24',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t','5','-c:v','libx264','-pix_fmt','yuv420p',
    '-c:a','aac','-shortest','-y',source,
  ], {encoding:'utf8',timeout:30000});
  assert.equal(made.status, 0, made.stderr);
  session = await startYouTubeDashSession({
    videoInput: source, sourceUrl: 'fixture', live:true, height:240, fps:24,
  });
  let ready = null;
  const deadline = Date.now()+25000;
  while (Date.now() < deadline) {
    const status = await getSessionStatus(session.id);
    if (status.error) throw new Error(status.error);
    if (status.manifestReady && status.init.video && status.init.audio &&
        status.available.video.length && status.available.audio.length) {
      ready = status;
      break;
    }
    if (status.done) throw new Error('Encoder ended without complete A/V fragments');
    await delay(150);
  }
  assert.ok(ready, 'Live DASH must produce both H.264 and AAC tracks');
  assert.equal(ready.isLive, true);
  assert.match(ready.manifest.video.codec, /^avc1/);
  assert.match(ready.manifest.audio.codec, /^mp4a/);
  for (const name of [ready.init.video, ready.init.audio, ready.available.video[0], ready.available.audio[0]]) {
    assert.ok((await fs.stat(path.join(temp,'cyberdash-dash',session.id,name))).size > 0, name);
  }
  console.log('PASS live WebCodecs FFmpeg A/V fixture', {
    videoSegments:ready.available.video.length, audioSegments:ready.available.audio.length,
    videoCodec:ready.manifest.video.codec, audioCodec:ready.manifest.audio.codec,
  });
} finally {
  if (session) await stopSession(session.id);
  await fs.rm(temp,{recursive:true,force:true});
}
