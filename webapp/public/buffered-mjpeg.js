// Browser-controlled buffered MJPEG playback.
// Loaded as a classic script so the existing no-build SPA can use window.BufferedMjpeg.
(() => {
  "use strict";

  const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);
  const CRLF = new Uint8Array([13, 10]);

  function asciiBytes(value) {
    return new TextEncoder().encode(value);
  }

  function concatBytes(a, b) {
    if (!a?.byteLength) return b.slice();
    if (!b?.byteLength) return a.slice();
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  }

  function indexOfBytes(haystack, needle, from = 0) {
    if (!needle.byteLength) return Math.max(0, from);
    const last = haystack.byteLength - needle.byteLength;
    outer:
    for (let i = Math.max(0, from); i <= last; i += 1) {
      for (let j = 0; j < needle.byteLength; j += 1) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function startsWithBytes(value, prefix) {
    if (value.byteLength < prefix.byteLength) return false;
    for (let i = 0; i < prefix.byteLength; i += 1) {
      if (value[i] !== prefix[i]) return false;
    }
    return true;
  }

  function trimLeadingCrlf(value) {
    let offset = 0;
    while (value.byteLength - offset >= 2 && value[offset] === 13 && value[offset + 1] === 10) offset += 2;
    return offset ? value.slice(offset) : value;
  }

  function isJpeg(bytes) {
    return bytes.byteLength >= 4
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[bytes.byteLength - 2] === 0xff
      && bytes[bytes.byteLength - 1] === 0xd9;
  }

  function abortError() {
    try { return new DOMException("Aborted", "AbortError"); } catch {
      const error = new Error("Aborted");
      error.name = "AbortError";
      return error;
    }
  }

  function boundaryFromContentType(contentType) {
    const match = String(contentType || "").match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const raw = (match?.[1] || match?.[2] || "").trim();
    return raw.replace(/^--/, "");
  }

  class MultipartMjpegParser {
    constructor(boundary, {
      maxFrameBytes = 3 * 1024 * 1024,
      maxHeaderBytes = 16 * 1024,
      maxParserBytes = null,
    } = {}) {
      const clean = String(boundary || "").replace(/^--/, "");
      if (!clean) throw new Error("MJPEG boundary is required");
      this.boundary = clean;
      this.boundaryBytes = asciiBytes(`--${clean}`);
      this.bodyBoundaryBytes = asciiBytes(`\r\n--${clean}`);
      this.maxFrameBytes = maxFrameBytes;
      this.maxHeaderBytes = maxHeaderBytes;
      this.maxParserBytes = maxParserBytes || maxFrameBytes + maxHeaderBytes + this.boundaryBytes.byteLength * 4 + 64 * 1024;
      this.buffer = new Uint8Array(0);
      this.phase = "boundary";
      this.expectedLength = null;
      this.ended = false;
      this.framesParsed = 0;
    }

    _append(chunk) {
      if (!chunk?.byteLength) return;
      const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this.buffer.byteLength + value.byteLength > this.maxParserBytes) {
        throw new Error(`MJPEG parser buffer exceeded ${this.maxParserBytes} bytes`);
      }
      this.buffer = concatBytes(this.buffer, value);
    }

    _consume(count) {
      this.buffer = count >= this.buffer.byteLength ? new Uint8Array(0) : this.buffer.slice(count);
    }

    _parseHeaders(bytes) {
      const text = new TextDecoder("latin1").decode(bytes);
      const headers = {};
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const index = line.indexOf(":");
        if (index <= 0) throw new Error("Malformed MJPEG part header");
        const key = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        headers[key] = value;
      }
      const contentType = String(headers["content-type"] || "").toLowerCase();
      if (contentType && !contentType.includes("image/jpeg")) {
        throw new Error(`Unexpected MJPEG part content type: ${headers["content-type"]}`);
      }
      const lengthRaw = headers["content-length"];
      if (lengthRaw == null) return null;
      const length = Number.parseInt(lengthRaw, 10);
      if (!Number.isFinite(length) || length <= 0) throw new Error("Invalid MJPEG Content-Length");
      if (length > this.maxFrameBytes) throw new Error(`MJPEG frame exceeds ${this.maxFrameBytes} bytes`);
      return length;
    }

    _finishFrame(frame, frames) {
      if (frame.byteLength > this.maxFrameBytes) throw new Error(`MJPEG frame exceeds ${this.maxFrameBytes} bytes`);
      if (!isJpeg(frame)) throw new Error("Malformed MJPEG frame");
      frames.push(frame);
      this.framesParsed += 1;
      this.expectedLength = null;
      this.phase = "boundary";
    }

    push(chunk) {
      if (this.ended) {
        if (!chunk?.byteLength) return [];
        const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const trailing = new TextDecoder("latin1").decode(value);
        if (/^\s*$/.test(trailing)) return [];
        throw new Error("MJPEG parser already ended");
      }

      const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk || 0);
      // WebKit may coalesce many multipart JPEG parts into one multi-megabyte
      // ReadableStream chunk. The parser memory limit protects one in-progress
      // part, not the arbitrary size of a transport chunk, so consume large
      // network chunks incrementally instead of appending them whole.
      const transportSliceBytes = 64 * 1024;
      if (value.byteLength > transportSliceBytes) {
        const frames = [];
        for (let offset = 0; offset < value.byteLength; offset += transportSliceBytes) {
          frames.push(...this.push(value.subarray(offset, Math.min(value.byteLength, offset + transportSliceBytes))));
        }
        return frames;
      }

      this._append(value);
      const frames = [];

      while (true) {
        if (this.phase === "boundary") {
          this.buffer = trimLeadingCrlf(this.buffer);
          const at = indexOfBytes(this.buffer, this.boundaryBytes);
          if (at < 0) {
            const keep = this.boundaryBytes.byteLength + 4;
            if (this.buffer.byteLength > keep) this.buffer = this.buffer.slice(this.buffer.byteLength - keep);
            break;
          }
          if (at > 0) this._consume(at);
          if (this.buffer.byteLength < this.boundaryBytes.byteLength + 2) break;
          this._consume(this.boundaryBytes.byteLength);
          if (this.buffer[0] === 45 && this.buffer[1] === 45) {
            this._consume(2);
            this.phase = "done";
            this.ended = true;
            break;
          }
          this.buffer = trimLeadingCrlf(this.buffer);
          this.phase = "headers";
        }

        if (this.phase === "headers") {
          const end = indexOfBytes(this.buffer, CRLFCRLF);
          if (end < 0) {
            if (this.buffer.byteLength > this.maxHeaderBytes) throw new Error("MJPEG part headers exceeded limit");
            break;
          }
          if (end > this.maxHeaderBytes) throw new Error("MJPEG part headers exceeded limit");
          this.expectedLength = this._parseHeaders(this.buffer.slice(0, end));
          this._consume(end + CRLFCRLF.byteLength);
          this.phase = this.expectedLength == null ? "body-boundary" : "body-length";
        }

        if (this.phase === "body-length") {
          if (this.buffer.byteLength < this.expectedLength) break;
          const frame = this.buffer.slice(0, this.expectedLength);
          this._consume(this.expectedLength);
          this._finishFrame(frame, frames);
          continue;
        }

        if (this.phase === "body-boundary") {
          const next = indexOfBytes(this.buffer, this.bodyBoundaryBytes);
          if (next < 0) {
            if (this.buffer.byteLength > this.maxFrameBytes + this.bodyBoundaryBytes.byteLength) {
              throw new Error(`MJPEG frame exceeds ${this.maxFrameBytes} bytes`);
            }
            break;
          }
          const frame = this.buffer.slice(0, next);
          this._consume(next + CRLF.byteLength);
          this._finishFrame(frame, frames);
          continue;
        }

        if (this.phase === "done") break;
      }

      return frames;
    }

    end() {
      if (this.ended) return [];
      const frames = this.push(new Uint8Array(0));
      const remaining = trimLeadingCrlf(this.buffer);
      if (this.phase === "body-length" && remaining.byteLength) {
        throw new Error(`Truncated MJPEG frame: expected ${this.expectedLength} bytes, received ${remaining.byteLength}`);
      }
      if (this.phase === "body-boundary" && remaining.byteLength) {
        throw new Error("Truncated MJPEG frame at end of stream");
      }
      if (this.phase === "headers" && remaining.byteLength) {
        throw new Error("Truncated MJPEG part headers at end of stream");
      }
      this.ended = true;
      this.phase = "done";
      this.buffer = new Uint8Array(0);
      return frames;
    }
  }

  class BufferedFrameQueue {
    constructor({ fps, maxDurationSeconds = 8, maxBytes = 24 * 1024 * 1024 } = {}) {
      this.fps = Math.max(1, Number(fps) || 24);
      this.maxDurationSeconds = Math.max(0.25, Number(maxDurationSeconds) || 8);
      this.maxBytes = Math.max(1024, Number(maxBytes) || 24 * 1024 * 1024);
      this.frames = [];
      this.bytes = 0;
      this.waiters = new Set();
      this.onRelease = null;
    }

    get length() { return this.frames.length; }
    durationSeconds() { return this.frames.length / this.fps; }
    peek() { return this.frames[0] || null; }
    at(index) { return this.frames[index] || null; }

    canAccept(size = 0) {
      if (size > this.maxBytes) return false;
      const nextDuration = (this.frames.length + 1) / this.fps;
      return this.bytes + size <= this.maxBytes && nextDuration <= this.maxDurationSeconds;
    }

    canReadMore() {
      return this.bytes < this.maxBytes * 0.92 && this.durationSeconds() < this.maxDurationSeconds;
    }

    push(frame) {
      if (!this.canAccept(frame.size || 0)) throw new Error("Buffered MJPEG queue limit reached");
      this.frames.push(frame);
      this.bytes += frame.size || 0;
    }

    shift() {
      const frame = this.frames.shift() || null;
      if (frame) this.bytes = Math.max(0, this.bytes - (frame.size || 0));
      this._notify();
      return frame;
    }

    clear() {
      const frames = this.frames.splice(0);
      this.bytes = 0;
      for (const frame of frames) this.onRelease?.(frame);
      this._notify();
    }

    _notify() {
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate()) {
          this.waiters.delete(waiter);
          waiter.cleanup();
          waiter.resolve();
        }
      }
    }

    _wait(predicate, signal) {
      if (predicate()) return Promise.resolve();
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          this.waiters.delete(waiter);
          cleanup();
          reject(abortError());
        };
        const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
        const waiter = { predicate, resolve, reject, cleanup };
        this.waiters.add(waiter);
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    }

    waitForRoom(size, signal) {
      if (size > this.maxBytes) return Promise.reject(new Error("MJPEG frame exceeds queue byte cap"));
      return this._wait(() => this.canAccept(size), signal);
    }

    waitUntilReadable(signal) {
      return this._wait(() => this.canReadMore(), signal);
    }
  }

  class BufferPolicy {
    constructor({ startupSeconds = 4, rebufferSeconds = 2, maxSeconds = 8 } = {}) {
      this.startupSeconds = startupSeconds;
      this.rebufferSeconds = rebufferSeconds;
      this.maxSeconds = maxSeconds;
    }

    startupReady(queueSeconds, eof, frameCount, audioReady, needsAudio) {
      if (needsAudio && !audioReady) return false;
      return queueSeconds >= this.startupSeconds || (eof && frameCount > 0);
    }

    resumeReady(queueSeconds, eof, frameCount, audioReady, needsAudio) {
      if (needsAudio && !audioReady) return false;
      return queueSeconds >= this.rebufferSeconds || (eof && frameCount > 0);
    }

    shouldRebuffer(frameCount, eof) {
      return frameCount === 0 && !eof;
    }
  }

  class AdaptiveRecoveryBuffer {
    constructor({
      baseSeconds = 2,
      maxSeconds = 4,
      stepSeconds = 1,
      stableSeconds = 30,
      now = () => performance.now(),
    } = {}) {
      this.baseSeconds = Math.max(0.25, Number(baseSeconds) || 2);
      this.maxSeconds = Math.max(this.baseSeconds, Number(maxSeconds) || 4);
      this.stepSeconds = Math.max(0.25, Number(stepSeconds) || 1);
      this.stableMs = Math.max(1000, (Number(stableSeconds) || 30) * 1000);
      this.now = now;
      this.targetSeconds = this.baseSeconds;
      this.hadRecentRebuffer = false;
      this.stableSince = null;
    }

    update() {
      if (!this.hadRecentRebuffer || this.stableSince == null) return this.targetSeconds;
      let elapsed = this.now() - this.stableSince;
      while (elapsed >= this.stableMs) {
        if (this.targetSeconds > this.baseSeconds) {
          this.targetSeconds = Math.max(this.baseSeconds, this.targetSeconds - this.stepSeconds);
          this.stableSince += this.stableMs;
          elapsed -= this.stableMs;
        } else {
          this.hadRecentRebuffer = false;
          this.stableSince = null;
          break;
        }
      }
      return this.targetSeconds;
    }

    onRebuffer() {
      this.update();
      if (this.hadRecentRebuffer) {
        this.targetSeconds = Math.min(this.maxSeconds, this.targetSeconds + this.stepSeconds);
      } else {
        this.targetSeconds = this.baseSeconds;
      }
      this.hadRecentRebuffer = true;
      this.stableSince = null;
      return this.targetSeconds;
    }

    onPlaybackStable() {
      if (this.hadRecentRebuffer && this.stableSince == null) this.stableSince = this.now();
      return this.targetSeconds;
    }

    onPlaybackInterrupted() {
      if (this.hadRecentRebuffer) this.stableSince = null;
      return this.targetSeconds;
    }
  }

  class SessionGuard {
    constructor(id, isCurrent = () => true) {
      this.id = id;
      this.isCurrent = isCurrent;
      this.cancelled = false;
    }
    active() { return !this.cancelled && Boolean(this.isCurrent(this.id)); }
    cancel() { this.cancelled = true; }
  }

  function supportsBufferedMjpeg(canvas) {
    return Boolean(
      globalThis.fetch
      && globalThis.ReadableStream
      && globalThis.AbortController
      && globalThis.Blob
      && canvas?.getContext?.("2d")
    );
  }

  async function decodeJpeg(blob) {
    if (typeof globalThis.createImageBitmap === "function") {
      const bitmap = await globalThis.createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => { try { bitmap.close?.(); } catch {} },
      };
    }
    if (!globalThis.Image || !globalThis.URL?.createObjectURL) throw new Error("Browser cannot decode buffered JPEG frames");
    const url = globalThis.URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const value = new Image();
        value.onload = () => resolve(value);
        value.onerror = () => reject(new Error("JPEG decode failed"));
        value.src = url;
      });
      return {
        source: image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        release: () => { try { globalThis.URL.revokeObjectURL(url); } catch {} },
      };
    } catch (error) {
      try { globalThis.URL.revokeObjectURL(url); } catch {}
      throw error;
    }
  }

  class BufferedMjpegPlayer {
    constructor({
      url,
      canvas,
      audio = null,
      fps = 12,
      sessionId = 0,
      isCurrent = () => true,
      audioEnabled = () => Boolean(audio),
      audioClockOffset = 0,
      fetchImpl = (...args) => fetch(...args),
      startupSeconds = 4,
      rebufferSeconds = 2,
      maxRecoverySeconds = 4,
      recoveryStepSeconds = 1,
      recoveryStableSeconds = 30,
      maxQueueSeconds = 8,
      maxQueueBytes = 24 * 1024 * 1024,
      maxFrameBytes = 3 * 1024 * 1024,
      onState = () => {},
      onStats = () => {},
      onError = () => {},
      onEnded = () => {},
    }) {
      this.url = url;
      this.canvas = canvas;
      this.ctx = canvas?.getContext?.("2d") || null;
      this.audio = audio;
      this.audioClockOffset = Math.max(0, Number(audioClockOffset) || 0);
      this.fps = Math.max(1, Number(fps) || 24);
      this.guard = new SessionGuard(sessionId, isCurrent);
      this.audioEnabled = audioEnabled;
      this.fetchImpl = fetchImpl;
      this.policy = new BufferPolicy({ startupSeconds, rebufferSeconds, maxSeconds: maxQueueSeconds });
      this.recovery = new AdaptiveRecoveryBuffer({
        baseSeconds: rebufferSeconds,
        maxSeconds: Math.min(maxQueueSeconds, maxRecoverySeconds),
        stepSeconds: recoveryStepSeconds,
        stableSeconds: recoveryStableSeconds,
      });
      this.queue = new BufferedFrameQueue({ fps: this.fps, maxDurationSeconds: maxQueueSeconds, maxBytes: maxQueueBytes });
      this.queue.onRelease = (frame) => this._releaseFrame(frame);
      this.maxFrameBytes = maxFrameBytes;
      this.controller = new AbortController();
      this.reader = null;
      this.parser = null;
      this.frameIndex = 0;
      this.eof = false;
      this.audioReady = !audio;
      this.audioEnded = false;
      this.playbackStarted = false;
      this.playing = false;
      this.buffering = true;
      this.userPaused = false;
      this.hidden = false;
      this.autoplayBlocked = false;
      this.destroyed = false;
      this.renderPending = false;
      this.rafId = null;
      this.monotonicAnchor = null;
      this.lastRenderedTime = 0;
      this.onState = onState;
      this.onStats = onStats;
      this.onError = onError;
      this.onEnded = onEnded;
      this.stats = {
        state: "idle",
        fps: this.fps,
        receivedFrames: 0,
        renderedFrames: 0,
        queueSeconds: 0,
        queueBytes: 0,
        maxQueueSeconds: 0,
        maxQueueBytes: 0,
        startupMs: null,
        rebufferCount: 0,
        recoveryTargetSeconds: this.recovery.targetSeconds,
        lastAvDriftMs: null,
        eof: false,
      };
      this.startedAt = performance.now();
      this._boundAudioWaiting = () => this._handleAudioWaiting();
      this._boundAudioPlaying = () => this._handleAudioPlaying();
      this._boundAudioEnded = () => this._handleAudioEnded();
      audio?.addEventListener?.("waiting", this._boundAudioWaiting);
      audio?.addEventListener?.("stalled", this._boundAudioWaiting);
      audio?.addEventListener?.("playing", this._boundAudioPlaying);
      audio?.addEventListener?.("ended", this._boundAudioEnded);
    }

    _active() { return !this.destroyed && this.guard.active(); }

    _needsAudio() {
      return Boolean(this.audio && !this.audioEnded && this.audioEnabled());
    }

    _setState(state, detail = {}) {
      if (!this._active()) return;
      this.stats.state = state;
      this.onState(state, { ...detail, stats: this.getStats() });
      this._emitStats();
    }

    _emitStats() {
      if (!this._active()) return;
      this.stats.recoveryTargetSeconds = this.recovery.update();
      this.stats.queueSeconds = this.queue.durationSeconds();
      this.stats.queueBytes = this.queue.bytes;
      this.stats.maxQueueSeconds = Math.max(this.stats.maxQueueSeconds, this.stats.queueSeconds);
      this.stats.maxQueueBytes = Math.max(this.stats.maxQueueBytes, this.stats.queueBytes);
      this.stats.eof = this.eof;
      this.onStats(this.getStats());
    }

    getStats() {
      return { ...this.stats };
    }

    currentTime() {
      if (this._needsAudio() && this.audio) return Math.max(0, (Number(this.audio.currentTime) || 0) - this.audioClockOffset);
      if (this.monotonicAnchor) {
        const elapsed = this.playing ? (performance.now() - this.monotonicAnchor.perf) / 1000 : 0;
        return Math.max(0, this.monotonicAnchor.media + elapsed);
      }
      return Math.max(0, this.lastRenderedTime || 0);
    }

    setAudioReady(ready = true) {
      this.audioReady = Boolean(ready);
      this._maybeStartOrResume();
    }

    async start() {
      if (!supportsBufferedMjpeg(this.canvas)) throw new Error("Buffered MJPEG is not supported by this browser");
      this._setState("buffering", { reason: "startup" });
      try {
        const response = await this.fetchImpl(this.url, { cache: "no-store", signal: this.controller.signal });
        if (!this._active()) return;
        if (!response.ok || !response.body) throw new Error(`MJPEG request failed: HTTP ${response.status}`);
        const boundary = boundaryFromContentType(response.headers.get("content-type"))
          || String(response.headers.get("x-mjpeg-boundary") || "").replace(/^--/, "").trim();
        if (!boundary) throw new Error("MJPEG response did not include a multipart boundary");
        const serverFps = Number.parseFloat(response.headers.get("x-mjpeg-fps") || "");
        if (Number.isFinite(serverFps) && serverFps > 0 && Math.abs(serverFps - this.fps) > 0.01) {
          this.fps = serverFps;
          this.queue.fps = serverFps;
          this.stats.fps = serverFps;
        }
        this.parser = new MultipartMjpegParser(boundary, { maxFrameBytes: this.maxFrameBytes });
        this.reader = response.body.getReader();
        await this._pump();
      } catch (error) {
        if (error?.name === "AbortError" || !this._active()) return;
        this._fail(error);
      }
    }

    async _pump() {
      // Keep one read pending before doing parser/decode/queue work. WebKit's
      // streaming-fetch regression can otherwise withhold response bytes while
      // JavaScript is busy processing the previous chunk.
      let pendingRead = this.reader.read();
      while (this._active() && !this.eof) {
        if (!this.queue.canReadMore()) await this.queue.waitUntilReadable(this.controller.signal);
        if (!this._active()) return;
        const { value, done } = await pendingRead;
        if (done) {
          const finalFrames = this.parser.end();
          for (const bytes of finalFrames) await this._enqueue(bytes);
          this.eof = true;
          this._emitStats();
          this._maybeStartOrResume();
          if (!this.queue.length && !this._needsAudio()) this._finish();
          break;
        }
        // Start the next network read immediately, before parsing/enqueue work.
        pendingRead = this.reader.read();
        const frames = this.parser.push(value);
        for (const bytes of frames) await this._enqueue(bytes);
      }
    }

    async _enqueue(bytes) {
      await this.queue.waitForRoom(bytes.byteLength, this.controller.signal);
      if (!this._active()) return;
      const index = this.frameIndex++;
      const frame = {
        index,
        time: index / this.fps,
        bytes,
        size: bytes.byteLength,
        blob: new Blob([bytes], { type: "image/jpeg" }),
        decoded: null,
        decodePromise: null,
        released: false,
      };
      this.queue.push(frame);
      this.stats.receivedFrames += 1;
      this._emitStats();
      this._predecode();
      this._maybeStartOrResume();
    }

    _bufferReady(startup) {
      const needsAudio = this._needsAudio();
      return startup
        ? this.policy.startupReady(this.queue.durationSeconds(), this.eof, this.queue.length, this.audioReady, needsAudio)
        : (needsAudio && !this.audioReady
          ? false
          : this.queue.durationSeconds() >= this.recovery.update() || (this.eof && this.queue.length > 0));
    }

    _maybeStartOrResume() {
      if (!this._active() || this.userPaused || this.hidden || this.autoplayBlocked) return;
      const startup = !this.playbackStarted;
      if (!this._bufferReady(startup)) {
        const target = startup ? this.policy.startupSeconds : this.recovery.update();
        this._setState("buffering", {
          reason: startup ? "startup" : "rebuffer",
          bufferedSeconds: this.queue.durationSeconds(),
          targetSeconds: target,
        });
        return;
      }
      void this._beginPlayback(false);
    }

    async _beginPlayback(fromGesture) {
      if (!this._active() || this.userPaused || this.hidden) return;
      if (this.playing) return;
      if (this._needsAudio()) {
        try {
          this.audio.muted = false;
          const play = this.audio.play();
          if (play?.then) await play;
        } catch (error) {
          if (!this._active()) return;
          if (error?.name === "NotAllowedError" || /autoplay|gesture|interaction/i.test(String(error?.message || ""))) {
            this.autoplayBlocked = true;
            this._setState("autoplay-blocked", { error });
            return;
          }
          this._fail(error);
          return;
        }
      } else {
        const media = this.lastRenderedTime || 0;
        this.monotonicAnchor = { media, perf: performance.now() };
      }
      if (!this._active()) return;
      const resumedAfterRecovery = this.playbackStarted && this.buffering && this.recovery.hadRecentRebuffer;
      this.autoplayBlocked = false;
      this.buffering = false;
      this.playing = true;
      if (!this.playbackStarted) {
        this.playbackStarted = true;
        this.stats.startupMs = Math.round(performance.now() - this.startedAt);
      }
      if (resumedAfterRecovery) this.recovery.onPlaybackStable();
      this._setState("playing", { fromGesture, recoveryTargetSeconds: this.recovery.update() });
      this._predecode();
      this._scheduleRender();
    }

    _scheduleRender() {
      if (!this._active() || !this.playing || this.userPaused || this.hidden || this.rafId != null) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        void this._renderTick();
      });
    }

    async _renderTick() {
      if (!this._active() || !this.playing || this.userPaused || this.hidden) return;
      if (this.renderPending) {
        this._scheduleRender();
        return;
      }

      const frame = this.queue.peek();
      if (!frame) {
        if (this.eof) {
          if (!this._needsAudio()) this._finish();
          return;
        }
        this._enterRebuffer("video");
        return;
      }

      const clock = this.currentTime();
      const tolerance = Math.min(0.02, 0.5 / this.fps);
      if (frame.time > clock + tolerance) {
        this._scheduleRender();
        return;
      }

      this.renderPending = true;
      try {
        const decoded = await this._ensureDecoded(frame);
        if (!this._active() || this.queue.peek() !== frame) return;
        if (decoded.width && decoded.height && (this.canvas.width !== decoded.width || this.canvas.height !== decoded.height)) {
          this.canvas.width = decoded.width;
          this.canvas.height = decoded.height;
        }
        this.ctx.drawImage(decoded.source, 0, 0, this.canvas.width, this.canvas.height);
        this.lastRenderedTime = frame.time;
        this.stats.renderedFrames += 1;
        if (this._needsAudio()) this.stats.lastAvDriftMs = Math.round((((Number(this.audio.currentTime) || 0) - this.audioClockOffset) - frame.time) * 1000);
        this.queue.shift();
        this._releaseFrame(frame);
        this._emitStats();
        this._predecode();

        const next = this.queue.peek();
        const audioClock = Math.max(0, (Number(this.audio?.currentTime) || 0) - this.audioClockOffset);
        if (this._needsAudio() && next && !this.audio.paused && next.time < audioClock - 0.25) {
          try { this.audio.pause(); } catch {}
          this.playing = true;
          this._setState("syncing", { driftSeconds: audioClock - next.time });
        } else if (this._needsAudio() && next && this.audio.paused && this.stats.state === "syncing" && next.time >= audioClock - 0.04) {
          try {
            const play = this.audio.play();
            if (play?.catch) play.catch(() => {});
          } catch {}
          this._setState("playing");
        }
      } catch (error) {
        this._fail(error);
        return;
      } finally {
        this.renderPending = false;
      }

      if (this.queue.length === 0 && !this.eof) {
        this._enterRebuffer("video");
        return;
      }
      if (this.queue.length === 0 && this.eof && !this._needsAudio()) {
        this._finish();
        return;
      }
      this._scheduleRender();
    }

    _predecode() {
      for (let i = 0; i < Math.min(2, this.queue.length); i += 1) {
        const frame = this.queue.at(i);
        if (frame && !frame.decodePromise) {
          this._ensureDecoded(frame).catch((error) => {
            if (this._active()) this._fail(error);
          });
        }
      }
    }

    _ensureDecoded(frame) {
      if (frame.decoded) return Promise.resolve(frame.decoded);
      if (frame.decodePromise) return frame.decodePromise;
      frame.decodePromise = decodeJpeg(frame.blob).then((decoded) => {
        if (frame.released || !this._active()) {
          decoded.release?.();
          return decoded;
        }
        frame.decoded = decoded;
        return decoded;
      });
      return frame.decodePromise;
    }

    _releaseFrame(frame) {
      if (!frame || frame.released) return;
      frame.released = true;
      if (frame.decoded) {
        try { frame.decoded.release?.(); } catch {}
        frame.decoded = null;
      } else if (frame.decodePromise) {
        frame.decodePromise.then((decoded) => {
          try { decoded?.release?.(); } catch {}
        }).catch(() => {});
      }
      frame.bytes = null;
      frame.blob = null;
    }

    _enterRebuffer(reason) {
      if (!this._active() || this.buffering) return;
      this.buffering = true;
      this.playing = false;
      const recoveryTargetSeconds = this.recovery.onRebuffer();
      this.stats.rebufferCount += 1;
      this.stats.recoveryTargetSeconds = recoveryTargetSeconds;
      if (this._needsAudio()) {
        try { this.audio.pause(); } catch {}
      } else {
        const current = this.currentTime();
        this.monotonicAnchor = { media: current, perf: performance.now() };
      }
      this._cancelRaf();
      this._setState("buffering", {
        reason,
        bufferedSeconds: this.queue.durationSeconds(),
        targetSeconds: recoveryTargetSeconds,
      });
      this._maybeStartOrResume();
    }

    _handleAudioWaiting() {
      if (!this._active() || !this.playbackStarted || this.userPaused || this.hidden || !this._needsAudio()) return;
      this.playing = false;
      this.buffering = true;
      this.recovery.onPlaybackInterrupted();
      this._cancelRaf();
      this._setState("buffering", {
        reason: "audio",
        bufferedSeconds: this.queue.durationSeconds(),
        targetSeconds: this.recovery.update(),
      });
    }

    _handleAudioPlaying() {
      if (!this._active() || this.userPaused || this.hidden || !this._needsAudio()) return;
      if (this._bufferReady(false)) {
        this.buffering = false;
        this.playing = true;
        this.recovery.onPlaybackStable();
        this._setState("playing", { recoveryTargetSeconds: this.recovery.update() });
        this._scheduleRender();
      }
    }

    _handleAudioEnded() {
      if (!this._active()) return;
      const audioTime = Math.max(0, (Number(this.audio?.currentTime) || 0) - this.audioClockOffset || this.lastRenderedTime || 0);
      this.audioEnded = true;
      this.monotonicAnchor = { media: audioTime, perf: performance.now() };
      if (this.eof && this.queue.length === 0) {
        this._finish();
        return;
      }
      this.playing = true;
      this.buffering = false;
      this._setState("playing", { audioEnded: true });
      this._scheduleRender();
    }

    retryFromGesture() {
      if (!this._active()) return false;
      if (!this.autoplayBlocked && !this.userPaused) return false;
      this.autoplayBlocked = false;
      if (this.userPaused) this.userPaused = false;
      void this._beginPlayback(true);
      return true;
    }

    pauseUser() {
      if (!this._active() || this.userPaused) return;
      const current = this.currentTime();
      this.userPaused = true;
      this.playing = false;
      this.buffering = false;
      this.recovery.onPlaybackInterrupted();
      if (this._needsAudio()) {
        try { this.audio.pause(); } catch {}
      }
      this.monotonicAnchor = { media: current, perf: performance.now() };
      this._cancelRaf();
      this._setState("paused");
    }

    resumeUser() {
      if (!this._active() || !this.userPaused) return;
      this.userPaused = false;
      if (this._bufferReady(false)) void this._beginPlayback(true);
      else {
        this.buffering = true;
        this._setState("buffering", {
          reason: "resume",
          bufferedSeconds: this.queue.durationSeconds(),
          targetSeconds: this.recovery.update(),
        });
      }
    }

    setVisible(visible) {
      if (!this._active()) return;
      const nextHidden = !visible;
      if (nextHidden === this.hidden) return;
      this.hidden = nextHidden;
      if (this.hidden) {
        const current = this.currentTime();
        this.playing = false;
        this.recovery.onPlaybackInterrupted();
        if (this._needsAudio()) {
          try { this.audio.pause(); } catch {}
        }
        this.monotonicAnchor = { media: current, perf: performance.now() };
        this._cancelRaf();
        this._setState("background");
      } else if (!this.userPaused) {
        this.buffering = true;
        this._setState("buffering", {
          reason: "foreground",
          bufferedSeconds: this.queue.durationSeconds(),
          targetSeconds: this.recovery.update(),
        });
        this._maybeStartOrResume();
      }
    }

    setAudioDisabled(disabled, mediaTime = null) {
      if (!this._active()) return;
      const current = Number.isFinite(mediaTime) ? Math.max(0, mediaTime) : this.currentTime();
      if (disabled) {
        try { this.audio?.pause(); } catch {}
        this.monotonicAnchor = { media: current, perf: performance.now() };
        if (!this.userPaused && !this.hidden) {
          this.playing = true;
          this.buffering = false;
          this.recovery.onPlaybackStable();
          this._setState("playing", { audioDisabled: true, recoveryTargetSeconds: this.recovery.update() });
          this._scheduleRender();
        }
      }
    }

    _finish() {
      if (!this._active()) return;
      this.playing = false;
      this.buffering = false;
      this._cancelRaf();
      this._setState("ended");
      this.onEnded();
    }

    _fail(error) {
      if (!this._active()) return;
      this.playing = false;
      this.buffering = false;
      this._cancelRaf();
      this._setState("error", { error });
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }

    _cancelRaf() {
      if (this.rafId != null) {
        try { cancelAnimationFrame(this.rafId); } catch {}
        this.rafId = null;
      }
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.guard.cancel();
      this._cancelRaf();
      try { this.controller.abort(); } catch {}
      try { this.reader?.cancel?.(); } catch {}
      this.audio?.removeEventListener?.("waiting", this._boundAudioWaiting);
      this.audio?.removeEventListener?.("stalled", this._boundAudioWaiting);
      this.audio?.removeEventListener?.("playing", this._boundAudioPlaying);
      this.audio?.removeEventListener?.("ended", this._boundAudioEnded);
      this.queue.clear();
      this.reader = null;
      this.parser = null;
    }
  }

  globalThis.BufferedMjpeg = {
    MultipartMjpegParser,
    BufferedFrameQueue,
    BufferPolicy,
    SessionGuard,
    AdaptiveRecoveryBuffer,
    BufferedMjpegPlayer,
    boundaryFromContentType,
    supportsBufferedMjpeg,
  };
})();
