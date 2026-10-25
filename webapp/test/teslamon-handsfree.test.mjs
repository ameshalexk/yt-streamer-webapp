import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeslaMonHandsFree} from '../public/teslamon-handsfree.js';

const settle = async () => {await new Promise(resolve=>setImmediate(resolve));};
function rig(overrides={}) {
  const events=[],uploads=[],captures=[],monitors=[];
  let wake=()=>{},detectorOptions=null,detectorPauses=0,detectorResumes=0,detectorStops=0,asked=0,stopped=0;
  let next=0;
  const jobs=new Map();
  const timers={
    setTimeout(fn,ms){const id=++next;jobs.set(id,{fn,ms});return id;},
    clearTimeout(id){jobs.delete(id);},
    run(ms){for(const [id,job] of [...jobs])if(job.ms===ms){jobs.delete(id);job.fn();}}
  };
  const clone={
    getTracks:()=>[{stop(){stopped++;}}],
    getAudioTracks:()=>[{readyState:'live',stop(){stopped++;}}],
  };
  const track={
    readyState:'live',listeners:new Map(),
    addEventListener(name,fn){this.listeners.set(name,fn);},
    removeEventListener(name,fn){if(this.listeners.get(name)===fn)this.listeners.delete(name);},
    stop(){stopped++;}
  };
  const stream={
    clone:()=>clone,
    getTracks:()=>[track],getAudioTracks:()=>[track],
  };
  const detector={
    async start(){return true;},
    async stop(){detectorStops++;},
    pause(){detectorPauses++;},
    resume(){detectorResumes++;}
  };
  const handsfree=createTeslaMonHandsFree({
    getUserMedia:async options=>{
      asked++;assert.deepEqual(options,{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      return overrides.permission?overrides.permission():stream;
    },
    createDetector:async opts=>{detectorOptions=opts;wake=opts.onWake;return detector;},
    createCapture:opts=>{
      const capture={
        opts,started:0,released:0,cancelled:0,
        async start(){this.started++;await opts.getUserMedia();opts.onState({state:'recording'});return true;},
        release(){this.released++;opts.onState({state:'complete'});opts.onAudio(new Blob(['command'],{type:'audio/webm'}));},
        cancel(){this.cancelled++;opts.onState({state:'cancelled'});}
      };
      captures.push(capture);return capture;
    },
    createSilenceMonitor:opts=>{
      const monitor={opts,started:0,stopped:0,async start(){this.started++;return true;},stop(){this.stopped++;}};
      monitors.push(monitor);return monitor;
    },
    onAudio:async(blob,ctx)=>{
      uploads.push({blob,ctx});if(overrides.onAudio)await overrides.onAudio(blob,ctx);
    },
    onState:ev=>events.push(ev),
    timers,
    cooldownMs:1500,
    ...(overrides.settings||{})
  });
  return {handsfree,events,uploads,captures,monitors,timers,stream,track,
    wake:metadata=>wake(metadata),get detectorOptions(){return detectorOptions;},get asked(){return asked;},get stopped(){return stopped;},
    get paused(){return detectorPauses;},get resumed(){return detectorResumes;},get detectorStops(){return detectorStops;}};
}

test('default Off never requests mic; user enable reaches local listening and Off stops tracks',async()=>{
  const h=rig();
  assert.equal(h.handsfree.state,'off');
  assert.equal(h.asked,0);
  await h.handsfree.enable();
  assert.equal(h.asked,1);
  assert.equal(h.handsfree.state,'listening');
  assert.match(h.events.at(-1).message,/Hey Jarvis/);
  h.handsfree.disable();
  assert.equal(h.handsfree.state,'off');
  assert.equal(h.stopped,1);
  assert.equal(h.handsfree.enabled,false);
  await settle();
  assert.equal(h.detectorStops,1);
});

test('one wake creates one bounded command; speech end submits once then resumes wake detection',async()=>{
  const h=rig();
  await h.handsfree.enable();
  h.wake();h.wake();
  await settle();
  assert.equal(h.captures.length,1);
  assert.equal(h.captures[0].opts.maxDurationMs,12_000);
  assert.equal(h.handsfree.state,'recording');
  h.monitors[0].opts.onSpeechEnd();
  h.monitors[0].opts.onSpeechEnd();
  await settle();
  assert.equal(h.captures[0].released,1);
  assert.equal(h.uploads.length,1);
  assert.equal(h.handsfree.state,'processing');
  h.timers.run(1500);
  assert.equal(h.handsfree.state,'listening');
  assert.ok(h.resumed>=1);
  h.handsfree.disable();
});

test('Off during processing aborts and prohibits future wake/submission',async()=>{
  let finish;
  const pending=new Promise(resolve=>finish=resolve);
  const h=rig({onAudio:()=>pending});
  await h.handsfree.enable();
  h.wake();await settle();
  h.monitors[0].opts.onSpeechEnd();
  await settle();
  assert.equal(h.uploads.length,1);
  const signal=h.uploads[0].ctx.signal;
  h.handsfree.disable();
  assert.equal(signal.aborted,true);
  assert.equal(h.handsfree.state,'off');
  finish();
  await settle();
  h.timers.run(1500);
  h.wake();
  assert.equal(h.captures.length,1);
  assert.equal(h.uploads.length,1);
});

test('no-speech cancel suppresses uploading and returns to wake after cooldown',async()=>{
  const h=rig();
  await h.handsfree.enable();
  h.wake();await settle();
  h.monitors[0].opts.onNoSpeech();
  await settle();
  assert.equal(h.uploads.length,0);
  assert.equal(h.captures[0].cancelled,1);
  h.timers.run(1500);
  assert.equal(h.handsfree.state,'listening');
  h.handsfree.disable();
});

test('permission denial and microphone disconnect fail closed',async()=>{
  const denied=rig({permission:()=>{const e=new Error('Permission denied');e.name='NotAllowedError';throw e;}});
  assert.equal(await denied.handsfree.enable(),false);
  assert.equal(denied.handsfree.state,'error');
  assert.match(denied.events.at(-1).message,/permission denied/i);
  const disconnected=rig();
  await disconnected.handsfree.enable();
  disconnected.track.listeners.get('ended')?.();
  assert.equal(disconnected.handsfree.state,'error');
  assert.equal(disconnected.handsfree.enabled,false);
});

test('Off while getUserMedia permission is pending stops a late grant',async()=>{
  let grant;
  const waiting=new Promise(resolve=>grant=resolve);
  const h=rig({permission:()=>waiting});
  const pending=h.handsfree.enable();
  h.handsfree.disable();
  grant(h.stream);
  assert.equal(await pending,false);
  assert.equal(h.stopped,1);
  assert.equal(h.uploads.length,0);
});

test('hold-to-talk suspends wake and resumes without a duplicate stream',async()=>{
  const h=rig();
  await h.handsfree.enable();
  assert.equal(h.handsfree.suspend(),true);
  assert.equal(h.handsfree.suspended,true);
  h.wake();await settle();
  assert.equal(h.captures.length,0);
  assert.equal(h.handsfree.resume(),true);
  h.timers.run(1500);
  h.wake();await settle();
  assert.equal(h.captures.length,1);
  h.handsfree.disable();
});

test('selected keywords are snapshotted on enable and reported with the detected phrase',async()=>{
  let selected=['alexa','hey_mycroft'];
  const h=rig({settings:{getKeywords:()=>selected}});
  await h.handsfree.enable();
  assert.deepEqual(h.detectorOptions.keywords,['alexa','hey_mycroft']);
  selected=['hey_jarvis']; // Changes cannot hot-reload the active detector.
  assert.deepEqual(h.detectorOptions.keywords,['alexa','hey_mycroft']);
  h.wake({keyword:'hey_mycroft',score:0.87});
  h.wake({keyword:'alexa',score:0.92}); // Same inference window must not start another capture.
  await settle();
  assert.equal(h.captures.length,1);
  assert.deepEqual(h.events.at(-1),{
    state:'recording',message:'“Hey Mycroft” detected. Say one command.',keyword:'hey_mycroft',score:0.87,
  });
  h.handsfree.disable();
});

test('empty or invalid keyword selections fail before requesting the microphone',async()=>{
  for(const keywords of [[],['hey_rhasspy','unknown'],['alexa','alexa']]){
    const h=rig({settings:{getKeywords:()=>keywords}});
    assert.equal(await h.handsfree.enable(),false);
    assert.equal(h.asked,0);
    assert.equal(h.handsfree.enabled,false);
    assert.equal(h.handsfree.state,'error');
    assert.match(h.events.at(-1).message,/at least one valid wake phrase/i);
  }
});

test('detector events for keywords outside the enable snapshot are ignored',async()=>{
  const h=rig({settings:{getKeywords:()=>['alexa']}});
  await h.handsfree.enable();
  h.wake({keyword:'hey_jarvis',score:0.99});
  await settle();
  assert.equal(h.captures.length,0);
  assert.equal(h.handsfree.state,'listening');
  h.handsfree.disable();
});
