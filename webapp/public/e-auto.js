/* Standalone browser E-Auto primitives. No DOM or stream dependencies. */
(() => {
  "use strict";

  const HEADER_BYTES = 48;
  const MAGIC = "EAJF";
  const MAGIC_BYTES = new Uint8Array([0x45, 0x41, 0x4a, 0x46]);
  // All integer fields are unsigned, network-endian. The final six bytes are reserved.
  const HEADER = Object.freeze({
    magic: 0, version: 4, headerLength: 5, sessionId: 6, sequence: 10,
    videoTimestampUs: 14, serverTimestampMs: 22, jpegLength: 30, fpsX100: 34,
    jpegQuality: 36, profile: 37, width: 38, height: 40, bytes: HEADER_BYTES,
  });

  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const asBytes = (value) => value instanceof Uint8Array
    ? value : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);

  function readU64(view, offset) {
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    const value = high * 0x100000000 + low;
    return Number.isSafeInteger(value) ? value : BigInt(`0x${high.toString(16)}${low.toString(16).padStart(8, "0")}`);
  }

  function readHeader(bytes) {
    if (bytes.byteLength < HEADER_BYTES) return null;
    for (let i = 0; i < MAGIC_BYTES.length; i++) if (bytes[i] !== MAGIC_BYTES[i]) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint8(HEADER.headerLength);
    if (view.getUint8(HEADER.version) !== 1) throw new RangeError("unsupported EAJF version");
    if (headerLength !== HEADER_BYTES) throw new RangeError("invalid EAJF header length");
    return {
      magic: MAGIC,
      version: view.getUint8(HEADER.version),
      headerLength,
      sessionId: view.getUint32(HEADER.sessionId),
      sequence: view.getUint32(HEADER.sequence),
      videoTimestampUs: readU64(view, HEADER.videoTimestampUs),
      serverTimestampMs: readU64(view, HEADER.serverTimestampMs),
      jpegLength: view.getUint32(HEADER.jpegLength),
      fps: view.getUint16(HEADER.fpsX100) / 100,
      fpsX100: view.getUint16(HEADER.fpsX100),
      jpegQuality: view.getUint8(HEADER.jpegQuality),
      profile: view.getUint8(HEADER.profile),
      width: view.getUint16(HEADER.width),
      height: view.getUint16(HEADER.height),
    };
  }

  class EajfParser {
    constructor({ maxFrameBytes = 8 * 1024 * 1024, maxBufferedBytes = 16 * 1024 * 1024, onFrame = null } = {}) {
      this.maxFrameBytes = clamp(finite(maxFrameBytes, 8 * 1024 * 1024), 1024, 64 * 1024 * 1024);
      this.maxBufferedBytes = Math.max(HEADER_BYTES, finite(maxBufferedBytes, 16 * 1024 * 1024));
      this.onFrame = typeof onFrame === "function" ? onFrame : null;
      this.buffer = new Uint8Array(0);
      this.frames = 0;
      this.errors = 0;
    }

    push(input) {
      const bytes = asBytes(input);
      if (!bytes.byteLength) return [];
      if (this.buffer.byteLength + bytes.byteLength > this.maxBufferedBytes) {
        const keep = Math.min(this.maxBufferedBytes, HEADER_BYTES - 1);
        this.buffer = this.buffer.slice(-keep);
        this.errors++;
      }
      const joined = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
      joined.set(this.buffer); joined.set(bytes, this.buffer.byteLength); this.buffer = joined;
      return this._drain();
    }

    end() {
      const frames = this._drain();
      if (this.buffer.byteLength) throw new Error("truncated EAJF frame");
      return frames;
    }

    _drain() {
      const result = [];
      while (this.buffer.byteLength >= HEADER_BYTES) {
        let start = 0;
        while (start <= this.buffer.byteLength - MAGIC_BYTES.length &&
          (this.buffer[start] !== 0x45 || this.buffer[start + 1] !== 0x41 ||
           this.buffer[start + 2] !== 0x4a || this.buffer[start + 3] !== 0x46)) start++;
        if (start) this.buffer = this.buffer.slice(start);
        if (this.buffer.byteLength < HEADER_BYTES) break;
        let header;
        try { header = readHeader(this.buffer); } catch { this.errors++; this.buffer = this.buffer.slice(4); continue; }
        if (!header) break;
        if (header.headerLength > this.maxBufferedBytes || header.jpegLength > this.maxFrameBytes) {
          this.errors++; this.buffer = this.buffer.slice(4); continue;
        }
        const total = header.headerLength + header.jpegLength;
        if (total > this.maxBufferedBytes) { this.errors++; this.buffer = this.buffer.slice(4); continue; }
        if (this.buffer.byteLength < total) break;
        const jpeg = this.buffer.slice(header.headerLength, total);
        if (jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.byteLength - 2] !== 0xff || jpeg[jpeg.byteLength - 1] !== 0xd9) {
          this.errors++; this.buffer = this.buffer.slice(4); continue;
        }
        const frame = { ...header, jpeg };
        this.buffer = this.buffer.slice(total); this.frames++;
        result.push(frame); this.onFrame?.(frame);
      }
      return result;
    }
  }

  class Ewma {
    constructor(halfLife = 3) { this.halfLife = Math.max(1, finite(halfLife, 3)); this.estimate = null; this.weight = 0; }
    sample(value, durationMs = 50) {
      if (!Number.isFinite(value) || value < 0) return this.estimate;
      const duration = Math.max(50, finite(durationMs, 50));
      const alpha = 1 - Math.exp(-duration / (this.halfLife * 1000));
      this.estimate = this.estimate == null ? value : alpha * value + (1 - alpha) * this.estimate;
      this.weight += alpha;
      return this.estimate;
    }
    reset() { this.estimate = null; this.weight = 0; }
  }

  class DualEwmaEstimator {
    constructor({ fastHalfLife = 3, slowHalfLife = 9, minSampleMs = 50 } = {}) {
      this.fast = new Ewma(fastHalfLife); this.slow = new Ewma(slowHalfLife);
      this.minSampleMs = Math.max(50, finite(minSampleMs, 50));
    }
    sample(value, durationMs = this.minSampleMs) {
      const duration = Math.max(this.minSampleMs, finite(durationMs, this.minSampleMs));
      this.fast.sample(value, duration); this.slow.sample(value, duration); return this.estimate;
    }
    get estimate() {
      if (this.fast.estimate == null) return this.slow.estimate;
      if (this.slow.estimate == null) return this.fast.estimate;
      return Math.min(this.fast.estimate, this.slow.estimate);
    }
    reset() { this.fast.reset(); this.slow.reset(); }
  }

  const PROFILES = Object.freeze(["economy", "low", "balanced", "smooth", "high"]);
  const DEFAULT_TARGETS = Object.freeze({ economy: 4.5, low: 3.75, balanced: 3.0, smooth: 2.5, high: 2.0 });
  const log = (logger = console, prefix = "ABR", ...args) => {
    if (logger && typeof logger.debug === "function") logger.debug(`[EAUTO:${prefix}]`, ...args);
  };

  class MjpegAbrController {
    constructor({ now = () => Date.now(), profile = "balanced", switchCooldownMs = 3000, upgradeStableMs = 15000, logger = null } = {}) {
      this.now = now; this.profile = PROFILES.includes(profile) ? profile : "balanced";
      this.switchCooldownMs = Math.max(0, finite(switchCooldownMs, 4000)); this.upgradeStableMs = Math.max(1000, finite(upgradeStableMs, 12000));
      this.logger = logger; this.lastSwitchAt = Number.NEGATIVE_INFINITY; this.healthySince = null; this.last = null;
      this.bufferTarget = DEFAULT_TARGETS[this.profile];
    }
    observe(signal = {}) {
      const now = this.now();
      const s = { buffer: clamp(finite(signal.buffer, 0), 0, 60), drain: !!signal.drain, stall: !!signal.stall,
        decode: clamp(finite(signal.decode, 0), 0, 1), drop: clamp(finite(signal.drop, 0), 0, 1), render: clamp(finite(signal.render, 1), 0, 1),
        bandwidth: finite(signal.bandwidth, NaN), requiredBandwidth: finite(signal.requiredBandwidth, NaN) };
      this.last = s;
      const pressure = s.stall || s.drain || s.decode > .12 || s.drop > .08 || s.render < .86 ||
        (Number.isFinite(s.bandwidth) && Number.isFinite(s.requiredBandwidth) && s.bandwidth < s.requiredBandwidth * .92);
      if (pressure) this.bufferTarget = Math.min(5.5, this.bufferTarget + (s.stall ? 1 : 0.5));
      if (pressure && this.profile !== PROFILES[0] && now - this.lastSwitchAt >= this.switchCooldownMs) {
        return this._switch(-1, s.stall ? "stall" : s.drain ? "drain" : "pressure", now);
      }
      const healthy = !pressure && s.buffer >= this.targetBuffer * .9 && s.render >= .97 && s.drop < .02 && s.decode < .06;
      if (!healthy || this.profile === "high") { this.healthySince = null; return null; }
      if (this.healthySince == null) this.healthySince = now;
      if (now - this.healthySince >= this.upgradeStableMs && now - this.lastSwitchAt >= this.switchCooldownMs) {
        this.bufferTarget = Math.max(1.5, this.bufferTarget - 0.5);
        return this._switch(1, "stable-headroom", now);
      }
      return null;
    }
    signal(name, value = true) { return this.observe({ [name]: value }); }
    get targetBuffer() { return clamp(this.bufferTarget, 1.5, 5.5); }
    _switch(direction, reason, now) {
      const index = PROFILES.indexOf(this.profile); const next = PROFILES[clamp(index + direction, 0, PROFILES.length - 1)];
      if (next === this.profile) return null;
      const from = this.profile; this.profile = next; this.lastSwitchAt = now; this.healthySince = null;
      log(this.logger, "ABR", "profile", from, "->", next, reason); return { action: "switch", from, to: next, reason, targetBuffer: this.targetBuffer };
    }
  }

  class SessionMetrics {
    constructor() { this.reset(); }
    reset() { this.received = 0; this.rendered = 0; this.dropped = 0; this.decodeErrors = 0; this.stalls = 0; this.rebuffers = 0; this.startedAt = null; this.endedAt = null; }
    record(event, count = 1) { const n = Math.max(0, finite(count, 1)); if (event === "receive") this.received += n; else if (event === "render") this.rendered += n; else if (event === "drop") this.dropped += n; else if (event === "decode-error") this.decodeErrors += n; else if (event === "stall") this.stalls += n; else if (event === "rebuffer") this.rebuffers += n; return this; }
    snapshot() { return { received: this.received, rendered: this.rendered, dropped: this.dropped, decodeErrors: this.decodeErrors, stalls: this.stalls, rebuffers: this.rebuffers, dropRatio: (this.dropped / Math.max(1, this.rendered + this.dropped)) }; }
  }

  const BaseBufferedPlayer = globalThis.BufferedMjpeg?.BufferedMjpegPlayer;
  class ExperimentalMjpegPlayer extends (BaseBufferedPlayer || class {}) {
    constructor(options = {}) {
      if (!BaseBufferedPlayer) throw new Error("Buffered MJPEG player must load before E Auto");
      super(options);
      this.streamStartSeconds = Math.max(0, finite(options.streamStartSeconds, 0));
      this.expectedSessionId = Number(options.sessionId || 0) >>> 0;
      this.onNetworkSample = typeof options.onNetworkSample === "function" ? options.onNetworkSample : () => {};
      this.bandwidth = new DualEwmaEstimator();
      this.lastNetworkChunkAt = null;
      this.mediaBytes = 0;
      this.firstMediaTimestamp = null;
      this.lastMediaTimestamp = null;
      this.stats.bandwidthFast = null;
      this.stats.bandwidthSlow = null;
      this.stats.estimatedBandwidth = null;
      this.stats.mediaBitrate = null;
      this.stats.lateFrames = 0;
      this.stats.protocol = "EAJF/1";
    }

    async start() {
      if (!globalThis.BufferedMjpeg?.supportsBufferedMjpeg?.(this.canvas)) throw new Error("E Auto is not supported by this browser");
      this._setState("buffering", { reason: "startup" });
      try {
        const response = await this.fetchImpl(this.url, { cache: "no-store", signal: this.controller.signal });
        if (!this._active()) return;
        this.stats.responseStartMs = Math.round(performance.now() - this.startedAt);
        const numberHeader = (name) => {
          const value = Number.parseFloat(response.headers.get(name) || "");
          return Number.isFinite(value) ? value : null;
        };
        this.stats.serverResolveMs = numberHeader("x-mjpeg-resolve-ms");
        this.stats.serverFirstOutputMs = numberHeader("x-mjpeg-server-first-output-ms");
        this.stats.ffmpegFirstOutputMs = numberHeader("x-mjpeg-ffmpeg-first-output-ms");
        this.stats.resolveCache = response.headers.get("x-mjpeg-resolve-cache") || null;
        this._milestone("response-start");
        if (!response.ok || !response.body) throw new Error(`E Auto request failed: HTTP ${response.status}`);
        if (!/application\/vnd\.ytstreamer\.eauto\+jpeg/i.test(response.headers.get("content-type") || "")) {
          throw new Error("E Auto response did not use the framed JPEG protocol");
        }
        const responseSession = Number.parseInt(response.headers.get("x-eauto-session-id") || "0", 10) >>> 0;
        if (responseSession !== this.expectedSessionId) throw new Error("E Auto session mismatch");
        this.parser = new EajfParser({ maxFrameBytes: this.maxFrameBytes });
        this.reader = response.body.getReader();
        await this._pumpFramed();
      } catch (error) {
        if (error?.name === "AbortError" || !this._active()) return;
        this._fail(error);
      }
    }

    async _pumpFramed() {
      let pendingRead = this.reader.read();
      while (this._active() && !this.eof) {
        if (!this.queue.canReadMore()) await this.queue.waitUntilReadable(this.controller.signal);
        if (!this._active()) return;
        const { value, done } = await pendingRead;
        if (done) {
          this.parser.end();
          this.eof = true;
          this._emitStats();
          this._maybeStartOrResume();
          if (!this.queue.length && !this._needsAudio()) this._finish();
          break;
        }
        const now = performance.now();
        if (value?.byteLength) {
          if (this.firstByteAt == null) {
            this.firstByteAt = now;
            this.stats.firstByteMs = Math.round(now - this.startedAt);
            this._milestone("first-byte");
          }
          this.stats.receivedBytes += value.byteLength;
          if (this.lastNetworkChunkAt != null) {
            const durationMs = Math.max(1, now - this.lastNetworkChunkAt);
            const sampleBps = (value.byteLength * 8 * 1000) / Math.max(50, durationMs);
            this.bandwidth.sample(sampleBps, durationMs);
            this.stats.bandwidthFast = Math.round(this.bandwidth.fast.estimate || 0);
            this.stats.bandwidthSlow = Math.round(this.bandwidth.slow.estimate || 0);
            this.stats.estimatedBandwidth = Math.round(this.bandwidth.estimate || 0);
            this.onNetworkSample({ sampleBps, durationMs, byteLength: value.byteLength, stats: this.getStats() });
          }
          this.lastNetworkChunkAt = now;
        }
        pendingRead = this.reader.read();
        for (const frame of this.parser.push(value)) await this._enqueueFramed(frame, now);
      }
    }

    async _enqueueFramed(metadata, arrivedAt) {
      if ((metadata.sessionId >>> 0) !== this.expectedSessionId) {
        console.debug("[EAUTO:DROP] stale-session", metadata.sessionId, this.expectedSessionId);
        return;
      }
      await this.queue.waitForRoom(metadata.jpeg.byteLength, this.controller.signal);
      if (!this._active()) return;
      const timestampUs = typeof metadata.videoTimestampUs === "bigint" ? Number(metadata.videoTimestampUs) : metadata.videoTimestampUs;
      const absoluteSeconds = Number.isFinite(timestampUs) ? timestampUs / 1_000_000 : this.streamStartSeconds + metadata.sequence / Math.max(1, metadata.fps || this.fps);
      const frame = {
        index: metadata.sequence,
        sequence: metadata.sequence,
        time: Math.max(0, absoluteSeconds - this.streamStartSeconds),
        videoTimestamp: absoluteSeconds,
        serverTimestampMs: metadata.serverTimestampMs,
        bytes: metadata.jpeg,
        size: metadata.jpeg.byteLength,
        blob: new Blob([metadata.jpeg], { type: "image/jpeg" }),
        decoded: null,
        decodePromise: null,
        released: false,
      };
      if (metadata.fps > 0 && Math.abs(metadata.fps - this.fps) > 0.01) {
        this.fps = metadata.fps;
        this.queue.fps = metadata.fps;
        this.stats.fps = metadata.fps;
      }
      this.stats.jpegQuality = metadata.jpegQuality;
      this.stats.width = metadata.width;
      this.stats.height = metadata.height;
      this.stats.profile = metadata.profile;
      this.mediaBytes += metadata.jpegLength;
      this.firstMediaTimestamp ??= absoluteSeconds;
      this.lastMediaTimestamp = absoluteSeconds;
      const mediaSpan = this.lastMediaTimestamp - this.firstMediaTimestamp;
      if (mediaSpan > 0) this.stats.mediaBitrate = Math.round(this.mediaBytes * 8 / mediaSpan);
      this.queue.push(frame);
      this.stats.receivedFrames += 1;
      if (this.stats.firstFrameReceivedMs == null) {
        this.stats.firstFrameReceivedMs = Math.round(performance.now() - this.startedAt);
        this._milestone("first-frame-received");
        void this._renderStartupPreview(frame);
      }
      if (this.stats.bufferReadyMs == null && this.queue.durationSeconds() >= this.policy.startupSeconds) {
        this.stats.bufferReadyMs = Math.round(performance.now() - this.startedAt);
        this._milestone("buffer-ready", { targetSeconds: this.policy.startupSeconds });
      }
      this._emitStats();
      this._predecode();
      this._maybeStartOrResume();
    }

    _dropStaleFrames(audioClock) {
      const dropped = super._dropStaleFrames(audioClock);
      if (dropped) this.stats.lateFrames += dropped;
      return dropped;
    }

    setBufferTarget(seconds) {
      const target = clamp(finite(seconds, 3), 1.5, 5.5);
      this.policy.startupSeconds = Math.min(this.policy.startupSeconds, Math.max(1.5, target * 0.65));
      this.policy.rebufferSeconds = Math.max(1, Math.min(target, target * 0.65));
      this.policy.maxSeconds = target;
      this.queue.maxDurationSeconds = target;
      this.recovery.baseSeconds = this.policy.rebufferSeconds;
      this.recovery.maxSeconds = target;
      return target;
    }
  }

  function compareSessions(auto, eAuto) {
    const a = auto?.snapshot ? auto.snapshot() : { ...auto }; const b = eAuto?.snapshot ? eAuto.snapshot() : { ...eAuto };
    const keys = ["received", "rendered", "dropped", "decodeErrors", "stalls", "rebuffers", "dropRatio"];
    return Object.fromEntries(keys.map((key) => [key, { auto: finite(a?.[key], 0), eAuto: finite(b?.[key], 0), delta: finite(b?.[key], 0) - finite(a?.[key], 0) }]));
  }

  globalThis.YtExperimentalAuto = Object.freeze({
    MAGIC, HEADER, HEADER_BYTES, readHeader,
    EajfParser, FixedHeaderJpegParser: EajfParser, FixedHeaderJpegIncrementalParser: EajfParser,
    Ewma, DualEwmaEstimator, EwmaBandwidthEstimator: DualEwmaEstimator,
    MjpegAbrController, EAutoAbrController: MjpegAbrController,
    ExperimentalMjpegPlayer,
    SessionMetrics, compareSessions, compareAutoToEAuto: compareSessions,
    PROFILES, DEFAULT_TARGETS, log,
  });
})();
