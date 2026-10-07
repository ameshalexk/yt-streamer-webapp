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
      const index = indexes[nextToSchedule++];
      const result = Promise.resolve().then(() => fetchIndex(index)).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      pending.set(index, result);
    }
  };
  fill();
  for (const index of indexes) {
    if (shouldStop()) return;
    const result = await pending.get(index);
    pending.delete(index);
    fill();
    if (shouldStop()) return;
    if (result.error) throw result.error;
    yield { index, value: result.value };
  }
}
