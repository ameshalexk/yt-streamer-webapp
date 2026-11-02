import {createTeslaMonCapture} from './teslamon-capture.js';
import {createTeslaMonLocalStt} from './teslamon-local-stt.js?v=20261101-moonshine-lab1';

const start=document.getElementById('start');
const stop=document.getElementById('stop');
const cancel=document.getElementById('cancel');
const support=document.getElementById('support');
const status=document.getElementById('status');
const transcript=document.getElementById('transcript');
const supported=Boolean(globalThis.crossOriginIsolated&&typeof SharedArrayBuffer!=='undefined'&&
  globalThis.Worker&&globalThis.AudioContext&&navigator.mediaDevices?.getUserMedia);
support.textContent=supported?'Cross-origin isolation and microphone APIs available. Tesla stability not yet verified.':
  'Moonshine requires cross-origin isolation, SharedArrayBuffer, a Worker, AudioContext and microphone access. This browser/page does not provide all of them.';
const stt=createTeslaMonLocalStt({modelId:'moonshine-tiny-streaming'});
let running=false;
let activeAbort=null;
function show(message){status.textContent=message;}
function controls(){start.disabled=!supported||running||Boolean(activeAbort);stop.disabled=!running;cancel.disabled=!running&&!activeAbort;}
const capture=createTeslaMonCapture({
  getUserMedia:constraints=>navigator.mediaDevices.getUserMedia(constraints),
  MediaRecorder:globalThis.MediaRecorder,
  onState:state=>{
    if(state.state==='recording')show('Recording locally. Stop after a short command.');
    if(state.state==='complete'||state.state==='cancelled'||state.state==='empty'){running=false;controls();}
  },
  onAudio:async blob=>{
    running=false;
    activeAbort=new AbortController();
    controls();
    const started=performance.now();
    try {
      const result=await stt.transcribe(blob,{
        signal:activeAbort.signal,
        onPhase:phase=>show(phase.message||phase.phase)
      });
      transcript.textContent=result.text||'[No speech recognized]';
      show('Finished in '+Math.round(performance.now()-started)+'ms (including model load and audio decode); inference '+Math.round(result.elapsedMs||0)+'ms.');
    }catch(error){
      if(error?.name==='AbortError')show('Canceled.');
      else show('Moonshine failed: '+String(error?.message||error)+'. Whisper Tiny production remains unchanged.');
    }finally{activeAbort=null;controls();}
  },
  onError:error=>{running=false;show('Recorder failed: '+String(error?.message||error));controls();}
});
start.onclick=async()=>{
  if(!supported||running||activeAbort)return;
  running=true;transcript.textContent='Not recorded.';controls();
  show('Requesting microphone access…');
  const ok=await capture.start();
  if(!ok){running=false;controls();}
};
stop.onclick=()=>{if(running){show('Finalizing the clip…');capture.release();}};
cancel.onclick=()=>{
  capture.cancel();activeAbort?.abort();stt.cancelPending();
  running=false;show('Canceled.');controls();
};
window.addEventListener('pagehide',()=>{
  capture.dispose();activeAbort?.abort();stt.dispose();
});
controls();
