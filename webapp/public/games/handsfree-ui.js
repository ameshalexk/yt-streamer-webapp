/** Opt-in continuous, locally gated trick listening. Never starts from page load. */
export function createHandsFreeController({
  engine, capture, button, manualButton, note, supported, setListening,
  say, onTranscript, resetManual
}) {
  let session = null;
  let phase = 'off';
  let diagnostic = null;
  let progressTimer = null;
  let lastHeardAt = 0;
  let lastLevelAt = 0;

  const current = controller => session === controller && !controller.signal.aborted;
  const clearProgress = () => { clearInterval(progressTimer); progressTimer = null; };
  function offUI() {
    phase = 'off';
    clearProgress();
    setListening(false);
    button.disabled = !supported();
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Turn continuous local microphone on');
    button.dataset.state = 'off';
    button.textContent = supported() ? '🎤 Hands-free: Off' : 'Hands-free unavailable';
    resetManual();
    if (engine.loaded) note.textContent = 'Hands-free Off · Voice ready. Tap Speak or switch hands-free On.';
    else note.textContent = 'Hands-free Off · Prepare voice or turn hands-free On. Microphone is off.';
  }
  function onUI(label = '🎤 Hands-free: On') {
    button.disabled = false; // Off must work while loading, listening or transcribing.
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', 'Turn continuous local microphone off');
    button.dataset.state = label.includes('Starting') ? 'preparing' : 'on';
    button.textContent = label;
    manualButton.disabled = true; // One mic owner at a time.
  }
  function stop() {
    const controller = session;
    if (!controller) return;
    session = null; // Invalidate callbacks before stopping any tracks / model work.
    controller.abort();
    engine.cancelPending();
    offUI();
    say('Hands-free Off. Microphone stopped.', 'ok');
  }
  async function toggle() {
    if (session) { stop(); return; }
    if (!supported()) {
      say('Hands-free listening needs HTTPS, a microphone, AudioWorklet and WebAssembly. Touch tricks still work.', 'warn');
      return;
    }
    // The manual voice controller owns the same engine; cancel it before opting in.
    resetManual();
    const controller = new AbortController();
    session = controller;
    diagnostic = null;
    lastHeardAt = 0;
    phase = 'preparing';
    onUI('🎤 Hands-free: Starting…');
    setListening(false);
    try {
      if (!engine.loaded) {
        note.textContent = 'Preparing local voice first · Microphone is OFF. Saved model files will be reused.';
        say('Preparing local voice. Microphone is off until Voice ready.');
        await engine.load({signal: controller.signal, onProgress: progress => {
          if (!current(controller)) return;
          const percent = Number.isFinite(progress.progress) ? ' ' + Math.round(progress.progress) + '%' : '';
          note.textContent = progress.phase === 'download'
            ? 'Fetching voice files' + percent + ' · Microphone is OFF.'
            : progress.phase === 'cached'
              ? 'Loading saved voice' + percent + ' · Microphone is OFF.'
              : 'Preparing local voice · Microphone is OFF.';
        }});
      }
      if (!current(controller)) return;
      phase = 'starting';
      note.textContent = 'Voice ready · Opening hands-free microphone with your permission…';
      say('Voice ready. Starting hands-free listening.');
      await capture({
        signal: controller.signal,
        onListening: listening => {
          if (!current(controller)) return;
          if (listening && phase !== 'transcribing') {
            phase = 'listening';
            setListening(true);
            onUI();
            note.textContent = 'Mic ON · Listening locally. Say Jump, Roll over, Sit or Spin.';
            say('Hands-free On. Say a trick whenever you like.', 'ok');
          } else if (!listening) {
            setListening(false);
          }
        },
        onSpeech: () => {
          if (!current(controller)) return;
          note.textContent = 'Mic ON · Heard speech. Waiting for the end of your trick…';
        },
        onLevel: level => {
          if (!current(controller) || phase !== 'listening') return;
          const now = Date.now();
          if (now - lastLevelAt < 250 || now - lastHeardAt < 2000) return;
          lastLevelAt = now;
          note.textContent = 'Mic ON · Level ' + Math.round(level * 100) + '% · Say a trick anytime.';
        },
        onDiagnostics: details => { if (current(controller)) diagnostic = details; },
        onClip: async audio => {
          if (!current(controller)) return;
          phase = 'transcribing';
          setListening(false);
          const startedAt = Date.now();
          const update = () => {
            if (!current(controller)) return;
            note.textContent = 'Mic ON · Transcribing locally · ' +
              Math.floor((Date.now() - startedAt) / 1000) + 's · Model already loaded.';
          };
          update();
          clearProgress();
          progressTimer = setInterval(update, 1000);
          try {
            const result = await engine.transcribe(audio, {signal: controller.signal});
            if (!current(controller)) return;
            const phrase = String(result.text || '').trim();
            lastHeardAt = Date.now();
            note.textContent = phrase
              ? 'Mic ON · Heard “' + phrase.slice(0, 100) + '” · Listening resumes automatically.'
              : 'Mic ON · No words recognized. Listening resumes automatically.';
            if (phrase) onTranscript(phrase);
          } finally {
            clearProgress();
            if (current(controller)) {
              phase = 'listening';
              setListening(true);
            }
          }
        }
      });
      if (current(controller)) throw new Error('Microphone stopped unexpectedly. Switch hands-free On to retry.');
    } catch (error) {
      if (current(controller)) {
        diagnostic = error?.diagnostics || diagnostic;
        say(error?.message || 'Hands-free microphone could not start. Touch tricks still work.', 'warn');
      }
    } finally {
      if (session === controller) {
        session = null;
        controller.abort(); // Always release the stream if capture ended unexpectedly.
        engine.cancelPending();
        offUI();
      }
    }
  }
  offUI();
  return {toggle, stop, getState: () => ({
    phase, active: Boolean(session), ready: engine.loaded, diagnostic
  })};
}
