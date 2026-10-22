const MAX_DURATION_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const STOP_WATCHDOG_MS = 8_000;
const MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];
// iOS Safari may append codec parameters to MIME labels or omit the
// dataavailable chunk MIME. Compare the actual bounded container type.
const containerType = raw => String(raw || '').split(';')[0].trim().toLowerCase();
const CONTAINERS = new Set(['audio/webm', 'audio/ogg', 'audio/mp4']);

/**
 * Create an explicitly started, in-memory audio capture lifecycle.
 * Importing this module and creating a controller never requests media.
 */
export function createTeslaMonCapture({
  getUserMedia,
  MediaRecorder: Recorder,
  timers = globalThis,
  onState = () => {},
  onAudio = () => {},
  onError = () => {},
  maxDurationMs = MAX_DURATION_MS,
  maxBytes = MAX_BYTES,
  stopWatchdogMs = STOP_WATCHDOG_MS,
} = {}) {
  let active = null;
  let generation = 0;
  let disposed = false;

  function safeCallback(callback, value) {
    try { callback(value); } catch { /* Consumer callbacks cannot retain capture resources. */ }
  }

  function state(session, value, detail) {
    if (active !== session) return;
    safeCallback(onState, { state: value, ...(detail ? { detail } : {}) });
  }

  function stopTracks(stream) {
    let tracks = [];
    try { tracks = stream?.getTracks?.() ?? []; } catch { return; }
    for (const track of tracks) {
      try { track.stop(); } catch { /* Stop every remaining track even if one throws. */ }
    }
  }

  function clearTimer(session, key) {
    if (session[key] !== null) {
      try { timers.clearTimeout(session[key]); } catch { /* Best effort timer cleanup. */ }
      session[key] = null;
    }
  }

  function finish(session, outcome, error) {
    if (active !== session || session.finished) return;
    session.finished = true;
    let blob = null;
    if (outcome === 'complete') {
      try { blob = new Blob(session.chunks, { type: session.mimeType }); }
      catch (blobError) { error = blobError; outcome = 'error'; }
    }
    active = null;
    clearTimer(session, 'durationTimer');
    clearTimer(session, 'watchdogTimer');
    stopTracks(session.stream);
    session.stream = null;
    session.chunks.length = 0;
    stateTerminal(outcome, error);

    function stateTerminal(finalState, detail) {
      safeCallback(onState, { state: finalState, ...(detail ? { detail } : {}) });
    }

    if (outcome === 'complete') {
      if (blob.size > 0 && blob.size <= maxBytes && !disposed && generation === session.id) safeCallback(onAudio, blob);
      else if (blob.size > maxBytes) safeCallback(onError, new Error('Recording exceeded the configured size limit'));
      return;
    }
    if (outcome === 'error' && error) safeCallback(onError, error instanceof Error ? error : new Error(String(error)));
  }

  function requestStop(session, outcome = 'complete') {
    if (active !== session || session.finishing) return;
    session.finishing = true;
    session.outcome = outcome;
    state(session, 'stopping');
    if (active !== session) return;
    clearTimer(session, 'durationTimer');
    // CRITICAL: stop the recorder BEFORE microphone tracks. Safari generates
    // its last dataavailable chunk during recorder.stop(); prematurely ending
    // tracks loses audio and may fire a MediaRecorder error. finish() owns
    // track teardown after the recorder has emitted stop or timed out.
    if (session.recorder?.state === 'inactive') {
      finish(session, outcome);
      return;
    }
    session.watchdogTimer = timers.setTimeout(() => {
      if (active === session) finish(session, 'error', new Error('Recorder did not stop in time'));
    }, stopWatchdogMs);
    try { session.recorder.stop(); }
    catch (error) { finish(session, 'error', error); }
  }

  function terminate(session, error) {
    if (active !== session) return;
    session.finishing = true;
    const recorder = session.recorder;
    finish(session, 'error', error);
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
    catch { /* The original error is the useful one. */ }
  }

  async function start() {
    if (disposed || active) return false;
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > MAX_DURATION_MS ||
        !Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES ||
        !Number.isFinite(stopWatchdogMs) || stopWatchdogMs <= 0 || stopWatchdogMs > 10_000) {
      safeCallback(onError, new Error('Capture limits are outside the supported bounds'));
      return false;
    }
    if (typeof getUserMedia !== 'function' || typeof Recorder !== 'function') {
      safeCallback(onError, new Error('Audio capture is unavailable'));
      return false;
    }
    const session = {
      id: ++generation,
      stream: null,
      recorder: null,
      chunks: [],
      bytes: 0,
      mimeType: '',
      durationTimer: null,
      watchdogTimer: null,
      finishing: false,
      finished: false,
    };
    active = session;
    state(session, 'requesting');
    if (active !== session) return false;
    let stream;
    try { stream = await getUserMedia({ audio: true }); }
    catch (error) {
      if (active === session) finish(session, 'error', error);
      return false;
    }
    if (active !== session || disposed) {
      stopTracks(stream);
      return false;
    }
    session.stream = stream;

    try {
      const mimeType = MIME_TYPES.find(type => {
        try { return typeof Recorder.isTypeSupported === 'function' && Recorder.isTypeSupported(type); }
        catch { return false; }
      });
      if (!mimeType) throw new Error('No supported audio recording format');
      session.mimeType = mimeType;
      session.recorder = new Recorder(stream, { mimeType });
      const recorder = session.recorder;
      const actualMimeType = String(recorder.mimeType || '').trim().toLowerCase();
      if (actualMimeType && (!CONTAINERS.has(containerType(actualMimeType)) ||
          containerType(actualMimeType) !== containerType(mimeType))) {
        throw new Error('Recorder selected an unsupported audio format');
      }
      recorder.addEventListener('dataavailable', event => {
        if (active !== session || session.recorder !== recorder) return;
        const chunk = event?.data;
        if (!chunk || chunk.size <= 0) return;
        const chunkType = String(chunk.type || '').trim().toLowerCase();
        if (chunkType && (!CONTAINERS.has(containerType(chunkType)) ||
            containerType(chunkType) !== containerType(session.mimeType))) {
          terminate(session, new Error('Recorder produced an unsupported audio format'));
          return;
        }
        session.bytes += chunk.size;
        if (session.bytes > maxBytes) {
          terminate(session, new Error('Recording exceeded the configured size limit'));
          return;
        }
        session.chunks.push(chunk);
      });
      recorder.addEventListener('error', event => {
        if (active === session && session.recorder === recorder) {
          terminate(session, event?.error ?? new Error('Recorder failed'));
        }
      });
      recorder.addEventListener('stop', () => {
        if (active !== session || session.recorder !== recorder) return;
        clearTimer(session, 'watchdogTimer');
        const outcome = session.outcome ?? 'complete';
        if (outcome === 'complete' && session.bytes > 0) finish(session, 'complete');
        else if (outcome === 'complete') finish(session, 'empty');
        else finish(session, outcome);
      });
      recorder.start();
      state(session, 'recording');
      if (active !== session) return false;
      session.durationTimer = timers.setTimeout(() => requestStop(session, 'complete'), maxDurationMs);
      return true;
    } catch (error) {
      terminate(session, error);
      return false;
    }
  }

  function release() {
    const session = active;
    if (!session) return;
    if (!session.stream) { finish(session, 'cancelled'); return; }
    requestStop(session, 'complete');
  }

  function cancel() {
    generation++;
    const session = active;
    if (!session) return;
    session.finishing = true;
    const recorder = session.recorder;
    finish(session, 'cancelled');
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
    catch { /* Cancellation still releases the stream. */ }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel('disposed');
  }

  return Object.freeze({
    start,
    release,
    cancel,
    pointerCancel: () => cancel('pointercancel'),
    lostPointerCapture: () => cancel('lostpointercapture'),
    pageHide: () => cancel('pagehide'),
    targetChanged: () => cancel('targetchange'),
    dispose,
    get state() { return active ? (active.finishing ? 'stopping' : active.stream ? 'recording' : 'requesting') : 'idle'; },
  });
}

export const TESLAMON_CAPTURE_LIMITS = Object.freeze({ maxDurationMs: MAX_DURATION_MS, maxBytes: MAX_BYTES });
