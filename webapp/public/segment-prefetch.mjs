// Experimental dynamic-DASH compressed segment look-ahead.
// Limit both bytes and segment count; never retain decoded VideoFrames here.
// This module has no side effects and is used only with the Buffer Lab opt-in.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BoundedSegmentBuffer {
  constructor({ maxBytes = 24 * 1024 * 1024, maxSegments = 36, pollMs = 40 } = {}) {
    this.maxBytes = Math.max(1024, Math.floor(maxBytes));
    this.maxSegments = Math.max(1, Math.floor(maxSegments));
    this.pollMs = Math.max(5, Math.floor(pollMs));
    this.queue = [];
    this.bytes = 0;
    this.peakBytes = 0;
    this.peakSegments = 0;
    this.closed = false;
    this.error = null;
  }

  get size() { return this.queue.length; }
  get hasCapacity() { return !this.closed && this.size < this.maxSegments && this.bytes < this.maxBytes; }

  async push(segment, { shouldStop = () => false } = {}) {
    const size = Number(segment?.data?.byteLength);
    if (!Number.isFinite(size) || size < 0 || size > this.maxBytes) {
      throw new Error("Compressed DASH segment exceeds buffer byte limit");
    }
    while (!this.closed && !shouldStop() &&
        (this.size >= this.maxSegments || this.bytes + size > this.maxBytes)) {
      await wait(this.pollMs);
    }
    if (this.closed || shouldStop()) return false;
    this.queue.push(segment);
    this.bytes += size;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
    this.peakSegments = Math.max(this.peakSegments, this.size);
    return true;
  }

  async shift({ shouldStop = () => false } = {}) {
    while (!shouldStop()) {
      const segment = this.queue.shift();
      if (segment) {
        this.bytes -= segment.data.byteLength;
        return segment;
      }
      if (this.error) throw this.error;
      if (this.closed) return null;
      await wait(this.pollMs);
    }
    return null;
  }

  close() { this.closed = true; }
  fail(error) {
    this.error = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
  }
}
