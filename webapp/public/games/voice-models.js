/** Locally bundled Whisper models supported by the browser voice engine. */
export const VOICE_MODELS = Object.freeze({
  'whisper-tiny.en': Object.freeze({
    modelId: 'whisper-tiny.en',
    label: 'Whisper Tiny English',
    directory: 'whisper-tiny-en-79fb389',
    revision: '79fb389fc764e7c395bd330e9531d9d32ada7049',
    dtype: 'q8',
    loadTimeoutMs: 120_000,
    transcribeTimeoutMs: 45_000
  }),
  'whisper-base.en': Object.freeze({
    modelId: 'whisper-base.en',
    label: 'Whisper Base English',
    directory: 'whisper-base-en-95bf40a',
    revision: '95bf40a508535962c6483ead40270b2e32267508',
    dtype: 'q8',
    loadTimeoutMs: 180_000,
    transcribeTimeoutMs: 120_000
  })
});

export function getVoiceModel(modelId = 'whisper-tiny.en') {
  if (typeof modelId !== 'string' || !Object.hasOwn(VOICE_MODELS, modelId)) {
    throw new Error(`Unsupported voice model: ${String(modelId)}.`);
  }
  return VOICE_MODELS[modelId];
}
