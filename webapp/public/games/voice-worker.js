import * as Transformers from './vendor/transformers-3.8.1/transformers.min.js';
import { inspectModelCache, MODEL_CACHE_FILES } from './model-cache-status.js?v=63822c97e34c';

const MODEL_ID = 'whisper-tiny-en-79fb389';
const MODELS_BASE = new URL('./models/', import.meta.url);
const WASM_BASE = new URL('./vendor/transformers-3.8.1/', import.meta.url);

Transformers.env.allowLocalModels = true;
Transformers.env.allowRemoteModels = false;
Transformers.env.localModelPath = MODELS_BASE.href;
Transformers.env.backends.onnx.wasm.wasmPaths = WASM_BASE.href;
Transformers.env.backends.onnx.wasm.numThreads = 1;
Transformers.env.backends.onnx.wasm.proxy = false;

let recognizer = null;
let loadPromise = null;
let inferenceActive = false;
let modelInfo = null;

function emitProgress(id, info, extra = {}) {
  self.postMessage({ id, type: 'progress', ...info, ...extra });
}

function fileName(file) {
  return typeof file === 'string' ? file.replace(/^.*?whisper-tiny-en-79fb389\//, '') : '';
}

function postError(id, error) {
  self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
}

async function loadRecognizer(id) {
  if (recognizer) {
    self.postMessage({ id, type: 'ready', modelInfo });
    return recognizer;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const { cachedFileNames, ...cacheInfo } = await inspectModelCache({
        cacheStorage: self.caches,
        modelBase: MODELS_BASE.href,
        modelId: MODEL_ID
      });
      const cachedAtStart = new Set(cachedFileNames);
      emitProgress(id, {
        phase: cacheInfo.cacheState === 'complete' ? 'cached' : 'download',
        ...cacheInfo,
        status: 'cache-check'
      });

      const completedFiles = new Set();
      let initializationAnnounced = false;
      const pipeline = await Transformers.pipeline('automatic-speech-recognition', MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        local_files_only: true,
        revision: '79fb389fc764e7c395bd330e9531d9d32ada7049',
        progress_callback: progress => {
          const file = fileName(progress.file);
          // Pipeline-wide initiate/ready events have no file and are not downloads.
          if (!file) return;
          const phase = cachedAtStart.has(file) ? 'cached' : 'download';
          emitProgress(id, { phase, ...progress, ...cacheInfo });
          if (progress.status === 'done' && MODEL_CACHE_FILES.includes(file)) completedFiles.add(file);
          if (!initializationAnnounced && completedFiles.size >= MODEL_CACHE_FILES.length) {
            initializationAnnounced = true;
            emitProgress(id, { phase: 'initializing', status: 'initializing', ...cacheInfo });
          }
        }
      });
      const { cachedFileNames: _cachedFileNames, ...finalCacheInfo } = await inspectModelCache({
        cacheStorage: self.caches,
        modelBase: MODELS_BASE.href,
        modelId: MODEL_ID
      });
      if (!initializationAnnounced) {
        emitProgress(id, { phase: 'initializing', status: 'initializing', ...finalCacheInfo });
      }
      modelInfo = finalCacheInfo;
      return pipeline;
    })().then(pipeline => {
      recognizer = pipeline;
      return pipeline;
    }).catch(error => {
      loadPromise = null;
      recognizer = null;
      modelInfo = null;
      throw error;
    });
  }
  try {
    const pipeline = await loadPromise;
    self.postMessage({ id, type: 'ready', modelInfo });
    return pipeline;
  } catch (error) {
    postError(id, error);
    throw error;
  }
}

self.onmessage = event => {
  const message = event.data || {};
  const { id, type } = message;
  if (type === 'load') {
    void loadRecognizer(id).catch(() => {});
    return;
  }
  if (type === 'transcribe') {
    if (inferenceActive) {
      postError(id, new Error('Transcription is already in progress.'));
      return;
    }
    inferenceActive = true;
    void (async () => {
      const started = performance.now();
      try {
        const pipeline = await loadRecognizer(id);
        const audio = message.audio instanceof Float32Array ? message.audio : new Float32Array(message.audio || []);
        const result = await pipeline(audio, {
          max_new_tokens: 64
        });
        self.postMessage({ id, type: 'result', text: String(result?.text || '').trim(), elapsedMs: performance.now() - started });
      } catch (error) {
        // loadRecognizer reports its own error for the same request id.
        if (recognizer) postError(id, error);
      } finally {
        inferenceActive = false;
      }
    })();
  }
};
