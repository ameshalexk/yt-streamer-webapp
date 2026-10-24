import { resampleMono } from './audio-capture.js?v=e7ecb194ea4f';

const MAX_RECORDING_BYTES = 20 * 1024 * 1024;
const MAX_RECORDING_SECONDS = 16;

function abortError() {
  const error = new Error('Local transcription was canceled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Convert a completed, browser-local MediaRecorder clip into Whisper's mono
 * 16 kHz samples. The blob is never uploaded or persisted.
 *
 * The game captures PCM directly through its AudioWorklet; Streamer can keep
 * its existing hold-to-talk and Hey Jarvis recorder/permission lifecycle.
 */
export async function decodeRecordedAudio(blob, {
  signal,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
} = {}) {
  if (signal?.aborted) throw abortError();
  if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size) {
    throw new Error('No audio was captured. Try recording again or type a command.');
  }
  if (blob.size > MAX_RECORDING_BYTES) {
    throw new Error('This voice recording is too large. Try a shorter command.');
  }
  if (typeof AudioContextClass !== 'function') {
    throw new Error('This browser cannot decode local audio. Type a command instead.');
  }

  let context;
  try {
    context = new AudioContextClass();
    const bytes = await blob.arrayBuffer();
    if (signal?.aborted) throw abortError();
    let buffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch {
      throw new Error('This browser could not decode its recording locally. Type the command instead.');
    }
    if (signal?.aborted) throw abortError();
    if (!Number.isFinite(buffer?.duration) || buffer.duration <= 0 ||
        buffer.duration > MAX_RECORDING_SECONDS || !Number.isFinite(buffer.sampleRate) ||
        buffer.sampleRate <= 0 || !buffer.numberOfChannels || !buffer.length) {
      throw new Error('The recording duration or audio data is invalid. Try a shorter command.');
    }

    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      if (samples.length !== mono.length) {
        throw new Error('The browser returned inconsistent audio channels.');
      }
      for (let i = 0; i < mono.length; i++) {
        mono[i] += samples[i] / buffer.numberOfChannels;
      }
    }
    if (signal?.aborted) throw abortError();
    return resampleMono(mono, buffer.sampleRate);
  } finally {
    try { await context?.close?.(); } catch {}
  }
}
