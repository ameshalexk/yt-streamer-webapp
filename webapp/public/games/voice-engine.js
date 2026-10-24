const LOAD_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 45_000;

function abortError() {
  const error = new Error('Voice request was canceled.');
  error.name = 'AbortError';
  return error;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

/** Browser-only, lazy Whisper worker client. Audio stays in the current page. */
export class VoiceEngine {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.loaded = false;
    this.modelInfo = null;
    this.loading = null;
    this.loadProgressCallbacks = new Set();
    this.busy = false;
    this.disposed = false;
  }

  _ensureWorker() {
    if (this.disposed) throw new Error('Voice engine has been disposed.');
    if (!this.worker) {
      this.worker = new Worker(new URL('./voice-worker.js?v=e2cf34b3cb75', import.meta.url), { type: 'module' });
      this.worker.onmessage = event => this._onMessage(event.data || {});
      this.worker.onerror = event => {
        const error = new Error(event.message || 'Voice worker failed to start.');
        this._reset(error);
      };
      this.worker.onmessageerror = () => this._reset(new Error('Voice worker returned an unreadable response.'));
    }
    return this.worker;
  }

  _onMessage(message) {
    const entry = this.pending.get(message.id);
    if (!entry || entry.settled) return; // canceled or stale request
    if (message.type === 'progress') {
      if (entry.kind === 'load') {
        for (const callback of this.loadProgressCallbacks) { try { callback(message); } catch {} }
      } else { try { entry.onProgress?.(message); } catch {} }
      return;
    }
    if (message.type === 'ready') {
      this.loaded = true;
      this.modelInfo = message.modelInfo || null;
      if (entry.kind === 'load') entry.resolve(this.modelInfo);
    } else if (message.type === 'result') {
      entry.resolve({ text: message.text, elapsedMs: message.elapsedMs });
    } else if (message.type === 'error') {
      if (entry.kind === 'load') this._reset(new Error(message.message || 'Whisper model could not be loaded.'));
      else entry.reject(new Error(message.message || 'Transcription failed.'));
    }
  }

  _request(type, payload = {}, { timeoutMs, onProgress } = {}) {
    const worker = this._ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { id, kind: type, onProgress, settled: false, timer: null, resolve: null, reject: null };
      const finish = (fn, value) => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        fn(value);
      };
      entry.resolve = value => finish(resolve, value);
      entry.reject = error => finish(reject, error);
      entry.timer = setTimeout(() => {
        const error = new Error(type === 'load' ? 'Whisper model loading timed out.' : 'Voice transcription timed out.');
        this._reset(error);
      }, timeoutMs);
      this.pending.set(id, entry);
      try {
        if (type === 'transcribe') worker.postMessage({ id, type, ...payload }, [payload.audio.buffer]);
        else worker.postMessage({ id, type, ...payload });
      } catch (error) {
        entry.reject(error);
      }
    });
  }

  _reset(error = new Error('Voice worker was reset.')) {
    const worker = this.worker;
    this.worker = null;
    this.loaded = false;
    this.modelInfo = null;
    this.loading = null;
    this.loadProgressCallbacks.clear();
    this.busy = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  load({ signal, onProgress } = {}) {
    if (this.disposed) return Promise.reject(new Error('Voice engine has been disposed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.loaded) return Promise.resolve(this.modelInfo);
    if (onProgress) this.loadProgressCallbacks.add(onProgress);
    if (!this.loading) {
      const promise = this._request('load', {}, { timeoutMs: LOAD_TIMEOUT_MS }).then(info => {
        this.loaded = true;
        this.modelInfo = info;
        return info;
      }).finally(() => this.loadProgressCallbacks.clear());
      this.loading = promise;
      promise.finally(() => { if (this.loading === promise) this.loading = null; }).catch(() => {});
    }
    const loading = withAbort(this.loading, signal);
    return loading.finally(() => {
      if (onProgress) this.loadProgressCallbacks.delete(onProgress);
    });
  }

  async transcribe(audio, { signal } = {}) {
    if (this.disposed) throw new Error('Voice engine has been disposed.');
    if (signal?.aborted) throw abortError();
    if (this.busy) throw new Error('Transcription is already in progress.');
    await this.load({ signal });
    if (signal?.aborted) throw abortError();
    if (this.busy) throw new Error('Transcription is already in progress.');
    const samples = audio instanceof Float32Array ? audio : Float32Array.from(audio || []);
    if (!samples.length) throw new Error('No audio was captured.');
    this.busy = true;
    let request;
    const onAbort = () => this._reset(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request = this._request('transcribe', { audio: samples }, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
      return await withAbort(request, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.busy = false;
    }
  }

  /** Cancel active model preparation or inference while preserving a warm idle worker. */
  cancelPending() {
    if (!this.loading && !this.busy) return false;
    this._reset(abortError());
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._reset(new Error('Voice engine has been disposed.'));
  }
}
