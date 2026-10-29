// TeslaMon foreground-only openWakeWord microphone lifecycle.
// Neither importing nor creating this controller requests microphone access.
import {normalizeTeslaMonWakeKeywords, teslaMonWakePhraseLabel} from './teslamon-wake-phrases.js?v=20261025-mycroft-rhasspy1';
export function createTeslaMonHandsFree({
  getUserMedia,
  createDetector,
  createCapture,
  createSilenceMonitor = () => ({start: async () => false, stop() {}}),
  onAudio = async () => {},
  onState = () => {},
  onError = () => {},
  duckPlayback = () => () => {},
  getKeywords = () => ['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy'],
  timers = globalThis,
  commandTimeoutMs = 12_000,
  cooldownMs = 1500,
  pauseDeadlineMs = 2500,
} = {}) {
  if (typeof getUserMedia !== 'function' || typeof createDetector !== 'function' ||
      typeof createCapture !== 'function') throw new TypeError('Hands-free requires microphone, detector and capture adapters');

  let phase = 'off', wanted = false, suspended = false, serial = 0;
  let microphone = null, detector = null, recorder = null, silenceMonitor = null;
  let processingAbort = null, pauseAbort = null, cooldownTimer = null, startPromise = null;
  let restorePlayback = null, trackListeners = [];
  let commandConsumed = false, wakeInvocation = 0, activeInvocation = 0, activeKeywords = ['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy'];
  const listeningMessage=()=>`Listening for ${activeKeywords.map(teslaMonWakePhraseLabel).join(', ')}`;

  const current = id => wanted && serial === id;
  function emit(state, message, metadata = {}) {
    phase = state;
    try { onState({state, message, ...metadata}); } catch {}
  }
  function stopTracks(stream) {
    try { for (const track of stream?.getTracks?.() || []) track.stop(); } catch {}
  }
  function removeTrackListeners() {
    for (const [track, handler] of trackListeners) {
      try {track.removeEventListener?.('ended', handler);} catch {}
    }
    trackListeners = [];
  }
  function stopMonitor() {
    try {silenceMonitor?.stop?.();} catch {}
    silenceMonitor = null;
  }
  function restore() {
    const fn = restorePlayback;
    restorePlayback = null;
    try {fn?.();} catch {}
  }
  function clearCooldown() {
    if(cooldownTimer!==null){timers.clearTimeout(cooldownTimer);cooldownTimer=null;}
  }
  async function stopDetector(engine) {
    try {await engine?.stop?.();} catch {}
  }
  function disable() {
    serial++;
    wanted = false; suspended = false; commandConsumed = false;
    clearCooldown();
    processingAbort?.abort(); processingAbort = null;
    pauseAbort?.abort(); pauseAbort = null;
    stopMonitor();
    try {recorder?.cancel?.();} catch {}
    recorder = null;
    restore();
    const stream = microphone;
    microphone = null;
    removeTrackListeners();
    // The tracks must stop immediately, even if a model-load promise hangs.
    stopTracks(stream);
    const oldDetector = detector;
    detector = null;
    void stopDetector(oldDetector);
    emit('off', 'Off');
  }
  function fail(error) {
    if(!wanted)return;
    disable();
    const normalized=error instanceof Error?error:new Error(String(error||'Microphone error'));
    emit('error', normalized.name==='NotAllowedError'?
      'Error: Microphone permission denied. Check browser permissions.':
      'Error: '+(normalized.message||'Microphone unavailable'));
    try {onError(normalized);} catch {}
  }
  function pauseDetector() {try {detector?.pause?.();} catch(error) {fail(error);} }
  function resumeDetector() {try {detector?.resume?.();} catch(error) {fail(error);} }
  function resumeListening(id,{message='Waiting to rearm wake detection…'}={}) {
    if(!current(id) || suspended) return;
    clearCooldown();
    emit('cooldown',message,{invocationId:activeInvocation});
    cooldownTimer=timers.setTimeout(()=>{
      cooldownTimer=null;
      if(!current(id)||suspended||recorder||processingAbort)return;
      resumeDetector();
      if(current(id))emit('listening',listeningMessage(),{invocationId:activeInvocation});
    },cooldownMs);
  }
  function finishNoSpeech(id) {
    if(!current(id)||phase!=='recording')return;
    stopMonitor();
    try{recorder?.cancel?.();}catch{}
    recorder=null;
    restore();
    emit('no_speech','No command speech detected.',{invocationId:activeInvocation});
    resumeListening(id,{message:'No command heard · rearming…'});
  }
  function requestSpeechEnd(id) {
    if(!current(id)||phase!=='recording')return;
    stopMonitor();
    try{recorder?.release?.();}catch(error){fail(error);}
  }
  async function processCommand(blob,id) {
    if(commandConsumed||!current(id)||phase!=='recording')return;
    commandConsumed=true;
    stopMonitor();
    recorder=null; // The recorder's stop event already released the clone.
    emit('processing','Transcribing command locally…',{invocationId:activeInvocation});
    const controller = new AbortController();
    processingAbort = controller;
    try {
      await onAudio(blob,{signal:controller.signal,invocationId:activeInvocation,isCurrent:()=>current(id)&&!controller.signal.aborted});
    } catch(error) {
      if(current(id)&&!controller.signal.aborted) {
        try{onError(error);}catch{}
      }
    } finally {
      if(processingAbort===controller)processingAbort=null;
      restore();
      if(current(id))resumeListening(id);
    }
  }
  async function onWake(id, detection = {}) {
    if(!current(id)||suspended||phase!=='listening'||recorder||pauseAbort)return;
    if(detection?.keyword && !activeKeywords.includes(detection.keyword))return;
    const keyword=activeKeywords.includes(detection?.keyword)?detection.keyword:null;
    commandConsumed=false;
    activeInvocation=++wakeInvocation;
    pauseDetector();
    if(!current(id))return;
    const controller=new AbortController();
    pauseAbort=controller;
    emit('preparing','Pausing playback before recording…',{
      keyword,score:Number.isFinite(detection?.score)?detection.score:undefined,invocationId:activeInvocation,
    });
    let deadline=null,timedOut=false;
    // Abort marks the queued/active pause as obsolete. A late result must
    // never create a recorder or resume video for this invocation.
    const pauseWork=Promise.resolve().then(()=>duckPlayback({signal:controller.signal}));
    // Handle eventual late cleanups without reviving capture.
    void pauseWork.then(cleanup=>{
      if(timedOut||controller.signal.aborted||!current(id)){
        try{cleanup?.();}catch{}
      }
    },()=>{});
    try {
      const cleanup=await Promise.race([
        pauseWork,
        new Promise((_,reject)=>{
          deadline=timers.setTimeout(()=>{
            timedOut=true;
            controller.abort();
            reject(new Error('Playback pause timed out'));
          },pauseDeadlineMs);
        }),
      ]);
      if(!current(id)||controller.signal.aborted)return;
      restorePlayback=typeof cleanup==='function'?cleanup:null;
      recorder=createCapture({
        getUserMedia:async()=>{
          if(!current(id)||controller.signal.aborted||!microphone)
            throw new Error('Microphone was turned off');
          if(typeof microphone.clone!=='function')throw new Error('Microphone stream cloning is unsupported');
          return microphone.clone();
        },
        maxDurationMs:commandTimeoutMs,
        onAudio:blob=>{void processCommand(blob,id);},
        onState:info=>{
          if(!current(id))return;
          if(info.state==='empty')finishNoSpeech(id);
          if(info.state==='complete' && !commandConsumed) {
            queueMicrotask(()=>{if(current(id)&&phase==='recording'&&!commandConsumed)finishNoSpeech(id);});
          }
        },
        onError:error=>{if(current(id))fail(error);}
      });
      const capture=recorder;
      const started=await capture.start();
      if(!current(id)||controller.signal.aborted){
        try{capture.cancel?.();}catch{}
        return;
      }
      if(!started){
        try{capture.cancel?.();}catch{}
        recorder=null;
        restore();
        emit('no_speech','No command recording started.',{invocationId:activeInvocation});
        resumeListening(id,{message:'No command captured · rearming…'});
        return;
      }
      emit('recording',keyword ? `“${teslaMonWakePhraseLabel(keyword)}” detected. Recording one command.` :
        'Recording one command.',{
        keyword,score:Number.isFinite(detection?.score)?detection.score:undefined,invocationId:activeInvocation,
      });
      silenceMonitor=createSilenceMonitor({
        stream:microphone,
        onSpeechEnd:()=>requestSpeechEnd(id),
        onNoSpeech:()=>finishNoSpeech(id),
      });
      const monitor=silenceMonitor;
      void Promise.resolve(monitor?.start?.()).catch(()=>{});
    } catch(error) {
      if(current(id)&&!controller.signal.aborted){
        try{recorder?.cancel?.();}catch{}
        recorder=null;stopMonitor();restore();
        emit('recovering',String(error?.message||'Could not pause playback')+'. Try wake again.',{invocationId:activeInvocation});
        resumeListening(id,{message:'Pause failed · rearming…'});
      }else if(current(id)&&timedOut){
        try{recorder?.cancel?.();}catch{}
        recorder=null;stopMonitor();restore();
        emit('recovering','Playback pause timed out. Try wake again.',{invocationId:activeInvocation});
        resumeListening(id,{message:'Pause timed out · rearming…'});
      }
    } finally {
      if(deadline!==null)timers.clearTimeout(deadline);
      if(pauseAbort===controller)pauseAbort=null;
    }
  }
  function enable() {
    if(wanted)return startPromise??Promise.resolve(true);
    let requested;
    try { requested=normalizeTeslaMonWakeKeywords(getKeywords()); } catch { requested=null; }
    if(!requested) {
      emit('error','Select at least one valid wake phrase before turning Mic On.');
      return Promise.resolve(false);
    }
    activeKeywords=[...requested];
    wanted=true;suspended=false;
    const id=++serial;
    emit('starting','Requesting microphone permission…');
    const promise=(async()=>{
      let stream;
      try {
        stream=await getUserMedia({audio:{
          echoCancellation:true,noiseSuppression:true,autoGainControl:true
        }});
        if(!current(id)){stopTracks(stream);return false;}
        if(!stream?.getAudioTracks?.().some(t=>t.readyState!=='ended')) {
          stopTracks(stream);throw new Error('Microphone is disconnected');
        }
        microphone=stream;
        for(const track of stream.getAudioTracks()){
          const handler=()=>{if(current(id))fail(new Error('Microphone disconnected'));};
          track.addEventListener?.('ended',handler);
          trackListeners.push([track,handler]);
        }
        const engine=await createDetector({
          stream,keywords:[...activeKeywords],onWake:metadata=>{void onWake(id,metadata);},
          onError:error=>{if(current(id))fail(error);}
        });
        if(!current(id)){void stopDetector(engine);return false;}
        detector=engine;
        const started=await engine.start();
        if(!current(id)){void stopDetector(engine);return false;}
        if(started===false)throw new Error('Wake phrase detector could not start');
        emit('listening',listeningMessage());
        return true;
      }catch(error){
        if(current(id))fail(error);
        else if(stream&&stream!==microphone)stopTracks(stream);
        return false;
      }
    })();
    startPromise=promise;
    void promise.finally(()=>{if(startPromise===promise)startPromise=null;});
    return promise;
  }
  function suspend() {
    if(!wanted || suspended)return false;
    if(phase==='recording'||phase==='processing'||phase==='starting')return false;
    suspended=true;
    clearCooldown();
    pauseDetector();
    emit('listening','Wake listening paused for hold-to-talk');
    return true;
  }
  function resume() {
    if(!wanted||!suspended)return false;
    suspended=false;
    resumeListening(serial);
    return true;
  }
  return Object.freeze({
    enable,disable,suspend,resume,
    get state(){return phase;},
    get enabled(){return wanted;},
    get suspended(){return suspended;},
  });
}
