export const MODEL_CACHE_FILES = Object.freeze([
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]);

/** Inspect Transformers.js' own CacheStorage entries without requesting persistence. */
export async function inspectModelCache({ cacheStorage, modelBase, modelId, files = MODEL_CACHE_FILES }) {
  const result = { cacheState: 'unavailable', cachedFiles: 0, totalFiles: files.length, cachedFileNames: [] };
  if (!cacheStorage || typeof cacheStorage.open !== 'function') return result;

  try {
    const cache = await cacheStorage.open('transformers-cache');
    for (const file of files) {
      const key = new URL(`${modelId}/${file}`, modelBase).href;
      if (await cache.match(key)) result.cachedFileNames.push(file);
    }
    result.cachedFiles = result.cachedFileNames.length;
    result.cacheState = result.cachedFiles === files.length && files.length > 0
      ? 'complete'
      : result.cachedFiles > 0 ? 'partial' : 'empty';
    return result;
  } catch {
    return result;
  }
}
