// A bounded, local energy-based end-of-speech hint for a single command.
// No audio samples leave this module; the parent controller owns mic tracks.
export function createTeslaMonSilenceMonitor({
  stream,
  onSpeechEnd = () => {},
  onNoSpeech = () => {},
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  timers = globalThis,
  now = () => Date.now(),
  threshold = 0.018,
  speechFrames = 2,
  silenceMs = 1200,
  noSpeechMs = 3500,
  checkMs = 100,
} = {}) {
  let context = null, source = null, analyser = null, interval = null;
  let startedAt = 0, lastSpeechAt = 0, voicedFrames = 0;
  let seenSpeech = false, stopped = false, started = false;
  const frame = new Float32Array(2048);

  function stop() {
    if (stopped) return;
    stopped = true;
    if (interval !== null) { timers.clearInterval(interval); interval = null; }
    try { source?.disconnect?.(); } catch {}
    try { analyser?.disconnect?.(); } catch {}
    try { const close = context?.close?.(); if (close?.catch) void close.catch(() => {}); } catch {}
    source = null; analyser = null; context = null;
  }

  function tick() {
    if (stopped || !analyser) return;
    try {
      analyser.getFloatTimeDomainData(frame);
      let energy = 0;
      for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
      const rms = Math.sqrt(energy / frame.length);
      const time = now();
      if (rms >= threshold) {
        voicedFrames++;
        if (voicedFrames >= speechFrames) {
          seenSpeech = true;
          lastSpeechAt = time;
        }
      } else {
        voicedFrames = 0;
      }
      if (seenSpeech && time - lastSpeechAt >= silenceMs) {
        stop();
        try { onSpeechEnd(); } catch {}
      } else if (!seenSpeech && time - startedAt >= noSpeechMs) {
        stop();
        try { onNoSpeech(); } catch {}
      }
    } catch {
      // If the context is suspended or disconnected, the bounded recorder
      // timeout remains authoritative; do not submit an unverified clip.
      stop();
    }
  }

  async function start() {
    if (started || stopped || !stream || typeof AudioContextClass !== 'function') return false;
    started = true;
    try {
      context = new AudioContextClass();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = frame.length;
      source.connect(analyser); // Never connect to speakers.
      const resume = context.resume?.();
      if (resume?.then) await resume;
      if (stopped) return false;
      startedAt = now();
      interval = timers.setInterval(tick, checkMs);
      return true;
    } catch {
      stop();
      return false;
    }
  }
  return Object.freeze({start,stop});
}
