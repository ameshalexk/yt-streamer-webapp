// Serialize complete input operations per session, including awaited CDP calls.
const queues = new WeakMap();
export function enqueueBrowserInput(session, operation) {
  const result = (queues.get(session) || Promise.resolve()).then(operation);
  queues.set(session, result.catch(() => {}));
  return result;
}
