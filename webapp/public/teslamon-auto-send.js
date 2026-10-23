// Auto-submit a completed TeslaMon text command after the user stops editing.
// The browser provides no trustworthy "came from dictation" signal, so this
// deliberately treats keyboard input, paste and native dictation identically.
export function createTeslaMonAutoSend({
  readText,
  send,
  canSend = () => true,
  timers = globalThis,
  delayMs = 2000,
} = {}) {
  if (typeof readText !== 'function' || typeof send !== 'function' ||
      typeof canSend !== 'function' || !Number.isFinite(delayMs) || delayMs < 250) {
    throw new TypeError('invalid_teslamon_auto_send_options');
  }
  let timer = null;
  let draft = '';
  let ready = false;
  let composing = false;
  let disposed = false;
  function clearTimer() {
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
  }
  function cancel() {
    clearTimer();
    draft = '';
    ready = false;
  }
  function flush() {
    if (disposed || composing || !ready || !canSend()) return false;
    const text = String(readText() || '').trim();
    if (!text) { cancel(); return false; }
    if (text !== draft) { changed(); return false; }
    cancel(); // At most one dispatch for each quiet period.
    send(text);
    return true;
  }
  function changed() {
    if (disposed || composing) return;
    cancel();
    draft = String(readText() || '').trim();
    if (!draft) return;
    timer = timers.setTimeout(() => {
      timer = null;
      ready = true;
      flush();
    }, delayMs);
  }
  function compositionStart() {
    if (disposed) return;
    composing = true;
    cancel();
  }
  function compositionEnd() {
    if (disposed) return;
    composing = false;
    changed();
  }
  function dispose() {
    disposed = true;
    cancel();
  }
  return Object.freeze({
    changed, flush, cancel, compositionStart, compositionEnd, dispose,
  });
}
