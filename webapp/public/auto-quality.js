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

  function finite(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampRatio(value) {
    return Number.isFinite(value) ? Math.max(0, value) : null;
  }

  function tierIndex(tier) {
    return Math.max(0, TIER_ORDER.indexOf(tier));
  }

  function nextTier(tier, direction) {
    const index = tierIndex(tier);
    return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, index + direction))];
  }

  function metricsFor(stats = {}, policy = BUFFER_POLICIES.medium) {
    const fps = Math.max(1, finite(stats.fps, 24));
    const receiveFps = finite(stats.receiveFps);
    const renderedFps = finite(stats.renderedFps);
    const renderedFrames = Math.max(0, finite(stats.renderedFrames, 0));
    const receivedFrames = Math.max(0, finite(stats.receivedFrames, 0));
    const droppedFrames = Math.max(0, finite(stats.droppedFrames, 0));
    const totalRenderFrames = Math.max(1, renderedFrames + droppedFrames);
    const dropRatio = droppedFrames / totalRenderFrames;
    const frameBudgetMs = 1000 / fps;
    const averageDecodeMs = finite(stats.averageDecodeMs);
    const driftMs = Math.abs(finite(stats.lastAvDriftMs, 0));
    const queueSeconds = Math.max(0, finite(stats.queueSeconds, 0));
    const producerSpeed = finite(stats.producerSpeed,
      receiveFps == null ? null : receiveFps / fps);
    return {
      fps,
      receiveFps,
      renderedFps,
      renderRatio: clampRatio(renderedFps == null ? null : renderedFps / fps),
      producerSpeed: clampRatio(producerSpeed),
      renderedFrames,
      receivedFrames,
      droppedFrames,
      dropRatio,
      frameBudgetMs,
      averageDecodeMs,
      driftMs,
      queueSeconds,
      queueTrend: String(stats.queueTrend || "unknown"),
      rebufferCount: Math.max(0, finite(stats.rebufferCount, 0)),
      state: String(stats.state || ""),
      maxQueueSeconds: Math.max(0.25, finite(policy?.maxQueueSeconds, 6)),
      rebufferSeconds: Math.max(0.25, finite(policy?.rebufferSeconds, 1.75)),
    };
  }

  class AutoQualityController {
    constructor({
      now = () => Date.now(),
      observeIntervalMs = 1000,
      switchCooldownMs = 10000,
      emergencyCooldownMs = 3500,
      lowUpgradeStableMs = 12000,
      mediumUpgradeStableMs = 18000,
    } = {}) {
      this.now = now;
      this.observeIntervalMs = observeIntervalMs;
      this.switchCooldownMs = switchCooldownMs;
      this.emergencyCooldownMs = emergencyCooldownMs;
      this.lowUpgradeStableMs = lowUpgradeStableMs;
      this.mediumUpgradeStableMs = mediumUpgradeStableMs;
      this.enabled = false;
      this.tier = "medium";
      this.lastSwitchAt = 0;
      this.lastObservedAt = Number.NEGATIVE_INFINITY;
      this.stableSince = null;
      this.lastRebufferCount = 0;
    }

    enable({ tier = "medium" } = {}) {
      this.enabled = true;
      this.tier = TIER_ORDER.includes(tier) ? tier : "medium";
      this.lastSwitchAt = 0;
      this.beginAttempt();
      return this.tier;
    }

    disable() {
      this.enabled = false;
      this.stableSince = null;
      this.lastObservedAt = Number.NEGATIVE_INFINITY;
      this.lastRebufferCount = 0;
    }

    beginAttempt() {
      this.lastObservedAt = Number.NEGATIVE_INFINITY;
      this.stableSince = null;
      this.lastRebufferCount = 0;
    }

    selectTier(tier, { switched = false } = {}) {
      if (!TIER_ORDER.includes(tier)) return this.tier;
      this.tier = tier;
      this.stableSince = null;
      this.lastRebufferCount = 0;
      if (switched) this.lastSwitchAt = this.now();
      return this.tier;
    }

    getBufferPolicy() {
      return { ...BUFFER_POLICIES[this.tier] };
    }

    observe(stats = {}) {
      if (!this.enabled) return null;
      const now = this.now();
      const policy = BUFFER_POLICIES[this.tier];
      const m = metricsFor(stats, policy);

      if (m.rebufferCount < this.lastRebufferCount) this.lastRebufferCount = m.rebufferCount;
      const newRebuffer = m.rebufferCount > this.lastRebufferCount;
      this.lastRebufferCount = m.rebufferCount;

      if (["paused", "background", "autoplay-blocked", "idle"].includes(m.state)) {
        this.stableSince = null;
        return null;
      }

      if (!newRebuffer && now - this.lastObservedAt < this.observeIntervalMs) return null;
      this.lastObservedAt = now;

      const sinceSwitch = this.lastSwitchAt ? now - this.lastSwitchAt : Number.POSITIVE_INFINITY;
      const enoughReceiveHistory = m.receivedFrames >= m.fps * 4;
      const enoughRenderHistory = m.renderedFrames >= m.fps * 4;

      const renderPressure = enoughRenderHistory && (
        (m.renderRatio != null && m.renderRatio < 0.84)
        || m.dropRatio > 0.08
        || (m.averageDecodeMs != null && m.averageDecodeMs > m.frameBudgetMs * 0.82)
        || m.driftMs > 240
      );

      const deliveryPressure = enoughReceiveHistory && (
        (m.receiveFps != null && m.receiveFps < m.fps * 0.90
          && m.queueSeconds < Math.max(1.25, m.rebufferSeconds))
        || (m.queueTrend === "shrinking"
          && m.queueSeconds < Math.max(1.25, m.rebufferSeconds * 1.15))
      );

      if (this.tier !== "low"
          && (newRebuffer || renderPressure || deliveryPressure)
          && sinceSwitch >= this.emergencyCooldownMs) {
        const reason = newRebuffer ? "rebuffer" : (renderPressure ? "device-overload" : "delivery-slow");
        return this._switch(nextTier(this.tier, -1), reason, m, now);
      }

      if (m.state !== "playing" || sinceSwitch < this.switchCooldownMs || this.tier === "high") {
        this.stableSince = null;
        return null;
      }

      const queueHealthy = m.queueSeconds >= Math.max(
        policy.startupSeconds,
        policy.maxQueueSeconds * 0.58
      );
      const strongDelivery = m.producerSpeed != null && m.producerSpeed >= (this.tier === "low" ? 1.12 : 1.10);
      const strongRender = enoughRenderHistory
        && m.renderRatio != null
        && m.renderRatio >= 0.97
        && m.dropRatio < 0.015
        && (m.averageDecodeMs == null || m.averageDecodeMs <= m.frameBudgetMs * 0.55)
        && m.driftMs <= 120;
      const stable = m.rebufferCount === 0 && queueHealthy && strongDelivery && strongRender;

      if (!stable) {
        this.stableSince = null;
        return null;
      }

      if (this.stableSince == null) {
        this.stableSince = now;
        return null;
      }

      const requiredStableMs = this.tier === "low"
        ? this.lowUpgradeStableMs
        : this.mediumUpgradeStableMs;
      if (now - this.stableSince < requiredStableMs) return null;

      return this._switch(nextTier(this.tier, 1), "stable-headroom", m, now);
    }

    _switch(to, reason, metrics, now) {
      const from = this.tier;
      if (to === from) return null;
      this.tier = to;
      this.lastSwitchAt = now;
      this.lastObservedAt = now;
      this.stableSince = null;
      this.lastRebufferCount = metrics.rebufferCount;
      return { action: "switch", from, to, reason, metrics: { ...metrics } };
    }
  }

  globalThis.YtAutoQuality = Object.freeze({
    TIER_ORDER,
    BUFFER_POLICIES,
    AutoQualityController,
    metricsFor,
  });
})();
