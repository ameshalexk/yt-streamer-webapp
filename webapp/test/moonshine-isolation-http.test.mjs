import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Exercise the real Express route ordering with isolated state and no media jobs.
test('Moonshine isolation is opt-in on the player and absent from ordinary pages/assets', {timeout:30000}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'yt-moonshine-headers-'));
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const cwd=new URL('..',import.meta.url);
  const child=spawn(process.execPath,['src/server.js'],{cwd,env:{...process.env,
    HOST:'127.0.0.1',PORT:String(port),DATA_DIR:root,LIBRARY_DIR:path.join(root,'library'),
    APNE_ICLOUD_DIR:path.join(root,'apne'),YOUTUBE_OAUTH_TOKEN_FILE:path.join(root,'oauth.json'),
    CATALOG_COUNTRIES_URL:'http://127.0.0.1:1/disabled',CATALOG_COUNTRY_PLAYLIST_BASE_URL:'http://127.0.0.1:1/disabled'
  },stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-3000);});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');
      const timeout=setTimeout(()=>child.kill('SIGKILL'),3000);
      await exited;clearTimeout(timeout);
    }
    await fs.rm(root,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<120;i++){
    if(child.exitCode!==null)throw Error(errors);
    try{ready=(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok;}catch{}
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(ready,errors);
  for(const route of ['/?ui=classic&tm_stt_mode=moonshine','/index.html?ui=new&tm_stt_mode=moonshine','/teslamon-moonshine-lab.html']){
    const response=await fetch(base+route);
    assert.equal(response.status,200,route);
    assert.equal(response.headers.get('cross-origin-opener-policy'),'same-origin',route);
    assert.equal(response.headers.get('cross-origin-embedder-policy'),'require-corp',route);
    assert.match(response.headers.get('cache-control'),/no-store/,route);
  }
  for(const route of ['/','/index.html?ui=new','/?tm_stt_mode=whisper','/?tm_stt_mode=moonshine&tm_stt_mode=whisper','/app.js','/teslamon-pet.js']){
    const response=await fetch(base+route);
    assert.equal(response.status,200,route);
    assert.equal(response.headers.get('cross-origin-opener-policy'),null,route);
    assert.equal(response.headers.get('cross-origin-embedder-policy'),null,route);
  }
  const worker=await fetch(base+'/teslamon-moonshine-worker.js');
  assert.equal(worker.headers.get('cross-origin-embedder-policy'),'require-corp');
  assert.match(worker.headers.get('content-type'),/javascript/);
});
