import { Readable } from "node:stream";

const RANGE_CHUNK_BYTES = 256 * 1024;

function parseOpenRange(value) {
  if (value == null || value === "") return { start: 0, ranged: false };
  const match = /^bytes=(0|[1-9]\d*)-$/.exec(String(value).trim());
  if (!match) return null;
  const start = Number(match[1]);
  return Number.isSafeInteger(start) ? { start, ranged: true } : null;
}

function parseContentRange(value) {
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

async function cancelBody(response) {
  try { await response?.body?.cancel(); } catch {}
}

async function readExactBlock(response, expectedLength) {
  if (!response.body) throw new Error("upstream range has no body");
  const reader = response.body.getReader();
  const block = new Uint8Array(expectedLength);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > expectedLength) {
        throw new Error("upstream range body is longer than Content-Range");
      }
      block.set(value, length);
      length += value.byteLength;
    }
    if (length !== expectedLength) throw new Error("upstream range body length does not match Content-Range");
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  return block;
}

function responseHeaders(upstream, { start, total, ranged }) {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("accept-ranges", "bytes");
  headers.set("content-length", String(total - start));
  if (ranged) headers.set("content-range", `bytes ${start}-${total - 1}/${total}`);
  for (const name of ["etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function hasIdentityEncoding(response) {
  const encoding = response?.headers?.get("content-encoding");
  return !encoding || encoding.trim().toLowerCase() === "identity";
}

/**
 * Stitch an open-ended byte range from bounded upstream ranges. `fetchRange`
 * receives `{start, end, signal}` with inclusive offsets. It returns a Fetch
 * Response. Finite/malformed ranges and an unusable first response return null
 * so the caller can use its normal proxy path.
 */
export async function openBoundedMediaRange({ rangeHeader, fetchRange, signal } = {}) {
  const requested = parseOpenRange(rangeHeader);
  if (!requested || requested.start > Number.MAX_SAFE_INTEGER - (RANGE_CHUNK_BYTES - 1) ||
      typeof fetchRange !== "function" || signal?.aborted) return null;

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromParent, { once: true });

  const fetchBlock = (start, end) => fetchRange({ start, end, signal: controller.signal });
  const firstEnd = requested.start + RANGE_CHUNK_BYTES - 1;
  let first;
  let firstData;
  let contentRange;
  try {
    first = await fetchBlock(requested.start, firstEnd);
    contentRange = first?.status === 206 && hasIdentityEncoding(first)
      ? parseContentRange(first.headers.get("content-range")) : null;
    if (!contentRange || contentRange.start !== requested.start ||
        contentRange.end !== Math.min(firstEnd, contentRange.total - 1)) {
      await cancelBody(first);
      signal?.removeEventListener("abort", abortFromParent);
      return null;
    }
    firstData = await readExactBlock(first, contentRange.end - contentRange.start + 1);
  } catch {
    await cancelBody(first);
    signal?.removeEventListener("abort", abortFromParent);
    return null;
  }

  const headers = responseHeaders(first, {
    start: requested.start,
    total: contentRange.total,
    ranged: requested.ranged,
  });
  const validators = Object.fromEntries(["etag", "last-modified"]
    .map((name) => [name, first.headers.get(name)]));
  const body = Readable.from((async function* stitch() {
    let offset = requested.start;
    try {
      yield firstData;
      offset = contentRange.end + 1;
      while (offset < contentRange.total && !controller.signal.aborted) {
        const end = Math.min(offset + RANGE_CHUNK_BYTES - 1, contentRange.total - 1);
        const upstream = await fetchBlock(offset, end);
        const range = upstream?.status === 206 && hasIdentityEncoding(upstream)
          ? parseContentRange(upstream.headers.get("content-range")) : null;
        if (!range || range.start !== offset || range.end !== end || range.total !== contentRange.total) {
          await cancelBody(upstream);
          throw new Error("upstream returned an invalid range while stitching media");
        }
        for (const name of ["etag", "last-modified"]) {
          if (validators[name] && upstream.headers.get(name) !== validators[name]) {
            await cancelBody(upstream);
            throw new Error(`upstream ${name} changed while stitching media`);
          }
        }
        const data = await readExactBlock(upstream, end - offset + 1);
        yield data;
        offset = end + 1;
      }
    } finally {
      if (!controller.signal.aborted) controller.abort();
      signal?.removeEventListener("abort", abortFromParent);
    }
  })(), { objectMode: false, highWaterMark: 1 });
  body.once("close", () => {
    if (!controller.signal.aborted) controller.abort();
    signal?.removeEventListener("abort", abortFromParent);
  });

  return { status: requested.ranged ? 206 : 200, headers, body };
}
