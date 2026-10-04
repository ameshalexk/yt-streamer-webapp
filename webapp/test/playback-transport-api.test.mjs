import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFileSync} from 'node:child_process';
await import('../public/e-auto.js');

// Exercise real HTTP handlers and FFmpeg with a disposable resolver/media fixture.
test('HTTP playback restores normal/framed JPEG, live fallback, and prepared-cache routes', {timeout:60000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'yt-transport-api-'));
  let child;
  t.after(async()=>{
    if(child && child.exitCode === null) { const ended = new Promise(r=>child.once('exit',r)); child.kill('SIGTERM'); await ended; }
    await fs.rm(root,{recursive:true,force:true});
  });
  const input = path.join(root,'fixture.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-preset','ultrafast','-c:a','aac',input]);
  const resolver = path.join(root,'resolver.mjs');
  await fs.writeFile(resolver,`#!/usr/bin/env node
console.log(JSON.stringify({url:${JSON.stringify(input)},title:'Fixture',duration:3,is_live:process.argv.at(-1).includes('livefixture')}));
`,{mode:0o755});
  const sock = net.createServer(); await new Promise(r=>sock.listen(0,'127.0.0.1',r)); const port=sock.address().port; await new Promise(r=>sock.close(r));
  const base='http://127.0.0.1:'+port;
  let errors='';
  child=spawn(process.execPath,['src/server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:root,LIBRARY_DIR:path.join(root,'library'),APNE_ICLOUD_DIR:path.join(root,'apne'),YOUTUBE_OAUTH_TOKEN_FILE:path.join(root,'oauth'),YTDLP_PATH:resolver,VIDEO_ENCODER:'libx264',CATALOG_COUNTRIES_URL:'http://127.0.0.1:1/disabled'},stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',d=>errors+=d);
  let ready=false;
  for(let i=0;i<100;i++) {try {ready=(await fetch(base+'/api/health')).ok;} catch {} if(ready) break; if(child.exitCode!==null) throw new Error(errors); await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,errors);
  const normal=await fetch(base+'/stream/youtube?url=https://youtube.com/watch?v=vodfixture&buffered=1&height=240&fps=12');
  assert.equal(normal.status,200); assert.equal(normal.headers.get('x-mjpeg-boundary'),'ffmpeg');
  const normalBytes=Buffer.from(await normal.arrayBuffer()); assert.ok(normalBytes.includes(Buffer.from([255,216])));
  const framed=await fetch(base+'/stream/youtube?url=https://youtube.com/watch?v=vodfixture&eauto=1&eautoSession=77&height=240&fps=12&timestamp=1');
  assert.equal(framed.status,200); assert.equal(framed.headers.get('x-eauto-session-id'),'77');
  const parser=new globalThis.YtExperimentalAuto.EajfParser(); const frames=parser.push(new Uint8Array(await framed.arrayBuffer()));
  assert.ok(frames.length>5); assert.equal(frames[0].sessionId,77); assert.equal(frames[0].videoTimestampUs,1_000_000);
  assert.ok(frames.every((f,i)=>f.sequence===i));
  const post=async(route,body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const live=await post('/api/experimental/cyberdash/start',{url:'https://youtube.com/watch?v=livefixture'});
  assert.equal(live.status,409); assert.equal((await live.json()).fallback,'mjpeg');
  const cache=await post('/api/experimental/cyberdash/prepared/start',{id:'missing'});
  assert.equal(cache.status,409); assert.equal((await cache.json()).fallback,'mjpeg');
  const prep=await post('/api/legacy-library/missing/prepare-cdn',{}); assert.equal(prep.status,404);
  const cacheDir=path.join(root,'processed-dash-cache','fixture','video','240'); await fs.mkdir(cacheDir,{recursive:true});
  await fs.writeFile(path.join(cacheDir,'init.m4s'),'isolated-segment');
  const segment=await fetch(base+'/stream/processed-dash/fixture/video/240/init.m4s');
  assert.equal(segment.status,200); assert.equal(segment.headers.get('cache-control'),'public, max-age=31536000, immutable'); assert.equal(await segment.text(),'isolated-segment');
  const escaped=await fetch(base+'/stream/processed-dash/fixture/%2e%2e%2fsecret'); assert.equal(escaped.status,404);
});
