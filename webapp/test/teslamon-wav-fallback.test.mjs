import test from 'node:test';
import assert from 'node:assert/strict';
import {convertTeslaMonAudioToWav} from '../public/teslamon-wav-fallback.js';

class AudioContextStub {
  static closed=0;
  async decodeAudioData(){
    return {numberOfChannels:1,length:16000,sampleRate:16000,
      getChannelData:()=>new Float32Array(16000).fill(.5)};
  }
  async close(){AudioContextStub.closed++;}
}
test('iPhone fallback makes 16-bit mono WAV with valid header and no model',async()=>{
  const wav=await convertTeslaMonAudioToWav(
    new Blob([new Uint8Array(256)],{type:'audio/mp4'}),
    {AudioContext:AudioContextStub});
  assert.equal(wav.type,'audio/wav');
  assert.equal(wav.size,32044);
  const bytes=new DataView(await wav.arrayBuffer());
  assert.equal(bytes.getUint32(24,true),16000);
  assert.equal(bytes.getUint16(22,true),1);
  assert.equal(bytes.getInt16(44,true),16384);
  assert.equal(AudioContextStub.closed,1);
});
test('Fallback rejects malformed audio or excessive lengths',async()=>{
  class HugeAudioContext extends AudioContextStub{
    async decodeAudioData(){return {numberOfChannels:1,length:22*16000,sampleRate:16000};}
  }
  await assert.rejects(convertTeslaMonAudioToWav(
    new Blob([new Uint8Array(256)]),{AudioContext:HugeAudioContext}),
    /wav_fallback_invalid_audio/);
  await assert.rejects(convertTeslaMonAudioToWav(
    new Blob([new Uint8Array(1)]),{AudioContext:AudioContextStub}),
    /wav_fallback_unavailable/);
});
