import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTeslaMonTranscriber} from '../src/lib/teslamon-transcribe.js';

test('unconfigured local STT is unavailable without touching audio',async()=>{
  const stt=createTeslaMonTranscriber({model:undefined});
  assert.equal(stt.available,false);
  const result=await stt.transcribe(Buffer.alloc(800),'audio/webm');
  assert.equal(result.code,'local_stt_not_configured');
});
test('rejects unapproved MIME, missing audio and oversize chunks before running commands',async()=>{
  let ran=0;
  const stt=createTeslaMonTranscriber({
    model:'/does/not/exist',run:async()=>{ran++;}
  });
  for(const [buf,mime] of [
    [Buffer.alloc(999),'application/json'],
    [Buffer.alloc(1),'audio/webm'],
    [Buffer.alloc(5*1024*1024+1),'audio/mp4'],
    [null,'audio/webm']
  ]){
    const result=await stt.transcribe(buf,mime);
    assert.equal(result.code,'invalid_audio');
  }
  assert.equal(ran,0);
});
test('conversion/transcription uses private temporary files and removes recording afterward',async()=>{
  const modelDir=await fs.mkdtemp(path.join(os.tmpdir(),'tm-model-fixture-'));
  const model=path.join(modelDir,'model.bin');
  await fs.writeFile(model,Buffer.alloc(100001),{mode:0o600});
  const directories=new Set();
  let calls=0;
  const run=async(bin,args)=>{
    calls++;
    if(calls===1){
      assert.equal(bin,'ffmpeg-fixture');
      const input=args[args.indexOf('-i')+1];
      assert.equal((await fs.stat(input)).mode&0o077,0);
      directories.add(path.dirname(input));
      await fs.writeFile(args.at(-1),Buffer.alloc(256),{mode:0o600});
    }else{
      assert.equal(bin,'whisper-fixture');
      const out=args[args.indexOf('-of')+1];
      directories.add(path.dirname(out));
      await fs.writeFile(out+'.txt','  pause the video  \n',{mode:0o600});
    }
  };
  try{
    const stt=createTeslaMonTranscriber({
      model,ffmpeg:'ffmpeg-fixture',whisper:'whisper-fixture',run
    });
    assert.equal(stt.available,true);
    const result=await stt.transcribe(Buffer.alloc(1000),'audio/webm;codecs=opus');
    assert.deepEqual(result,{status:'ok',text:'pause the video'});
    assert.equal(calls,2);
    for(const directory of directories)
      await assert.rejects(fs.stat(directory),ex=>ex.code==='ENOENT');
  }finally{await fs.rm(modelDir,{recursive:true,force:true});}
});
