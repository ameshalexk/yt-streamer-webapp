import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { orderedPrefetch } from "../public/ordered-prefetch.mjs";

test("first segment becomes available before slower lookahead segments", async () => {
  const resolvers = new Map();
  const started = [];
  const pending = (index) => new Promise((resolve) => {
    started.push(index);
    resolvers.set(index, resolve);
  });
  const iterator = orderedPrefetch([1, 2, 3, 4], pending, { concurrency: 3 });
  const first = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);
  resolvers.get(3)("third");
  resolvers.get(1)("first");
  assert.deepEqual((await first).value, { index: 1, value: "first" });
  const second = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(started.includes(4), "lookahead refills after first segment");
  resolvers.get(2)("second");
  assert.deepEqual((await second).value, { index: 2, value: "second" });
  assert.deepEqual((await iterator.next()).value, { index: 3, value: "third" });
  resolvers.get(4)("fourth");
  assert.deepEqual((await iterator.next()).value, { index: 4, value: "fourth" });
  assert.equal((await iterator.next()).done, true);
});

test("limits concurrent fetches and yields in order", async () => {
  let active = 0;
  let maximum = 0;
  const yielded = [];
  for await (const entry of orderedPrefetch([1, 2, 3, 4, 5, 6, 7], async (index) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    active--;
    return index * 10;
  }, { concurrency: 2 })) yielded.push(entry);
  assert.ok(maximum <= 2);
  assert.deepEqual(yielded.map((e) => e.index), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(yielded.map((e) => e.value), [10, 20, 30, 40, 50, 60, 70]);
});

test("stopping during an ahead-of-time failure has no unhandled rejection", async () => {
  let stopped = false;
  const generator = orderedPrefetch([1, 2, 3], async (index) => {
    if (index === 2) throw new Error("background failure");
    return index;
  }, { concurrency: 3, shouldStop: () => stopped });
  assert.equal((await generator.next()).value.index, 1);
  stopped = true;
  assert.equal((await generator.next()).done, true);
});

test("reports failed required segments", async () => {
  const generator = orderedPrefetch([1, 2], async (index) => {
    if (index === 2) throw new Error("HTTP 403");
    return index;
  });
  assert.equal((await generator.next()).value.index, 1);
  await assert.rejects(generator.next(), /HTTP 403/);
});

test("prepared WebCodecs path uses progressive ordered prefetch", () => {
  const src = fs.readFileSync(new URL("../public/cyberdash-embedded.mjs", import.meta.url), "utf8");
  assert.match(src, /for await \(const \{ index, value: ab \} of orderedPrefetch/);
  assert.match(src, /concurrency: 4, shouldStop:/);
  assert.doesNotMatch(src, /await Promise\.all\(indexes\.map/);
});
