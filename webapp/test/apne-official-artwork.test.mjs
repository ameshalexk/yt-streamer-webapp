import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {officialArtworkEpisode,parseSkyEpisodeImages,createApneOfficialArtwork} from '../src/lib/apne-official-artwork.js';

const id='3bbcd6d7-9312-4497-88f6-2cf1cd9f5714';
const html=(range=[2150,2151,2152,2153,2154,2155])=>range.map(n=>`<div><img src="https://imageservice.sky.com/uuid/${id}/16-9/500" /></div><div data-testid="episode-card-number-${n}">Episode ${n}</div>`).join('');

test('official artwork only applies to the six explicitly matched September episodes',()=>{
 for(let day=23;day<=28;day++)assert.equal(officialArtworkEpisode('anupamaa',`2026-09-${day}`),2150+day-23);
 for(const [s,d] of [['seher','2026-09-25'],['anupamaa','2026-09-22'],['anupamaa','2026-10-14'],['anupamaa','../etc/passwd']])assert.equal(officialArtworkEpisode(s,d),null);
});

test('extract episode-number matched 16:9 images from official catalog, not arbitrary links',()=>{
 const out=parseSkyEpisodeImages(html());
 assert.equal(out.size,6);assert.equal(out.get(2150),id);
 assert.equal(out.get(2155),id);
 assert.throws(()=>parseSkyEpisodeImages('X'.repeat(1300000)),/Invalid official/);
 assert.equal(parseSkyEpisodeImages(html([2150]).replaceAll('imageservice.sky.com','evil.example')).size,0);
});

test('poster service creates a small cached JPEG, never downloads a video, and uses strict hosts',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'apne-official-test-'));
 const calls=[];
 const fetchImpl=async(url)=>{
  calls.push(url);
  if(url.startsWith('https://www.sky.com/watch/'))return new Response(html(),{status:200,headers:{'content-type':'text/html'}});
  if(url.startsWith('https://imageservice.sky.com/uuid/'))return new Response(Buffer.concat([Buffer.from([255,216]),Buffer.alloc(150,123),Buffer.from([255,217])]),{status:200,headers:{'content-type':'image/jpeg'}});
  throw Error('unexpected origin '+url);
 };
 try{
  const service=createApneOfficialArtwork({cacheDir:path.join(folder,'anupamaa'),fetchImpl});
  assert.equal((await service.request('other','2026-09-25')).status,'missing');
  assert.equal((await service.request('anupamaa','2026-09-25')).status,'pending');
  for(let i=0;i<40;i++){if((await service.request('anupamaa','2026-09-25')).status==='ready')break;await new Promise(r=>setTimeout(r,12))}
  const result=await service.request('anupamaa','2026-09-25');assert.equal(result.status,'ready');
  assert.ok(result.file.endsWith('2026-09-25-official-v1.jpg'));
  assert.equal((await fs.stat(result.file)).size,154);
  assert.equal(calls.length,2); // exactly one listing and one tiny JPEG, no MP4
  assert.equal((await service.request('anupamaa','2026-09-25')).status,'ready');assert.equal(calls.length,2);
 }finally{await fs.rm(folder,{recursive:true,force:true})}
});
