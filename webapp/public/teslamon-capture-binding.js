/** Bind an existing button to an explicitly pressed TeslaMon capture controller. */
export function bindTeslaMonCaptureButton({ button, capture, document, window, onError } = {}) {
  if (!button?.addEventListener || !button?.removeEventListener || !capture ||
      !document?.addEventListener || !window?.addEventListener ||
      !['start', 'release', 'cancel', 'targetChanged', 'dispose'].every(name => typeof capture[name] === 'function')) {
    throw new TypeError('button, capture, document, and window are required');
  }

  let held = null;
  let disposed = false;

  function report(error) {
    try { onError?.(error instanceof Error ? error : new Error(String(error))); }
    catch { /* UI error handlers must not break input cleanup. */ }
  }

  function invoke(method, args) {
    try {
      const result = capture[method](...(args ?? []));
      if (method === 'start') return Promise.resolve(result);
    } catch (error) {
      if (method === 'start') return Promise.reject(error);
      report(error);
    }
    return Promise.resolve();
  }

  function start(press) {
    invoke('start').then(started => {
      // A busy/denied controller did not acquire this press. Do not let its
      // later release cancel a different recording that is still finishing.
      if (started === false && held === press) clearHeld();
    }).catch(error => {
      report(error);
      if (held === press) {
        clearHeld();
        invoke('cancel');
      }
    });
  }

  function clearHeld() {
    const previous = held;
    held = null;
    if (previous?.kind === 'pointer') {
      try {
        if (button.hasPointerCapture?.(previous.id)) button.releasePointerCapture(previous.id);
      } catch { /* Capture may already have been released by the browser. */ }
    }
    return previous;
  }

  function cancelHeld() {
    if (!held) return;
    clearHeld();
    invoke('cancel');
  }

  function hasModifier(event) {
    return Boolean(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
  }

  function onPointerDown(event) {
    if (disposed || button.disabled || held || event.button !== 0 || event.isPrimary === false || hasModifier(event)) return;
    const id = event.pointerId;
    if (id === undefined) return;
    try {
      button.setPointerCapture(id);
    } catch (error) {
      report(error);
      return;
    }
    held = { kind: 'pointer', id };
    event.preventDefault?.();
    start(held);
  }

  function onPointerUp(event) {
    if (!held || held.kind !== 'pointer' || held.id !== event.pointerId) return;
    event.preventDefault?.();
    clearHeld(); // lostpointercapture after an ordinary release is therefore harmless.
    invoke('release');
  }

  function onPointerCancel(event) {
    if (held?.kind === 'pointer' && held.id === event.pointerId) {
      event.preventDefault?.();
      cancelHeld();
    }
  }

  function onLostPointerCapture(event) {
    if (held?.kind === 'pointer' && held.id === event.pointerId) cancelHeld();
  }

  function onKeyDown(event) {
    if (disposed || button.disabled || hasModifier(event)) return;
    if (held?.kind === 'key' && held.key === event.key) { event.preventDefault?.(); return; }
    if (event.key === 'Escape') {
      event.preventDefault?.();
      onBlur();
      return;
    }
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat || held) return;
    held = { kind: 'key', key: event.key };
    event.preventDefault?.();
    start(held);
  }

  function onKeyUp(event) {
    if (held?.kind !== 'key' || held.key !== event.key) return;
    event.preventDefault?.();
    clearHeld();
    invoke('release');
  }

  function onVisibilityChange() {
    if (document.hidden) onBlur();
  }

  function onBlur() {
    clearHeld();
    invoke('cancel');
  }

  const listeners = [
    [button, 'pointerdown', onPointerDown],
    [button, 'pointerup', onPointerUp],
    [button, 'pointercancel', onPointerCancel],
    [button, 'lostpointercapture', onLostPointerCapture],
    [button, 'keydown', onKeyDown],
    [button, 'keyup', onKeyUp],
    [button, 'blur', onBlur],
    [document, 'visibilitychange', onVisibilityChange],
    [window, 'blur', onBlur],
    [window, 'pagehide', onBlur],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

  return Object.freeze({
    targetChanged() {
      if (disposed) return;
      clearHeld();
      invoke('cancel');
      invoke('targetChanged');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearHeld();
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
      invoke('cancel');
      invoke('dispose');
    },
  });
}
