/**
 * One browser-local Whisper engine for both TeslaMon hold-to-talk and Hey Jarvis
 * command clips. Its implementation and model live in the independently hosted
 * /games/ static package; both pages fetch identical same-origin asset URLs.
 * This module never uploads audio or invokes any server transcription API.
 */
async function loadDefaultImplementation() {
  const [{ VoiceEngine }, { decodeRecordedAudio }] = await Promise.all([
    import('./games/voice-engine.js?v=20261024-shared-stt1'),
    import('./games/recorded-audio.js?v=20261024-shared-stt1')
  ]);
  return { VoiceEngine, decodeRecordedAudio };
}

function aborted() {
  const error = new Error('Local transcription was canceled.');
  error.name = 'AbortError';
  return error;
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

export function createTeslaMonLocalStt({ loadImplementation = loadDefaultImplementation } = {}) {
  let implementationPromise = null;
  let engine = null;
  let busy = false;
  let activeController = null;

  async function implementation() {
    if (!implementationPromise) {
      implementationPromise = Promise.resolve().then(loadImplementation)
        .catch(error => { implementationPromise = null; throw error; });
    }
    const module = await implementationPromise;
    if (!engine) engine = new module.VoiceEngine();
    return { engine, decodeRecordedAudio: module.decodeRecordedAudio };
  }

  async function transcribe(blob, { signal, onPhase = () => {} } = {}) {
    if (busy) throw new Error('Another voice command is being transcribed. Wait and try again.');
    if (signal?.aborted) throw aborted();
    const controller = new AbortController();
    const externalAbort = () => controller.abort();
    signal?.addEventListener('abort', externalAbort, { once:true });
    if (signal?.aborted) controller.abort();
    const requestSignal = controller.signal;
    activeController = controller;
    busy = true;
    try {
      const client = await withAbort(implementation(), requestSignal);
      if (requestSignal.aborted) throw aborted();
      if (!client.engine.loaded) {
        onPhase({ phase:'preparing', message:'Checking saved local voice model… Command recording has ended.' });
        await client.engine.load({
          signal:requestSignal,
          onProgress:progress => {
            if (requestSignal.aborted) return;
            const percent = Number.isFinite(progress.progress) ? ' ' + Math.round(progress.progress) + '%' : '';
            const message = progress.phase === 'download'
              ? 'Fetching voice files' + percent + ' · Saved files are reused.'
              : progress.phase === 'cached'
                ? 'Loading saved voice' + percent + ' · No new model download.'
                : 'Initializing the local voice model…';
            onPhase({ phase:progress.phase, message, progress });
          }
        });
      }
      if (requestSignal.aborted) throw aborted();
      onPhase({ phase:'decoding', message:'Decoding this recording inside the browser…' });
      const audio = await withAbort(client.decodeRecordedAudio(blob, { signal:requestSignal }), requestSignal);
      if (requestSignal.aborted) throw aborted();
      onPhase({ phase:'transcribing', message:'Transcribing locally · Model already loaded.' });
      const result = await client.engine.transcribe(audio, { signal:requestSignal });
      if (requestSignal.aborted) throw aborted();
      return { text:String(result?.text || '').trim(), elapsedMs:result?.elapsedMs || 0,
        modelInfo:client.engine.modelInfo };
    } finally {
      signal?.removeEventListener('abort', externalAbort);
      if (activeController === controller) activeController = null;
      busy = false;
    }
  }

  function cancelPending() {
    activeController?.abort();
    engine?.cancelPending?.();
  }

  function dispose() {
    cancelPending();
    engine?.dispose();
    engine = null;
  }

  return {
    transcribe, cancelPending, dispose,
    getState:() => ({ loaded:Boolean(engine?.loaded), busy, modelInfo:engine?.modelInfo || null,
      worker:Boolean(engine?.worker) })
  };
}
