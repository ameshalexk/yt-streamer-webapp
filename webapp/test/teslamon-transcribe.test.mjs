import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTeslaMonTranscriber,runTeslaMonSpeechCommand} from '../src/lib/teslamon-transcribe.js';

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

test('already cancelled audio never runs conversion',async()=>{
 const controller=new AbortController();controller.abort();let ran=0;
 const stt=createTeslaMonTranscriber({model:'/fixture/model',run:async()=>{ran++;}});
 assert.equal((await stt.transcribe(Buffer.alloc(1000),'audio/webm',{signal:controller.signal})).code,'transcription_cancelled');
 assert.equal(ran,0);
});
test('cancellation during conversion prevents whisper and deletes temporary recordings',async()=>{
 const modelDir=await fs.mkdtemp(path.join(os.tmpdir(),'tm-cancel-model-'));
 const model=path.join(modelDir,'model.bin');await fs.writeFile(model,Buffer.alloc(100001));
 let calls=0,input;const controller=new AbortController();
 try{
  const stt=createTeslaMonTranscriber({model,run:async(bin,args)=>{
   calls++;input=args[args.indexOf('-i')+1];controller.abort();
  }});
  const result=await stt.transcribe(Buffer.alloc(1000),'audio/webm',{signal:controller.signal});
  assert.equal(result.code,'transcription_cancelled');assert.equal(calls,1);
  await assert.rejects(fs.stat(path.dirname(input)),e=>e.code==='ENOENT');
 }finally{await fs.rm(modelDir,{recursive:true,force:true});}
});


test('speech command cancellation waits for child exit before caller cleanup',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tm-child-close-'));
 const marker=path.join(dir,'exited');const controller=new AbortController();
 // Synthetic local Node process writes a marker while handling SIGTERM, then
 // exits. No microphone, media binary, model or external service is involved.
 const script=`const fs=require('node:fs');process.on('SIGTERM',()=>{setTimeout(()=>{fs.writeFileSync(process.argv[1],'done');process.exit(0);},30)});fs.writeFileSync(process.argv[1]+'.ready','ready');setInterval(()=>{},1000);`;
 try{
  const pending=runTeslaMonSpeechCommand(process.execPath,['-e',script,marker],{signal:controller.signal});
  const rejection=assert.rejects(pending,/transcription_cancelled/);
  for(let i=0;i<100;i++){try{await fs.stat(marker+'.ready');break;}catch{await new Promise(r=>setTimeout(r,10));}}
  controller.abort();await rejection;
  assert.equal(await fs.readFile(marker,'utf8'),'done');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
