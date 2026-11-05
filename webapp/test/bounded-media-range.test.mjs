import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openBoundedMediaRange } from "../src/lib/bounded-media-range.js";

const WINDOW = 256 * 1024;

function responseFor(data, start, end, total, { status = 206, contentRange = `bytes ${start}-${end}/${total}` } = {}) {
  return new Response(data.subarray(start, end + 1), {
    status,
    headers: { "content-range": contentRange, "content-type": "video/mp4" },
  });
}

async function collect(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("no Range stitches bounded upstream ranges and returns a complete 200 body", async () => {
  const source = Buffer.from(Array.from({ length: WINDOW * 2 + 19 }, (_, i) => i % 251));
  const calls = [];
  const result = await openBoundedMediaRange({
    fetchRange: async ({ start, end }) => {
      calls.push([start, end]);
      return responseFor(source, start, Math.min(end, source.length - 1), source.length);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers.has("content-range"), false);
  assert.equal(result.headers.get("content-length"), String(source.length));
  assert.equal(result.headers.get("content-type"), "video/mp4");
  assert.deepEqual(await collect(result.body), source);
  assert.deepEqual(calls, [[0, WINDOW - 1], [WINDOW, WINDOW * 2 - 1], [WINDOW * 2, source.length - 1]]);
});

test("open-ended range at the tail returns a complete 206 range", async () => {
  const source = Buffer.from("0123456789abcdefghij");
  const calls = [];
  const result = await openBoundedMediaRange({
    rangeHeader: "bytes=13-",
    fetchRange: async ({ start, end }) => {
      calls.push([start, end]);
      return responseFor(source, start, Math.min(end, source.length - 1), source.length);
    },
  });

  assert.equal(result.status, 206);
  assert.equal(result.headers.get("content-range"), "bytes 13-19/20");
  assert.equal(result.headers.get("content-length"), "7");
  assert.deepEqual(await collect(result.body), source.subarray(13));
  assert.deepEqual(calls, [[13, 13 + WINDOW - 1]]);
});

test("finite, malformed, and multi-range requests are ineligible without fetching", async () => {
  let calls = 0;
  const fetchRange = async () => { calls++; throw new Error("unexpected fetch"); };
  for (const rangeHeader of ["bytes=1-8", "bytes=-8", "bytes=1-2,4-5", "items=1-", "bytes=01-"]) {
    assert.equal(await openBoundedMediaRange({ rangeHeader, fetchRange }), null, rangeHeader);
  }
  assert.equal(calls, 0);
});

test("first refusal or malformed range cancels upstream and returns null for fallback", async () => {
  for (const response of [
    new Response("no range", { status: 200 }),
    new Response("bad", { status: 206, headers: { "content-range": "bytes 1-3/4" } }),
    new Response("short", { status: 206, headers: { "content-range": "bytes 0-3/4" } }),
    new Response("encoded", { status: 206, headers: { "content-range": "bytes 0-6/7", "content-encoding": "gzip" } }),
  ]) {
    const result = await openBoundedMediaRange({ rangeHeader: "bytes=0-", fetchRange: async () => response });
    assert.equal(result, null);
    assert.equal(response.bodyUsed, true);
  }
});

test("stitched ranges retain and enforce an upstream validator", async () => {
  const source = Buffer.alloc(WINDOW * 2, 5);
  let calls = 0;
  const result = await openBoundedMediaRange({
    fetchRange: async ({ start, end }) => {
      calls++;
      const response = responseFor(source, start, end, source.length);
      response.headers.set("etag", calls === 1 ? '"v1"' : '"v2"');
      return response;
    },
  });
  assert.equal(result.headers.get("etag"), '"v1"');
  await assert.rejects(collect(result.body), /etag changed/);
  assert.equal(calls, 2);
});

test("malformed second range errors the downstream stream and makes no further request", async () => {
  const source = Buffer.alloc(WINDOW * 3, 7);
  let calls = 0;
  const result = await openBoundedMediaRange({
    fetchRange: async ({ start, end }) => {
      calls++;
      if (calls === 2) return new Response(source.subarray(start, end + 1), {
        status: 206, headers: { "content-range": `bytes ${start + 1}-${end + 1}/${source.length}` },
      });
      return responseFor(source, start, end, source.length);
    },
  });
  let received = 0;
  result.body.on("data", (chunk) => { received += chunk.length; });
  await assert.rejects(once(result.body, "end"));
  assert.equal(received, WINDOW);
  assert.equal(calls, 2);
});

test("downstream cancellation aborts the active request and prevents another range", async () => {
  const source = Buffer.alloc(WINDOW * 3, 9);
  let calls = 0;
  let secondSignal;
  const result = await openBoundedMediaRange({
    fetchRange: async ({ start, end, signal }) => {
      calls++;
      if (calls === 2) secondSignal = signal;
      return responseFor(source, start, end, source.length);
    },
  });
  result.body.once("data", () => result.body.destroy());
  await once(result.body, "close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(secondSignal, undefined);
});

test("external abort is passed through and prevents another range", async () => {
  const source = Buffer.alloc(WINDOW * 3, 9);
  const parent = new AbortController();
  let calls = 0;
  let receivedSignal;
  const result = await openBoundedMediaRange({
    signal: parent.signal,
    fetchRange: async ({ start, end, signal }) => {
      calls++;
      receivedSignal = signal;
      return responseFor(source, start, end, source.length);
    },
  });
  parent.abort();
  assert.equal(receivedSignal.aborted, true);
  await collect(result.body);
  assert.equal(calls, 1);
});
