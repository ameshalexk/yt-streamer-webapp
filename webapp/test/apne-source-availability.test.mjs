import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {createApneSourceAvailability, summarizeApneSourceError, validateApneSourceManifest} from "../src/lib/apne-source-availability.js";

const episodeUrl = "https://apnetv.xyz/Hindi-Serial/show/286636/Anupamaa";
const makeCache = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"apne-source-test-"));
  return { cacheFile: path.join(dir, "availability.json"), cleanup:()=>fs.rm(dir,{recursive:true,force:true}) };
};

test("missing upstream video differs from transient failure", () => {
  assert.equal(summarizeApneSourceError(new Error("Mediagraming HLS source was not found.")).state,"unavailable");
  assert.equal(summarizeApneSourceError(new Error("HTTP 503 from upstream")).state,"error");
});

test("HLS source verification only certifies a reachable media playlist", async () => {
  let headers;
  const fakeFetch = async (_url, opts) => { headers=opts.headers;return new Response('#EXTM3U\n#EXTINF:6,\nhttps://segments.justfingram.com/video.ts', {status:200}); };
  assert.equal(await validateApneSourceManifest({hlsUrl:'https://cdn.justfingram.com/test.m3u8',referer:'https://justfingram.com/player'},fakeFetch),true);
  assert.equal(headers.Referer,'https://justfingram.com/player');
  await assert.rejects(()=>validateApneSourceManifest({hlsUrl:'https://cdn.justfingram.com/test.m3u8',referer:'x'},async()=>new Response('Forbidden',{status:403})),/unreachable/);
});

test("source availability cache deduplicates requests, limits resolver to one worker and persists only status", async () => {
  const {cacheFile,cleanup}=await makeCache();let clock=10000000,active=0,peak=0,calls=0;
  try {
    const resolve=async (_url,{dateKey}) => {
      calls++;active++;peak=Math.max(peak,active);
      await new Promise(done=>setTimeout(done,12));active--;
      if(dateKey.endsWith('23'))throw new Error('Mediagraming HLS source was not found.');
      return {hlsUrl:'https://cdn.justfingram.com/ok.m3u8',referer:'https://justfingram.com'};
    };
    const opts={cacheFile,resolveEpisode:resolve,validateManifest:async()=>true,now:()=>clock};
    const service=createApneSourceAvailability(opts);
    const [a,b,c]=await Promise.all([
      service.check('anupamaa','2026-09-23',episodeUrl),
      service.check('anupamaa','2026-09-23',episodeUrl),
      service.check('anupamaa','2026-09-29',episodeUrl+'?29')
    ]);
    assert.equal(a.state,'unavailable');assert.deepEqual(a,b);assert.equal(c.state,'link');
    assert.equal(calls,2);assert.equal(peak,1);
    assert.equal((await service.get('anupamaa','2026-09-23',episodeUrl))?.state,'unavailable');
    assert.equal(await service.get('anupamaa','2026-09-23',episodeUrl+'?changed'),null);
    await new Promise(resolve=>setTimeout(resolve,40));
    const content=await fs.readFile(cacheFile,'utf8');assert.doesNotMatch(content,/cdn\.justfingram\.com|apnetv\.xyz/);
    const restored=createApneSourceAvailability(opts);
    const parallel = await Promise.all(Array.from({length:20}, () =>
      restored.get('anupamaa','2026-09-23',episodeUrl)));
    assert.ok(parallel.every(x=>x?.state==='unavailable'), 'concurrent first-read must wait for cache hydration');
    assert.equal((await restored.get('anupamaa','2026-09-29',episodeUrl+'?29'))?.state,'link');
    clock+=5*3600000;
    assert.equal(await restored.get('anupamaa','2026-09-29',episodeUrl+'?29'),null);
    assert.equal(await restored.get('anupamaa','2026-09-23',episodeUrl),null); // unavailable retries after 2 hours
    const force=await restored.check('anupamaa','2026-09-23',episodeUrl,{force:true});
    assert.equal(force.state,'unavailable');assert.equal(calls,3);
  }finally{await cleanup()}
});
