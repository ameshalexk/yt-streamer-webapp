const TARGET_RATE = 16000;
const MAX_DURATION_MS = 7000;
const INITIAL_SILENCE_MS = 5000;
const END_SILENCE_MS = 1000;
const SETUP_TIMEOUT_MS = 15000;
const NO_INPUT_TIMEOUT_MS = 1500;
const MIN_VOICED_MS = 50;
const MIN_VOICE_THRESHOLD = 0.0015;
const MAX_VOICE_THRESHOLD = 0.006;
const NOISE_CALIBRATION_MS = 350;

export class NoSpeechError extends Error {
  constructor(message = 'The microphone was very quiet. Move closer and try again.', diagnostics = null) {
    super(message);
    this.name = 'NoSpeechError';
    this.code = 'no-speech';
    this.diagnostics = diagnostics;
  }
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

export class CaptureAbortedError extends Error {
  constructor() {
    super('Microphone capture was canceled.');
    this.name = 'AbortError';
  }
}

/** Resample mono PCM with a windowed averaging path for downsampling and linear interpolation otherwise. */
export function resampleMono(input, inputRate, outputRate = TARGET_RATE) {
  if (!(input instanceof Float32Array)) input = Float32Array.from(input || []);
  if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
    throw new RangeError('Sample rates must be positive finite numbers.');
  }
  if (input.length === 0) return new Float32Array(0);
  if (inputRate === outputRate) return input.slice();

  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  if (inputRate > outputRate) {
    const ratio = inputRate / outputRate;
    for (let i = 0; i < outputLength; i++) {
      const start = i * ratio;
      const end = Math.min(input.length, (i + 1) * ratio);
      let weighted = 0;
      let weight = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) {
        const overlap = Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
        weighted += input[j] * overlap;
        weight += overlap;
      }
      output[i] = weight ? weighted / weight : 0;
    }
  } else {
    const scale = inputRate / outputRate;
    for (let i = 0; i < outputLength; i++) {
      const position = Math.min(input.length - 1, i * scale);
      const left = Math.floor(position);
      const fraction = position - left;
      const right = Math.min(input.length - 1, left + 1);
      output[i] = input[left] + (input[right] - input[left]) * fraction;
    }
  }
  return output;
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch {}
  }
}

function friendlyCaptureError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return new Error('Microphone permission was denied. You can still use the trick buttons.');
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return new Error('No microphone is available in this browser. You can still use the trick buttons.');
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return new Error('The microphone could not be started. Close other apps using it and try again.');
  }
  return error instanceof Error ? error : new Error('Microphone capture could not start. You can still use the trick buttons.');
}

/**
 * Capture one explicit push-to-talk utterance and return mono PCM at 16 kHz.
 * Call only from a user gesture. No audio leaves the page or is persisted here.
 */
export function captureUtterance({ signal, onLevel = () => {}, onListening = () => {}, onDiagnostics = () => {}, onReady = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = Boolean(signal?.aborted);
    let stream = null;
    let context = null;
    let source = null;
    let worklet = null;
    let silenceTimer = null;
    let maxTimer = null;
    let startTimer = null;
    let inputTimer = null;
    let setupTimer = null;
    let speechStarted = false;
    let captureStartedAt = 0;
    let voicedMs = 0;
    let calibrationMs = 0;
    let threshold = 0.003;
    let peakRms = 0;
    const noiseRms = [];
    const chunks = [];
    let sampleCount = 0;

    const cleanup = () => {
      clearTimeout(silenceTimer);
      clearTimeout(maxTimer);
      clearTimeout(startTimer);
      clearTimeout(inputTimer);
      clearTimeout(setupTimer);
      signal?.removeEventListener('abort', onAbort);
      if (worklet) {
        worklet.port.onmessage = null;
        try { worklet.port.close(); } catch {}
        try { worklet.disconnect(); } catch {}
      }
      try { source?.disconnect(); } catch {}
      stopTracks(stream);
      if (context && context.state !== 'closed') {
        try { context.close(); } catch {}
      }
      try { onListening(false); } catch {}
    };
    const finish = (error, audio) => {
      if (settled) return;
      settled = true;
      const diagnostics = {
        durationMs: captureStartedAt ? Math.max(0, performance.now() - captureStartedAt) : 0,
        voicedMs: Math.round(voicedMs),
        peakRms: Number(peakRms.toFixed(5)),
        threshold: Number(threshold.toFixed(5)),
        frames: sampleCount,
        sampleRate: context?.sampleRate || 0
      };
      try { onDiagnostics(diagnostics); } catch {}
      if (error instanceof NoSpeechError) error.diagnostics = diagnostics;
      cleanup();
      error ? reject(error) : resolve(audio);
    };
    const onAbort = () => {
      aborted = true;
      finish(new CaptureAbortedError());
    };
    const append = chunk => {
      const copy = chunk instanceof Float32Array ? chunk.slice() : Float32Array.from(chunk || []);
      if (!copy.length) return;
      chunks.push(copy);
      sampleCount += copy.length;
    };
    const finishAudio = () => {
      if (voicedMs < MIN_VOICED_MS || sampleCount < TARGET_RATE * 0.05) {
        finish(new NoSpeechError('The microphone was very quiet. Move closer and try again.'));
        return;
      }
      const audio = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
      finish(null, audio);
    };

    if (aborted) { finish(new CaptureAbortedError()); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }

    setupTimer = setTimeout(() => {
      finish(new Error('Microphone setup took too long. Check permission and try again.'));
    }, SETUP_TIMEOUT_MS);

    const begin = async () => {
      try {
        if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.AudioContext) {
          throw new Error('Live microphone capture is unavailable in this browser. You can still use the trick buttons.');
        }
        // Invoke both APIs before the first await while the explicit tap's activation is live.
        context = new AudioContext({ latencyHint: 'interactive' });
        let resumePromise;
        try {
          resumePromise = Promise.resolve(context.resume()).catch(() => false);
        } catch {
          resumePromise = Promise.resolve(false);
        }
        const modulePromise = context.audioWorklet.addModule(new URL('./audio-worklet.js?v=f8811a237203', import.meta.url));
        // The module can fail while getUserMedia is still waiting for the permission prompt.
        modulePromise.catch(() => {});
        const mediaPromise = navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true }
        });
        // Keep processing unfiltered so children speaking over one another remain audible.
        stream = await mediaPromise;
        if (aborted || settled) { stopTracks(stream); return; }
        await Promise.all([modulePromise, resumePromise]);
        if (aborted || settled) return;
        source = context.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(context, 'teslamon-mono-capture', {
          numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'
        });
        worklet.port.onmessage = event => {
          if (settled || aborted) return;
          const samples = event.data;
          if (!(samples instanceof Float32Array) || !samples.length) return;
          clearTimeout(inputTimer);
          inputTimer = null;
          let squareSum = 0;
          for (let i = 0; i < samples.length; i++) squareSum += samples[i] * samples[i];
          const rms = Math.sqrt(squareSum / samples.length);
          const elapsedMs = samples.length * 1000 / context.sampleRate;
          peakRms = Math.max(peakRms, rms);
          // A log-scaled meter makes quiet but usable input visible instead of rounding it to zero.
          const level = rms > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60)) : 0;
          try { onLevel(level); } catch {}

          if (!speechStarted) {
            append(resampleMono(samples, context.sampleRate));
            if (rms >= threshold) {
              speechStarted = true;
              voicedMs += elapsedMs;
              silenceTimer = setTimeout(finishAudio, END_SILENCE_MS);
              try { onListening(true); } catch {}
            } else if (rms <= MIN_VOICE_THRESHOLD && calibrationMs < NOISE_CALIBRATION_MS) {
              // Learn only near-silent blocks. The estimate can lower the initial
              // gate, never raise it, so a soft initial phoneme cannot be learned as noise.
              noiseRms.push(rms);
              calibrationMs += elapsedMs;
              threshold = Math.max(MIN_VOICE_THRESHOLD, Math.min(threshold, percentile(noiseRms, 0.25) * 1.7));
            }
            return;
          }

          append(resampleMono(samples, context.sampleRate));
          if (rms >= threshold) {
            voicedMs += elapsedMs;
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(finishAudio, END_SILENCE_MS);
          }
        };
        source.connect(worklet);
        if (context.state === 'suspended') {
          try { await context.resume(); } catch { /* Some browsers reject until a live input is connected. */ }
        }
        if (aborted || settled) return;
        clearTimeout(setupTimer);
        setupTimer = null;
        captureStartedAt = performance.now();
        if (!sampleCount) {
          inputTimer = setTimeout(() => {
            if (!sampleCount) finish(new Error('The microphone opened, but no audio arrived. Check the selected microphone and try again.'));
          }, NO_INPUT_TIMEOUT_MS);
        }
        startTimer = setTimeout(() => {
          if (!speechStarted) finish(new NoSpeechError());
        }, INITIAL_SILENCE_MS);
        maxTimer = setTimeout(finishAudio, MAX_DURATION_MS);
        try { onListening(true); } catch {}
        try { onReady(finishAudio); } catch {}
      } catch (error) {
        if (settled) return;
        finish(aborted ? new CaptureAbortedError() : friendlyCaptureError(error));
      }
    };
    void begin();
  });
}
