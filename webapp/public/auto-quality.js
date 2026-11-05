(() => {
  "use strict";

  const TIER_ORDER = Object.freeze(["low", "medium", "high"]);
  const BUFFER_POLICIES = Object.freeze({
    low: Object.freeze({
      id: "auto-low",
      startupSeconds: 3.5,
      rebufferSeconds: 2.25,
      maxQueueSeconds: 7,
    }),
    medium: Object.freeze({
      id: "auto-medium",
      startupSeconds: 3,
      rebufferSeconds: 1.75,
      maxQueueSeconds: 6,
    }),
    high: Object.freeze({
      id: "auto-high",
      startupSeconds: 3,
      rebufferSeconds: 1.5,
      maxQueueSeconds: 8,
    }),
  });

  const DEFAULT_PROFILES = Object.freeze({
    low: { height: 360, fps: 12, quality: 12 },
    medium: { height: 480, fps: 15, quality: 7 },
    high: { height: 480, fps: 24, quality: 4 },
  });
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const positive = (value) => number(value) > 0 ? value : null;
  const round = (value) => value == null ? null : Math.round(value);
  const nextTier = (tier, delta) => TIER_ORDER[TIER_ORDER.indexOf(tier) + delta];

  function metricsFor(stats = {}, policy = BUFFER_POLICIES.medium) {
    const webcodecs = stats.transport === "webcodecs";
    const rate = webcodecs ? Math.max(1, positive(stats.playbackRate) || 1) : 1;
    const fps = (positive(stats.fps) || 15) * rate;
    const sourceSpeed = number(stats.producerSpeed);
    const sourceTarget = positive(stats.queueTargetSeconds);
    return {
      fps,
      rate,
      renderedFrames: number(stats.renderedFrames) ?? 0,
      droppedFrames: number(stats.droppedFrames) ?? 0,
      // WebCodecs reports source time. Compare the buffer and frame cadence
      // in wall time so a 2× session needs twice as many frames per second.
      queueSeconds: Math.max(0, number(stats.queueSeconds) ?? 0) / rate,
      target: sourceTarget == null ? (webcodecs ? 0.35 : policy.rebufferSeconds) : sourceTarget / rate,
      producerSpeed: sourceSpeed == null
        ? (number(stats.receiveFps) == null ? null : stats.receiveFps / fps)
        : sourceSpeed / rate,
      renderedFps: number(stats.renderedFps),
      averageDecodeMs: number(stats.averageDecodeMs),
      decoderQueueSize: number(stats.decoderQueueSize),
      driftMs: Math.abs(number(stats.lastAvDriftMs) ?? 0) / rate,
      deliveryBps: positive(stats.deliveryBps) || (positive(stats.receiveBytesPerSecond) || 0) * 8,
      capacityBps: positive(stats.capacityBps),
      mediaBps: positive(stats.mediaBps),
      latencyMs: number(stats.latencyMs),
      rebufferCount: number(stats.rebufferCount) ?? 0,
      rebufferDurationMs: number(stats.rebufferDurationMs) ?? 0,
    };
  }

  // The two transports expose different evidence: successful DASH segment
  // fetches can measure capacity; a paced MJPEG response only shows delivery.
  // JPEG demand uses observed content cost, scaled for pixel rate and q:v.
  // DASH's peak rates match bitrateForHeight in cyberdash-dash.js.
  function dashPeakBps(height) {
    return height >= 1080 ? 5500000 : height >= 720 ? 3200000 : height >= 480 ? 1900000 : 1200000;
  }

  class AutoQualityController {
    constructor({ now = () => performance.now() } = {}) {
      this.now = now;
      this.enabled = false;
      this.tier = "medium";
      this.resetSession();
    }

    resetSession() {
      this.lastSwitchAt = -Infinity;
      this.retryAfter = -Infinity;
      this.failedUpgrades = 0;
      this.failedTrials = 0;
      this.trialRetryAfter = -Infinity;
      this.lastTrialAt = -Infinity;
      this.recoveryCeiling = 0;
      this.lastUpgradeAt = -Infinity;
      this.lastRebufferAt = -Infinity;
      this.time = { low: 0, medium: 0, high: 0 };
      this.upgrades = this.downgrades = this.rebuffers = this.rebufferMs = 0;
      this.beginAttempt();
    }

    enable({ tier = "medium" } = {}) {
      this.enabled = true;
      this.tier = TIER_ORDER.includes(tier) ? tier : "medium";
      this.resetSession();
      return this.tier;
    }

    disable() { this.enabled = false; this.hold(); }

    selectTier(tier) {
      if (TIER_ORDER.includes(tier)) this.tier = tier;
      this.hold();
      return this.tier;
    }

    beginAttempt() {
      const { DualEwmaEstimator, Ewma } = globalThis.YtExperimentalAuto;
      this.delivery = new DualEwmaEstimator();
      this.capacity = new DualEwmaEstimator();
      this.producer = new DualEwmaEstimator();
      this.demand = new Ewma(8);
      this.latency = new Ewma(5);
      this.depletion = new Ewma(2);
      this.decode = new Ewma(4);
      this.render = new Ewma(3);
      this.drops = new Ewma(3);
      this.bufferHealth = new Ewma(3);
      this.recentCapacityAt = -Infinity;
      this.recentDeliveryAt = -Infinity;
      this.decodeQueueSince = null;
      this.samples = 0;
      this.attemptStartedAt = this.now();
      this.rebufferCount = this.rebufferDurationMs = 0;
      this.rebufferTimes = [];
      this.snapshot = null;
      this.hold();
    }

    hold() {
      this.last = null;
      this.deliverySince = this.decodeSince = this.stableSince = null;
    }

    readyForSample(now = this.now()) { return !this.last || now - this.last.at >= 900; }

    getBufferPolicy() { return { ...BUFFER_POLICIES[this.tier] }; }

    getTelemetry() {
      return {
        ...this.snapshot,
        adaptiveTier: this.tier,
        adaptiveUpgrades: this.upgrades,
        adaptiveDowngrades: this.downgrades,
        adaptiveLowMs: round(this.time.low),
        adaptiveMediumMs: round(this.time.medium),
        adaptiveHighMs: round(this.time.high),
        adaptiveRebuffers: this.rebuffers,
        adaptiveRebufferMs: round(this.rebufferMs),
      };
    }

    observe(stats = {}) {
      if (!this.enabled) return null;
      const now = this.now();
      const m = metricsFor(stats, BUFFER_POLICIES[this.tier]);
      const active = ["playing", "buffering", "syncing"].includes(stats.state) && m.renderedFrames > 0;
      if (!active || stats.adaptiveEligible === false || stats.transitioning || stats.hidden || stats.offline
          || stats.paused || stats.sourceFailure || stats.audioOnlyPressure || stats.sourceEnded || stats.eof) {
        // A hold breaks consecutive evidence, even if no callbacks arrive
        // while the browser is suspended. Never train on interrupted windows.
        this.hold();
        return null;
      }
      if (!this.readyForSample(now)) return null;
      const prior = this.last;
      const dt = prior ? now - prior.at : 0;
      this.last = { ...m, at: now };
      if (dt > 3000) {
        this.hold();
        this.last = { ...m, at: now };
      }
      const consecutive = dt >= 900 && dt <= 3000;
      const rebuffers = Math.max(0, m.rebufferCount - this.rebufferCount);
      this.rebufferCount = m.rebufferCount;
      if (rebuffers) {
        this.rebuffers += rebuffers;
        this.lastRebufferAt = now;
        this.rebufferTimes.push(now);
      }
      this.rebufferMs += Math.max(0, m.rebufferDurationMs - this.rebufferDurationMs);
      this.rebufferDurationMs = m.rebufferDurationMs;
      this.rebufferTimes = this.rebufferTimes.filter((t) => now - t <= 20000);
      if (!consecutive) return null;

      this.samples++;
      if (stats.state !== "buffering") this.time[this.tier] += dt;
      const wc = stats.transport === "webcodecs";
      const profiles = stats.profiles || DEFAULT_PROFILES;
      const from = profiles[this.tier];
      if (!from) return null;
      const upper = nextTier(this.tier, 1);
      const candidate = profiles[upper];
      const rate = m.rate;
      const audioBps = stats.audioMuted ? 0 : 160000;
      if (m.deliveryBps > 0) {
        this.delivery.sample(m.deliveryBps, dt);
        this.recentDeliveryAt = now;
      }
      const capacitySampleAt = number(stats.capacitySampleAt) ?? now;
      if (m.capacityBps != null && capacitySampleAt > this.recentCapacityAt) {
        this.capacity.sample(m.capacityBps, dt);
        this.recentCapacityAt = capacitySampleAt;
      }
      if (m.mediaBps != null) this.demand.sample(m.mediaBps, dt);
      if (m.latencyMs != null && m.latencyMs >= 0) this.latency.sample(m.latencyMs, dt);
      if (m.producerSpeed != null) this.producer.sample(m.producerSpeed, dt);
      const slope = this.depletion.sample((prior.queueSeconds - m.queueSeconds) * 1000 / dt + 10, dt) - 10;
      const renderRatio = Math.max(0, m.renderedFrames - prior.renderedFrames) / (m.fps * dt / 1000);
      const drops = Math.max(0, m.droppedFrames - prior.droppedFrames);
      const dropRatio = drops / Math.max(1, drops + m.renderedFrames - prior.renderedFrames);
      const decodeLoad = m.averageDecodeMs == null ? null : this.decode.sample(m.averageDecodeMs * m.fps / 1000, dt);
      const renderHealth = this.render.sample(Math.min(1.2, renderRatio), dt);
      const dropLoad = this.drops.sample(dropRatio, dt);
      const bufferHealth = this.bufferHealth.sample(m.queueSeconds, dt);
      const demand = this.demand.estimate;
      const measuredCapacity = wc && now - this.recentCapacityAt <= 3500 ? this.capacity.estimate : null;
      const delivered = now - this.recentDeliveryAt <= 3500 ? this.delivery.estimate : null;
      const estimate = wc ? measuredCapacity : delivered;
      const highLatency = wc && this.latency.estimate > 200;
      const volatile = (wc ? this.capacity : this.delivery);
      const fluctuating = volatile.fast.estimate != null && volatile.slow.estimate != null
        && volatile.fast.estimate < volatile.slow.estimate * 0.82;
      const safety = highLatency || fluctuating ? 0.70 : 0.82;
      const sustainable = estimate == null ? null : estimate * safety;
      const critical = m.queueSeconds < m.target * (wc ? 0.75 : 0.65);
      const draining = slope > (wc ? 0.04 : 0.10) && m.queueSeconds < m.target * 1.15;
      const receiving = (m.producerSpeed ?? 0) >= 0.88 || m.queueSeconds >= m.target * 0.90;
      // A slow renderer on an empty queue is usually a consequence of
      // starvation. Only diagnose a device when input is available.
      if (wc && (m.decoderQueueSize ?? 0) >= 4) this.decodeQueueSince ??= now;
      else this.decodeQueueSince = null;
      const decoderBacklog = this.decodeQueueSince != null && now - this.decodeQueueSince >= 3000;
      const decodePressure = (receiving || decoderBacklog) && (
        (decodeLoad != null && decodeLoad > 0.78) || (decoderBacklog && renderRatio < 0.88)
        || (dropRatio > 0.10 && renderRatio < 0.88 && m.driftMs < 350)
      );
      const capacityShort = measuredCapacity != null && demand != null && measuredCapacity < (demand * rate + audioBps) * 1.08;
      const producerShort = m.producerSpeed != null && m.producerSpeed < 0.83
        && (this.producer.estimate ?? 1) < 0.91;
      const underfed = producerShort && delivered != null && !stats.sourceWaiting;
      const deliveryPressure = !decodePressure && (critical || draining) && (capacityShort || underfed);
      if (decodePressure) this.decodeSince ??= now;
      else this.decodeSince = null;
      if (deliveryPressure) this.deliverySince ??= now;
      else this.deliverySince = null;
      let nextDemand = null;
      let loadScale = null;
      if (candidate) {
        loadScale = (Number(candidate.height) / Number(from.height)) ** 2
          * (Number(candidate.fps) / Number(from.fps));
        nextDemand = wc ? Math.max(dashPeakBps(Number(candidate.height)), demand || 0) * rate + audioBps
          : demand == null ? null : demand * loadScale * (Number(from.quality) / Number(candidate.quality)) ** 0.45;
      }
      this.snapshot = {
        deliveryBps: round(m.deliveryBps), sustainableBps: wc ? round(sustainable) : null,
        deliveryFloorBps: wc ? null : round(sustainable), mediaBps: round(demand),
        capacityFastBps: round(this.capacity.fast.estimate), capacitySlowBps: round(this.capacity.slow.estimate),
        deliveryFastBps: round(this.delivery.fast.estimate), deliverySlowBps: round(this.delivery.slow.estimate),
        candidateBps: round(nextDemand), latencyMs: round(this.latency.estimate), queueDepletion: Math.round(slope * 1000) / 1000,
        decodeLoad: decodeLoad == null ? null : Math.round(decodeLoad * 1000) / 1000,
        adaptiveSignal: decodePressure ? "device" : deliveryPressure ? (capacityShort ? "network" : "delivery") : "healthy",
      };

      const lower = nextTier(this.tier, -1);
      const lowerProfile = profiles[lower];
      const distinctLower = lowerProfile && (!wc || Number(lowerProfile.fps) < Number(from.fps)
        || Number(lowerProfile.height) < Number(from.height));
      if (distinctLower && now - this.attemptStartedAt >= 8000 && now - this.lastSwitchAt >= 8000) {
        const repeated = this.rebufferTimes.length >= 2 && deliveryPressure;
        const reason = this.decodeSince != null && now - this.decodeSince >= 4000 ? "device-overload"
          : repeated ? "rebuffer"
          : this.deliverySince != null && now - this.deliverySince >= 3000 ? (capacityShort ? "bandwidth-shortfall" : "delivery-slow")
          : null;
        if (reason) {
          // Failed upgrades impose progressively longer quiet periods on
          // later trials (bounded at ten minutes for a long session).
          if (now - this.lastUpgradeAt < 45000) this.failedUpgrades++;
          if (now - this.lastTrialAt < 45000) this.deferPacedTrial(now);
          this.retryAfter = now + Math.min(600000, 24000 * 2 ** Math.min(this.failedUpgrades, 5));
          // If sustained delivery is far below even the intermediate profile,
          // skip its encoder rebuild. Keep ordinary and device downshifts one tier.
          this.recoveryCeiling = Math.max(this.recoveryCeiling, TIER_ORDER.indexOf(this.tier));
          const severeDelivery = reason !== "device-overload" && critical && (m.producerSpeed ?? 1) < 0.55
            && (capacityShort || underfed) && this.tier === "high" && profiles.low;
          return this.switchTo(severeDelivery ? "low" : lower, reason, now);
        }
      }

      const headroom = sustainable != null && nextDemand != null && sustainable >= nextDemand;
      const projectedDeviceOK = wc
        ? !decoderBacklog && (m.decoderQueueSize ?? 0) <= 2
        : decodeLoad != null && loadScale != null && decodeLoad * loadScale <= 0.55;
      const healthy = candidate && loadScale > 1 && projectedDeviceOK && stats.state === "playing"
        && this.samples >= 6 && m.queueSeconds >= m.target * (wc ? 0.35 : 0.65)
        && bufferHealth >= m.target * (wc ? 0.65 : 0.90) && slope < 0.12
        && renderHealth >= 0.94 && renderRatio >= 0.80 && dropLoad <= 0.025
        && m.driftMs <= 150 && !decodePressure
        && now - this.lastSwitchAt >= 18000 && now - this.lastRebufferAt >= 20000
        && now >= this.retryAfter && !fluctuating;
      // MJPEG cannot expose unused link capacity when FFmpeg or the browser
      // paces reads. A trial can restore an earlier tier after a downgrade,
      // never raise initial quality purely on the absence of a stall.
      const trial = !wc && upper && TIER_ORDER.indexOf(upper) <= this.recoveryCeiling
        && now >= this.trialRetryAfter && nextDemand != null && m.producerSpeed >= 0.97
        && delivered != null && demand != null && delivered >= demand * 0.90;
      if (!healthy || (!headroom && !trial)) {
        this.stableSince = null;
        return null;
      }
      this.stableSince ??= now;
      if (now - this.stableSince < (headroom ? 18000 : 60000)) return null;
      this.lastUpgradeAt = now;
      if (!headroom) this.lastTrialAt = now;
      return this.switchTo(upper, headroom ? "stable-headroom" : "paced-delivery-trial", now);
    }

    switchTo(to, reason, now) {
      const from = this.tier;
      this.tier = to;
      this.lastSwitchAt = now;
      this.hold();
      if (TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from)) this.upgrades++;
      else this.downgrades++;
      return { action: "switch", from, to, reason, metrics: this.getTelemetry() };
    }

    deferPacedTrial(now) {
      this.failedTrials++;
      this.trialRetryAfter = now + Math.min(600000, 300000 * this.failedTrials);
    }

    rejectSwitch(decision) {
      if (this.tier !== decision?.to) return;
      this.selectTier(decision.from);
      this.failedUpgrades++;
      this.lastSwitchAt = this.now();
      if (decision.reason === "paced-delivery-trial") this.deferPacedTrial(this.lastSwitchAt);
      this.retryAfter = this.lastSwitchAt + Math.min(600000, 24000 * 2 ** Math.min(this.failedUpgrades, 5));
    }

    cancelSwitch(decision) {
      if (this.tier !== decision?.to) return;
      this.selectTier(decision.from);
      if (TIER_ORDER.indexOf(decision.to) > TIER_ORDER.indexOf(decision.from)) this.upgrades--;
      else this.downgrades--;
    }
  }

  globalThis.YtAutoQuality = Object.freeze({ TIER_ORDER, BUFFER_POLICIES, AutoQualityController, metricsFor });
})();
