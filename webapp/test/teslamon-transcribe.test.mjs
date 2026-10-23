import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonTranscriber} from '../src/lib/teslamon-transcribe.js';
const config={
  workerRoot:'C:\\Users\\Amesh\\life-recorder-worker',
  release:'phase1-20260912-b',host:'poweralx',python:'/usr/bin/python3'
};
test('No Mac model or remote commands when PowerALX worker not configured',async()=>{
  let invoked=0;
  const t=createTeslaMonTranscriber({workerRoot:'',release:'',runner:async()=>{
    invoked++;return {status:'ok',text:'play movie'};
  }});
  assert.equal(t.available,false);
  assert.deepEqual(await t.transcribe(Buffer.alloc(300),'audio/webm'),
    {status:'unavailable',code:'poweralx_worker_not_configured'});
  assert.equal(invoked,0);
});
test('Reject invalid media before sending data to PowerALX',async()=>{
  let invoked=0;
  const t=createTeslaMonTranscriber({...config,runner:async()=>{invoked++;}});
  assert.equal(t.available,true);
  for(const [bytes,mime] of [
    [Buffer.alloc(99),'audio/webm'],
    [Buffer.alloc(300),'text/html'],
    [Buffer.alloc(300),'application/json'],
    [Buffer.alloc(5*1024*1024+1),'audio/mp4']
  ])assert.equal((await t.transcribe(bytes,mime)).code,'invalid_audio_payload');
  assert.equal(invoked,0);
});
test('Forwards single short audio clip to injected transport unchanged, returns bounded transcript',async()=>{
  let received=null;
  const audio=Buffer.alloc(300,8);
  const t=createTeslaMonTranscriber({...config,runner:async (bytes,mime)=>{
    received={bytes,mime};
    return {status:'ok',text:'play latest MKBHD video'};
  }});
  assert.equal(t.engine,'existing_poweralx_worker');
  assert.deepEqual(await t.transcribe(audio,'audio/webm;codecs=opus'),
    {status:'ok',text:'play latest MKBHD video'});
  assert.equal(received.bytes,audio);
  assert.equal(received.mime,'audio/webm');
});
test('PCM WAV recorded on iPhone is forwarded unchanged, never decoded on Mac',async()=>{
  const audio=Buffer.alloc(2048,42);
  let forwarded=null;
  const t=createTeslaMonTranscriber({...config,runner:async(bytes,mime)=>{
    forwarded={bytes,mime};return {status:'ok',text:'pause'};
  }});
  assert.equal((await t.transcribe(audio,'audio/wav')).text,'pause');
  assert.equal(forwarded.mime,'audio/wav');
  assert.equal(forwarded.bytes,audio);
});
test('Never accepts unbounded/private transport content as a public transcript',async()=>{
  const t=createTeslaMonTranscriber({...config,runner:async()=>({
    status:'ok',text:'private data'.repeat(80),credentials:'SHOULD_NOT_ESCAPE'
  })});
  const reply=await t.transcribe(Buffer.alloc(500),'audio/mp4');
  assert.equal(reply.status,'failed');
  assert.equal(JSON.stringify(reply).includes('SHOULD_NOT_ESCAPE'),false);
});
test('Serializes requests instead of spawning simultaneous PowerALX GPU jobs',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const t=createTeslaMonTranscriber({...config,runner:async()=>{await gate;return {
    status:'ok',text:'pause'
  };}});
  const first=t.transcribe(Buffer.alloc(300),'audio/webm');
  assert.equal((await t.transcribe(Buffer.alloc(300),'audio/webm')).code,'speech_transcriber_busy');
  release();assert.equal((await first).text,'pause');
});
test('Worker offline and cancellation never fall back to local Mac Whisper',async()=>{
  const t=createTeslaMonTranscriber({...config,runner:async()=>({
    status:'unavailable',code:'poweralx_worker_unavailable'
  })});
  assert.deepEqual(await t.transcribe(Buffer.alloc(300),'audio/ogg'),{
    status:'unavailable',code:'poweralx_worker_unavailable'
  });
  const ctrl=new AbortController();ctrl.abort();
  assert.equal((await t.transcribe(Buffer.alloc(300),'audio/ogg',{signal:ctrl.signal})).code,'request_cancelled');
});
test('Reject malformed worker endpoint settings rather than command injection',async()=>{
  for(const overrides of [
    {workerRoot:'C:\\bad; rm -rf'},
    {host:'poweralx;echo unsafe'},
    {release:'../../bad'},
    {python:'python3'}
  ])assert.equal(createTeslaMonTranscriber({...config,...overrides}).available,false);
});

test('Resident PowerALX mode uses the existing transport without a Mac speech model',async()=>{
  const t=createTeslaMonTranscriber({...config,resident:true,runner:async()=>({
    status:'ok',text:'turn on the kitchen lights'})});
  assert.equal(t.available,true);
  assert.equal(t.engine,'resident_poweralx_worker');
  assert.equal((await t.transcribe(Buffer.alloc(400),'audio/webm')).text,
    'turn on the kitchen lights');
});
