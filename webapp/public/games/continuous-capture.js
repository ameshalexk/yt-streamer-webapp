import {resampleMono, CaptureAbortedError} from './audio-capture.js?v=e7ecb194ea4f';

const TARGET_RATE = 16000;
const MAX_UTTERANCE_MS = 7000;
const END_SILENCE_MS = 950;
const MIN_VOICED_MS = 80;
const INITIAL_THRESHOLD = 0.003;
const MIN_THRESHOLD = 0.0015;
const NOISE_CALIBRATION_MS = 350;
const PREROLL_MS = 210;
const REARM_MS = 350;
const SETUP_TIMEOUT_MS = 15000;
const NO_INPUT_TIMEOUT_MS = 2000;

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch {}
  }
}
function friendlyError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
    return new Error('Microphone permission denied. Switch hands-free On again after allowing access, or use trick buttons.');
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError')
    return new Error('No microphone found. Touch tricks still work.');
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError')
    return new Error('Microphone is busy. Close other apps using it and retry.');
  return error instanceof Error ? error : new Error('Hands-free microphone could not start.');
}
function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a,b)=>a-b);
  return ordered[Math.min(ordered.length-1,Math.floor((ordered.length-1)*fraction))];
}

/**
 * One opt-in microphone session, many locally detected bounded utterances.
 * Keeps the stream alive between tricks; incoming frames are discarded while onClip
 * (the single Whisper worker) is transcribing. Only Abort/track loss closes capture.
 */
export function captureContinuously({
  signal, onListening = () => {}, onLevel = () => {}, onSpeech = () => {},
  onClip = async () => {}, onDiagnostics = () => {}
} = {}) {
  return new Promise((resolve,reject)=>{
    let settled = false;
    let aborted = Boolean(signal?.aborted);
    let stream = null, context = null, source = null, worklet = null;
    let setupTimer = null, inputTimer = null;
    let mode = 'armed'; // armed, recording, processing, cooldown
    let cooldownMs = 0;
    let inputFrames = 0;
    let threshold = INITIAL_THRESHOLD;
    let calibrationMs = 0;
    const noise = [];
    const preRoll = [];
    let preRollSamples = 0;
    let chunks = [];
    let count = 0;
    let voicedMs = 0;
    let trailingMs = 0;
    let peakRms = 0;
    let clipDurationMs = 0;
    const endedTracks = [];

    const cleanup = () => {
      clearTimeout(setupTimer);
      clearTimeout(inputTimer);
      signal?.removeEventListener('abort',abort);
      for(const [track,handler] of endedTracks){
        try { track.removeEventListener('ended',handler); } catch {}
      }
      if(worklet){
        worklet.port.onmessage = null;
        try { worklet.port.close(); } catch {}
        try { worklet.disconnect(); } catch {}
      }
      try { source?.disconnect(); } catch {}
      stopTracks(stream);
      if(context && context.state !== 'closed'){
        try { context.close(); } catch {}
      }
      try { onListening(false); } catch {}
    };
    const finish = error => {
      if(settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const abort = () => {
      aborted = true;
      finish();
    };
    const resetPreRoll = () => { preRoll.length=0;preRollSamples=0; };
    const resetClip = () => {
      chunks=[];count=0;voicedMs=0;trailingMs=0;peakRms=0;clipDurationMs=0;
    };
    const enqueue = samples => {
      if(!samples.length) return;
      const copy=samples.slice();
      chunks.push(copy);count+=copy.length;
    };
    const appendPreRoll = samples => {
      preRoll.push(samples);
      preRollSamples+=samples.length;
      while(preRollSamples>TARGET_RATE*PREROLL_MS && preRoll.length>1){
        const removed=preRoll.shift();preRollSamples-=removed.length;
      }
    };
    const dispatchClip = () => {
      if(mode!=='recording') return;
      mode='processing'; // Prevent incoming audio from queuing or overlapping inference.
      const diagnostic = {
        durationMs: Math.round(clipDurationMs), voicedMs: Math.round(voicedMs),
        peakRms: Number(peakRms.toFixed(5)), threshold: Number(threshold.toFixed(5)),
        samples:count,sampleRate:context?.sampleRate||0
      };
      try {onDiagnostics(diagnostic);}catch{}
      if(voicedMs<MIN_VOICED_MS || count<TARGET_RATE*0.1){
        resetClip();resetPreRoll();mode='cooldown';cooldownMs=REARM_MS;
        return;
      }
      const audio=new Float32Array(count);
      let offset=0;
      for(const chunk of chunks){audio.set(chunk,offset);offset+=chunk.length;}
      resetClip();resetPreRoll();
      Promise.resolve().then(()=>{
        if(!settled&&!aborted) return onClip(audio);
      }).then(()=>{
        if(settled||aborted) return;
        mode='cooldown';cooldownMs=REARM_MS;
      },error=>{
        if(settled||aborted) return;
        finish(friendlyError(error));
      });
    };
    const receive = event => {
      if(settled||aborted) return;
      const samples=event.data;
      if(!(samples instanceof Float32Array)||!samples.length) return;
      inputFrames++;
      clearTimeout(inputTimer);
      inputTimer=null;
      if(mode==='processing') return;
      const elapsedMs=samples.length*1000/context.sampleRate;
      let sum=0;
      for(let i=0;i<samples.length;i++)sum+=samples[i]*samples[i];
      const rms=Math.sqrt(sum/samples.length);
      const level=rms>0?Math.min(1,Math.max(0,(20*Math.log10(rms)+60)/60)):0;
      try {onLevel(level);}catch{}
      if(mode==='cooldown'){
        cooldownMs-=elapsedMs;
        if(cooldownMs<=0){mode='armed';resetPreRoll();}
        return;
      }
      const pcm=resampleMono(samples,context.sampleRate,TARGET_RATE);
      if(mode==='armed'){
        appendPreRoll(pcm);
        if(rms>=threshold){
          mode='recording';
          resetClip();
          for(const buffered of preRoll) enqueue(buffered);
          resetPreRoll();
          clipDurationMs=elapsedMs;
          voicedMs=elapsedMs;
          peakRms=rms;
          try {onSpeech();}catch{}
        }else if(rms<=MIN_THRESHOLD&&calibrationMs<NOISE_CALIBRATION_MS){
          noise.push(rms);
          calibrationMs+=elapsedMs;
          threshold=Math.max(MIN_THRESHOLD,Math.min(threshold,percentile(noise,.25)*1.7));
        }
        return;
      }
      enqueue(pcm);
      clipDurationMs+=elapsedMs;
      peakRms=Math.max(peakRms,rms);
      if(rms>=threshold){voicedMs+=elapsedMs;trailingMs=0;}
      else trailingMs+=elapsedMs;
      if(trailingMs>=END_SILENCE_MS||clipDurationMs>=MAX_UTTERANCE_MS)dispatchClip();
    };

    if(aborted){finish(new CaptureAbortedError());return;}
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    setupTimer=setTimeout(()=>finish(new Error('Hands-free microphone setup timed out. Tap the toggle again after granting access.')),SETUP_TIMEOUT_MS);
    const begin=async()=>{
      try{
        if(!globalThis.navigator?.mediaDevices?.getUserMedia||!globalThis.AudioContext||!globalThis.AudioWorkletNode)
          throw new Error('Continuous microphone capture is unavailable. Touch tricks still work.');
        // Request browser audio and consent while the explicit toggle gesture is active.
        context=new AudioContext({latencyHint:'interactive'});
        let resumePromise;
        try{resumePromise=Promise.resolve(context.resume()).catch(()=>false);}catch{resumePromise=Promise.resolve(false);}
        const modulePromise=context.audioWorklet.addModule(new URL('./audio-worklet.js?v=f8811a237203',import.meta.url));
        modulePromise.catch(()=>{});
        const mediaPromise=navigator.mediaDevices.getUserMedia({
          audio:{channelCount:1,echoCancellation:true,noiseSuppression:false,autoGainControl:true}
        });
        stream=await mediaPromise;
        if(settled||aborted){stopTracks(stream);return;}
        await Promise.all([modulePromise,resumePromise]);
        if(settled||aborted)return;
        source=context.createMediaStreamSource(stream);
        worklet=new AudioWorkletNode(context,'teslamon-mono-capture',{
          numberOfInputs:1,numberOfOutputs:0,channelCount:1,
          channelCountMode:'explicit',channelInterpretation:'speakers'
        });
        worklet.port.onmessage=receive;
        for(const track of stream.getAudioTracks?.()||stream.getTracks?.()||[]){
          const onEnded=()=>{if(!settled&&!aborted)finish(new Error('Microphone disconnected. Switch hands-free On to retry.'));};
          try{track.addEventListener('ended',onEnded);endedTracks.push([track,onEnded]);}catch{}
        }
        source.connect(worklet);
        if(context.state==='suspended'){
          try{await context.resume();}catch{}
        }
        if(settled||aborted)return;
        clearTimeout(setupTimer);setupTimer=null;
        inputTimer=setTimeout(()=>{
          if(!inputFrames)finish(new Error('Microphone opened but no audio arrived. Check the selected input.'));
        },NO_INPUT_TIMEOUT_MS);
        try{onListening(true);}catch{}
      }catch(error){
        if(!settled)finish(aborted?null:friendlyError(error));
      }
    };
    void begin();
  });
}
