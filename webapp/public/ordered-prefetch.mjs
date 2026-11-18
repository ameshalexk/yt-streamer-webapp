// Prefetch a bounded number of segments, but release each in presentation
// order as soon as it is ready. Settled errors prevent orphaned rejections.
export async function* orderedPrefetch(indexes, fetchIndex, {
  concurrency = 4,
  shouldStop = () => false,
} = {}) {
  const maximum = Math.max(1, Math.min(6, Math.floor(Number(concurrency) || 4)));
  const pending = new Map();
  let nextToSchedule = 0;
  const fill = () => {
    while (!shouldStop() && nextToSchedule < indexes.length && pending.size < maximum) {
      // Use the presentation slot as the key: repeated segment indexes must
      // not overwrite each other's inflight requests.
      const slot = nextToSchedule++;
      const index = indexes[slot];
      const result = Promise.resolve().then(() => fetchIndex(index)).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      pending.set(slot, result);
    }
  };
  fill();
  for (let slot = 0; slot < indexes.length; slot++) {
    if (shouldStop()) return;
    const result = await pending.get(slot);
    pending.delete(slot);
    fill();
    if (shouldStop()) return;
    if (!result.ok) throw result.error;
    yield { index: indexes[slot], value: result.value };
  }
}
