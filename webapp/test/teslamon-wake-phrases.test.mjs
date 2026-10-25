import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const source=await fs.readFile(new URL('../public/teslamon-wake-engine.js',import.meta.url),'utf8');
function rig(){
  const context=vm.createContext({Float32Array,Set,Map,TypeError,Error,Object,performance,setTimeout,
    ort:{env:{wasm:{}},Tensor:class {constructor(type,data,dims){Object.assign(this,{type,data,dims});}}}});
  vm.runInContext(source.replace(/^import \* as ort .*$/m,'').replace(/export /g,'')+
    '\nglobalThis.api={WakeWordEngine,createTeslaMonWakeDetector,MODEL_FILE_MAP};',context);
  let engine;
  const {WakeWordEngine,...api}=context.api;
  WakeWordEngine.prototype.load=async function(){engine=this;};
  WakeWordEngine.prototype.start=async function(){};
  WakeWordEngine.prototype.stop=async function(){};
  return {...api,get engine(){return engine;}};
}
for(const keyword of ['hey_jarvis','hey_luna','alexa']){
  test(keyword+' wakes once, rejects a second simultaneous phrase, and resumes',async()=>{
    const r=rig(),events=[];
    const detector=r.createTeslaMonWakeDetector({onWake:event=>events.push(event)});
    await detector.start();
    assert.deepEqual(Array.from(r.engine.config.keywords),['hey_jarvis','hey_luna','alexa']);
    r.engine._emitter.emit('detect',{keyword,score:0.8});
    r.engine._emitter.emit('detect',{keyword:'alexa',score:0.9});
    assert.equal(events.length,1);
    assert.equal(events[0].keyword,keyword);
    detector.resume();
    r.engine._emitter.emit('detect',{keyword,score:0.8});
    assert.equal(events.length,2);
    await detector.stop();
    r.engine._emitter.emit('detect',{keyword,score:0.8});
    assert.equal(events.length,2);
  });
}
test('only selected heads load and unselected detection cannot wake',async()=>{
  const r=rig(),events=[];
  const detector=r.createTeslaMonWakeDetector({keywords:['hey_luna','hey_luna'],onWake:e=>events.push(e)});
  await detector.start();
  assert.deepEqual(Array.from(r.engine.config.keywords),['hey_luna']);
  r.engine._emitter.emit('detect',{keyword:'alexa',score:1});
  assert.equal(events.length,0);
  r.engine._emitter.emit('detect',{keyword:'hey_luna',score:0.8});
  assert.equal(events.length,1);
  await detector.stop();
});
test('empty or unsupported selection is rejected before microphone/model setup',()=>{
  const r=rig();
  for(const keywords of [[],['unknown'],['toString'],null,'alexa'])
    assert.throws(()=>r.createTeslaMonWakeDetector({keywords}),/supported wake phrase/);
});
test('bundled additional models match pinned provenance, size and hash',async()=>{
  const base=new URL('../public/teslamon-wake-assets/',import.meta.url);
  const manifest=JSON.parse(await fs.readFile(new URL('ADDED_MODELS.json',base)));
  assert.equal(manifest.length,2);
  for(const item of manifest){
    const bytes=await fs.readFile(new URL('models/'+item.file,base));
    assert.equal(bytes.length,item.bytes,item.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.file);
  }
});
