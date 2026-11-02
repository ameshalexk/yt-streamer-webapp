/**
 * Experimental, browser-only Moonshine Tiny Streaming inference worker.
 * This never sends user audio to YT Streamer or a transcription service.
 * The published WASM package requires a cross-origin-isolated document.
 */
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm@0.1.5/dist/index.js';
let transcriber = null;
let loading = null;
let sdk = null;

function message(id, type, data = {}) {
  self.postMessage({id, type, ...data});
}

async function ensureLoaded(id) {
  if (transcriber) return;
  if (loading) return loading;
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    throw new Error('Moonshine WASM requires a cross-origin-isolated page. Select Moonshine in the transcription model picker to open isolated mode.');
  }
  loading = (async () => {
    sdk = await import(SDK_URL);
    if (!sdk?.Transcriber || !sdk?.ModelArch) throw new Error('Moonshine WASM runtime is unavailable.');
    const created = await sdk.Transcriber.load({
      language: 'en',
      modelArch: sdk.ModelArch.TinyStreaming,
      onProgress(loaded,total,file) {
        message(id,'progress',{
          phase:'download',
          progress:total > 0 ? Math.min(100,Math.max(0,Math.round(100*loaded/total))) : null,
          file:String(file||'')
        });
      }
    });
    transcriber = created;
  })();
  try { await loading; }
  finally { loading = null; }
}

self.onmessage = async event => {
  const data = event.data || {};
  const id = data.id;
  if (!Number.isInteger(id)) return;
  try {
    if (data.type === 'load') {
      await ensureLoaded(id);
      message(id,'ready',{modelInfo:{modelId:'moonshine-tiny-streaming',label:'Moonshine Tiny Streaming',runtime:'WASM'}});
      return;
    }
    if (data.type !== 'transcribe') throw new Error('Unknown transcription operation.');
    if (!transcriber) throw new Error('Load Moonshine before transcribing.');
    const audio = data.audio;
    if (!(audio instanceof Float32Array) || audio.length === 0 || audio.length > 16*16000) {
      throw new Error('Expected at most 16 seconds of mono 16 kHz audio.');
    }
    const started = performance.now();
    const stream = transcriber.createStream({updateInterval:0});
    let snapshot;
    try {
      stream.start();
      stream.addAudio(audio,16000);
      snapshot = stream.transcribe(sdk.TranscribeFlags.ForceUpdate);
      stream.stop();
    } finally {
      stream.close();
    }
    const text = (snapshot?.lines || []).map(line=>String(line?.text||'')).join(' ').trim();
    message(id,'result',{text,elapsedMs:Math.round(performance.now()-started)});
  } catch (error) {
    message(id,'error',{message:String(error?.message || error || 'Moonshine WASM failed.')});
  }
};
