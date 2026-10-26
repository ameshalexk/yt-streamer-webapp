/** One browser-local Whisper engine shared by PTT and wake command clips. */
const MODEL_INFO = Object.freeze({
  'whisper-tiny.en': Object.freeze({ modelId:'whisper-tiny.en', label:'Tiny English', estimatedSizeMB:43, performance:'Faster, uses less memory.' }),
  'whisper-base.en': Object.freeze({ modelId:'whisper-base.en', label:'Base English', estimatedSizeMB:79, performance:'Better transcription quality; slower and uses more memory.' })
});
const DEFAULT_MODEL='whisper-tiny.en';
const hasModel=id=>typeof id==='string'&&Object.hasOwn(MODEL_INFO,id);

async function loadDefaultImplementation() {
  const [{ VoiceEngine }, { decodeRecordedAudio }] = await Promise.all([
    import('./games/voice-engine.js?v=20261025-stt-models1'),
    import('./games/recorded-audio.js?v=20261024-shared-stt1')
  ]);
  return { VoiceEngine, decodeRecordedAudio };
}
function aborted() { const error=new Error('Local transcription was canceled.');error.name='AbortError';return error; }
function withAbort(promise,signal) {
  if(signal.aborted)return Promise.reject(aborted());
  return new Promise((resolve,reject)=>{
    const onAbort=()=>{cleanup();reject(aborted());};
    const cleanup=()=>signal.removeEventListener('abort',onAbort);
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    if(signal.aborted)onAbort();
  });
}

export function createTeslaMonLocalStt({ modelId=DEFAULT_MODEL, loadImplementation=loadDefaultImplementation }={}) {
  if(!hasModel(modelId))throw new Error(`Unsupported local transcription model: ${String(modelId)}.`);
  let selectedModelId=modelId,implementationPromise=null,engine=null,busy=false,activeController=null,selectionVersion=0;

  async function implementation(version,requestedModelId) {
    if(!implementationPromise)implementationPromise=Promise.resolve().then(loadImplementation)
      .catch(error=>{implementationPromise=null;throw error;});
    const module=await implementationPromise;
    if(version!==selectionVersion||requestedModelId!==selectedModelId)throw aborted();
    if(!engine)engine=new module.VoiceEngine({modelId:requestedModelId});
    return {engine,decodeRecordedAudio:module.decodeRecordedAudio};
  }
  async function transcribe(blob,{signal,onPhase=()=>{}}={}) {
    if(busy)throw new Error('Another voice command is being transcribed. Wait and try again.');
    if(signal?.aborted)throw aborted();
    const controller=new AbortController(),version=selectionVersion,requestedModelId=selectedModelId;
    const externalAbort=()=>controller.abort();signal?.addEventListener('abort',externalAbort,{once:true});
    if(signal?.aborted)controller.abort();
    const requestSignal=controller.signal;activeController=controller;busy=true;
    try {
      const client=await withAbort(implementation(version,requestedModelId),requestSignal);
      if(requestSignal.aborted||version!==selectionVersion)throw aborted();
      if(!client.engine.loaded) {
        onPhase({phase:'preparing',message:`Preparing ${MODEL_INFO[requestedModelId].label} locally… Command recording has ended.`});
        await client.engine.load({signal:requestSignal,onProgress:progress=>{
          if(requestSignal.aborted||version!==selectionVersion)return;
          const percent=Number.isFinite(progress.progress)?' '+Math.round(progress.progress)+'%':'';
          const message=progress.phase==='download'?'Fetching local voice files'+percent+' · Saved files are reused.':
            progress.phase==='cached'?'Loading saved local voice files'+percent+'.':
              'Initializing the local voice model…';
          onPhase({phase:progress.phase,message,progress});
        }});
      }
      if(requestSignal.aborted||version!==selectionVersion)throw aborted();
      onPhase({phase:'decoding',message:'Decoding this recording inside the browser…'});
      const audio=await withAbort(client.decodeRecordedAudio(blob,{signal:requestSignal}),requestSignal);
      if(requestSignal.aborted||version!==selectionVersion)throw aborted();
      onPhase({phase:'transcribing',message:'Transcribing locally · Model already loaded.'});
      const result=await client.engine.transcribe(audio,{signal:requestSignal});
      if(requestSignal.aborted||version!==selectionVersion)throw aborted();
      return {text:String(result?.text||'').trim(),elapsedMs:result?.elapsedMs||0,
        modelInfo:client.engine.modelInfo||MODEL_INFO[requestedModelId]};
    } finally {
      signal?.removeEventListener('abort',externalAbort);
      if(activeController===controller)activeController=null;
      busy=false;
    }
  }
  function cancelPending(){activeController?.abort();engine?.cancelPending?.();}
  function disposeEngine(){
    selectionVersion++;
    cancelPending();
    if(engine){engine.dispose?.();engine=null;}
  }
  function setModel(nextModelId){
    if(!hasModel(nextModelId))return Promise.reject(new Error(`Unsupported local transcription model: ${String(nextModelId)}.`));
    if(busy)return Promise.reject(new Error('Finish or cancel the current microphone command before changing the transcription model.'));
    if(nextModelId===selectedModelId)return Promise.resolve(getState());
    disposeEngine();
    selectedModelId=nextModelId;
    return Promise.resolve(getState());
  }
  function getState(){return {loaded:Boolean(engine?.loaded),busy,modelInfo:engine?.modelInfo||null,
    selectedModel:MODEL_INFO[selectedModelId],selectedModelId,worker:Boolean(engine?.worker)};}
  return {transcribe,cancelPending,dispose:disposeEngine,setModel,getState};
}
