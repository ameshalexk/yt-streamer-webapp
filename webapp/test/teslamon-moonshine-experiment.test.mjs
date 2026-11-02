import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonLocalStt} from '../public/teslamon-local-stt.js';

test('Moonshine is available only by explicit model ID; production default is Whisper Tiny',async()=>{
  const normal=createTeslaMonLocalStt({loadImplementation:async()=>{throw new Error('should not load');}});
  assert.equal(normal.getState().selectedModelId,'whisper-tiny.en');
  const lab=createTeslaMonLocalStt({modelId:'moonshine-tiny-streaming',loadImplementation:async()=>{throw new Error('should not load');}});
  assert.equal(lab.getState().selectedModelId,'moonshine-tiny-streaming');
  assert.equal(lab.getState().loaded,false);
});

test('Switching Moonshine and Whisper invalidates the old engine',async()=>{
  let disposed=0;
  class FakeEngine {
    constructor({modelId}) { this.modelId=modelId;this.loaded=false;this.modelInfo=null; }
    async load(){this.loaded=true;this.modelInfo={modelId:this.modelId,label:this.modelId};}
    async transcribe(){return {text:'play YouTube',elapsedMs:12};}
    dispose(){disposed++;}
  }
  const stt=createTeslaMonLocalStt({
    modelId:'moonshine-tiny-streaming',
    loadImplementation:async()=>({VoiceEngine:FakeEngine,decodeRecordedAudio:async()=>new Float32Array([0,0.1])})
  });
  const clip={size:3,arrayBuffer:async()=>new ArrayBuffer(3)};
  const result=await stt.transcribe(clip);
  assert.equal(result.text,'play YouTube');
  await stt.setModel('whisper-tiny.en');
  assert.equal(disposed,1);
  assert.equal(stt.getState().selectedModelId,'whisper-tiny.en');
  assert.equal(stt.getState().loaded,false);
  stt.dispose();
});
