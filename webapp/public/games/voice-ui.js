/** Keeps first-use preparation separate from microphone capture and transcription. */
export function createVoiceController({ engine, capture, button, note, supported, setListening, say, onTranscript }) {
  let session = null;
  let phase = 'idle';
  let finishCapture = null;
  let lastDiagnostic = null;
  let processingTimer = null;

  const readyNote = () => {
    if (!engine.loaded) return 'Prepare local voice once, then tap Speak. Audio stays in this browser.';
    if (engine.modelInfo?.cacheState === 'unavailable') return 'Voice ready · Browser storage is unavailable; keep this page open to reuse the model.';
    if (engine.modelInfo?.cacheState === 'complete') return 'Voice ready · Model saved in this browser. Audio stays here.';
    return 'Voice ready · Model loaded for this page. Keep this page open to reuse it.';
  };
  function idle({ preserveNote = false } = {}) {
    clearInterval(processingTimer);
    processingTimer = null;
    phase = 'idle';
    finishCapture = null;
    setListening(false);
    button.disabled = !supported();
    button.setAttribute('aria-pressed', 'false');
    button.textContent = !supported() ? 'Voice unavailable' : engine.loaded ? '🎙️ Tap to speak' : '🎙️ Prepare voice';
    if (!preserveNote) note.textContent = readyNote();
  }
  const isCurrent = controller => session === controller && !controller.signal.aborted;
  function cancel() {
    const controller = session;
    session = null;
    controller?.abort();
    engine.cancelPending();
    idle();
  }
  async function activate() {
    if (!supported()) {
      say('Local voice needs HTTPS, a microphone, AudioWorklet and WebAssembly. Touch tricks are ready.', 'warn');
      return;
    }
    if (session) {
      // A repeat tap ends the utterance; only Stop cancels model preparation/inference.
      if (phase === 'listening') finishCapture?.();
      return;
    }
    const controller = new AbortController();
    session = controller;
    lastDiagnostic = null;
    try {
      if (!engine.loaded) {
        phase = 'preparing';
        button.disabled = true;
        button.setAttribute('aria-pressed', 'false');
        button.textContent = 'Preparing voice…';
        note.textContent = 'Checking saved model… First download is about 65 MB. Microphone is off.';
        say('Preparing voice first. Wait for Voice ready, then tap Speak.');
        await engine.load({ signal: controller.signal, onProgress: progress => {
          if (!isCurrent(controller)) return;
          const percent = Number.isFinite(progress.progress) ? ' ' + Math.round(progress.progress) + '%' : '';
          if (progress.phase === 'download') note.textContent = 'Fetching voice files' + percent + ' · Saved files are reused. Microphone is off.';
          else if (progress.phase === 'cached') note.textContent = 'Loading saved voice' + percent + ' · No new model download. Microphone is off.';
          else note.textContent = 'Starting local voice model… Microphone is off. Wait for Voice ready.';
        }});
        if (!isCurrent(controller)) return;
        session = null;
        idle();
        say('Voice ready. Tap Speak, then say Jump, Roll over, Sit or Spin.', 'ok');
        return;
      }

      phase = 'starting';
      button.disabled = true;
      button.setAttribute('aria-pressed', 'true');
      button.textContent = 'Starting mic…';
      note.textContent = 'Voice model ready · Opening microphone…';
      say('Allow the microphone, then wait for Listening.');
      let lastLevelUpdate = 0;
      const audio = await capture({ signal: controller.signal,
        onReady: finish => { if (isCurrent(controller)) finishCapture = finish; },
        onListening: listening => {
          if (!isCurrent(controller)) return;
          setListening(listening);
          if (listening) {
            phase = 'listening';
            button.disabled = false;
            button.textContent = '🎙️ Finish speaking';
            note.textContent = 'Listening · Model ready. Say a trick, then pause or tap Finish speaking.';
            say('Listening. Say Jump, Roll over, Sit or Spin.');
          }
        },
        onLevel: level => {
          if (!isCurrent(controller) || phase !== 'listening') return;
          const now = Date.now();
          if (now - lastLevelUpdate < 200) return;
          lastLevelUpdate = now;
          note.textContent = 'Listening · Mic level ' + Math.round(level * 100) + '% · Say a trick, then pause.';
        },
        onDiagnostics: diagnostic => { if (isCurrent(controller)) lastDiagnostic = diagnostic; }
      });
      if (!isCurrent(controller)) return;
      phase = 'transcribing';
      setListening(false);
      finishCapture = null;
      button.disabled = true;
      button.textContent = 'Transcribing…';
      const started = Date.now();
      const progress = () => {
        if (!isCurrent(controller)) return;
        const seconds = Math.floor((Date.now() - started) / 1000);
        note.textContent = 'Transcribing this recording locally · ' + seconds + 's · Model already loaded.';
      };
      progress();
      processingTimer = setInterval(progress, 1000);
      say('Transcribing your trick. Microphone is off.');
      const result = await engine.transcribe(audio, { signal: controller.signal });
      if (!isCurrent(controller)) return;
      const phrase = result.text.trim();
      session = null;
      idle({ preserveNote: true });
      note.textContent = phrase ? 'Heard “' + phrase.slice(0, 100) + '” · Model ready.' : 'No words recognized · Model ready. Try speaking closer to the microphone.';
      onTranscript(phrase);
    } catch (error) {
      if (!isCurrent(controller)) return;
      session = null;
      controller.abort();
      engine.cancelPending();
      lastDiagnostic = error?.diagnostics || lastDiagnostic;
      idle();
      say(error?.message || 'Local voice could not start. Try again or use a trick button.', 'warn');
    }
  }
  idle();
  return { activate, cancel, getState: () => ({ phase, ready: engine.loaded, modelInfo: engine.modelInfo, lastDiagnostic }) };
}
