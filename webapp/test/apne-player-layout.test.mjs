import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const p=process.env.APNE_SERVER_LAYOUT_TEST_PATH ||
  path.resolve(import.meta.dirname,'../src/server.js');
const source=await fs.readFile(p,'utf8');
const start=source.indexOf('app.get("/apne/live/watch/:showId/:dateKey"');
const end=source.indexOf('app.get("/apne/live/playlist/:showId/:dateKey.m3u8"',start);
assert.ok(start > 0 && end > start);
const page=source.slice(start,end);

test('APNE and YoDesi render in one top video slot before source controls',()=>{
  const elements=['id="apneLiveVideo"','id="apneEmbedStage"','id="apnePartButtons"','id="apneEpisodeControls"'];
  const offsets=elements.map(id=>page.indexOf(id));
  assert.ok(offsets.every(offset=>offset>=0), 'All top video and source controls must exist');
  assert.deepEqual([...offsets].sort((a,b)=>a-b),offsets,
    'Video and embedded-player slot precede provider/download control panel');
  for(const id of elements)assert.equal(page.split(id).length-1,1,'Only one '+id);
});

test('same video size for native player and embedded player',()=>{
  assert.match(page,/video,\.apne-embed-stage\{[^}]*width:100%/);
  assert.match(page,/video,\.apne-embed-stage\{[^}]*aspect-ratio:16\/9/);
  assert.match(page,/\.apne-embed-stage\[hidden\],video\[hidden\]\{display:none!important\}/);
  assert.match(page,/\.apne-embed-stage iframe\{width:100%;height:100%/);
});

test('download controls remain present, beneath both video choices',()=>{
  assert.match(page,/data-apne-provider="apne"/);
  assert.match(page,/data-apne-provider="yodesi"/);
  assert.match(page,/id="apneDownloadMac"/);
  assert.match(page,/id="apneStreamMac"/);
  assert.ok(page.indexOf('id="apneDownloadMac"')>page.indexOf('id="apneEmbedStage"'));
});
