(function (root) {
  'use strict';
  function audioAlignmentPlan({ fullFile = false, streamStartAt = 0, requestedLocalTime = 0,
    currentLocalTime = 0, toleranceSeconds = 0.1 } = {}) {
    const current = Math.max(0, Number(currentLocalTime) || 0);
    const requested = Math.max(0, Number(requestedLocalTime) || 0);
    const start = Math.max(0, Number(streamStartAt) || 0);
    const targetAudioTime = fullFile ? start + current : Math.max(0, current - requested);
    const driftSeconds = fullFile ? 0 : Math.max(0, current - requested);
    return {
      targetAudioTime,
      sourceTimestamp: start + current,
      driftSeconds,
      withinTolerance: driftSeconds <= Math.max(0, toleranceSeconds),
      requestFreshSegment: !fullFile && driftSeconds > Math.max(0, toleranceSeconds),
    };
  }
  // Keep retrying the same media with capped backoff. A real, sustained
  // playback recovery resets the delay. Stop/Pause/source changes cancel
  // pending timers, and offline/hidden holds resume on return.
  class Monitor {
    constructor({ recover, notify = () => {}, now = () => Date.now(),
      schedule = (...args) => setTimeout(...args), cancel = (...args) => clearTimeout(...args),
      stallMs = 15000, audioStallMs = 8000, stableMs = 60000,
      retryDelays = [1000, 3000, 8000, 15000, 30000, 60000] } = {}) {
      Object.assign(this, { recover, notify, now, schedule, cancel, stallMs, audioStallMs, stableMs, retryDelays });
      this.generation = 0;
      this.reset();
    }
    reset() {
      if (this.timer != null) this.cancel(this.timer);
      this.timer = null;
      this.generation++;
      this.key = null;
      this.attempts = 0;
      this.audioAttempts = 0;
      this.pending = false;
      this.inFlight = false;
      this.queued = null;
      this.last = null;
      this.recoveryActive = false;
      this.interrupted = false;
      this.videoAt = this.audioAt = this.healthyAt = this.now();
      this.driftAt = null;
    }
    hold() {
      if (this.pending) {
        this.interrupted = true;
        const timerWasQueued = this.timer != null;
        if (timerWasQueued) this.cancel(this.timer);
        this.timer = null;
        this.generation++;
        this.pending = false;
        this.inFlight = false;
        this.queued = null;
        // A cancelled timer was never attempted; don't increase its backoff.
        if (timerWasQueued) {
          this.attempts = Math.max(0, this.attempts - 1);
          if (this.pendingAudioOnly) this.audioAttempts = Math.max(0, this.audioAttempts - 1);
        }
      }
      this.videoAt = this.audioAt = this.healthyAt = this.now();
      this.driftAt = null;
    }
    cancelForTransition() {
      if (!this.pending) return;
      const timerWasQueued = this.timer != null;
      if (timerWasQueued) this.cancel(this.timer);
      this.timer = null;
      this.generation++;
      this.pending = false;
      this.inFlight = false;
      this.queued = null;
      // A transition can make a scheduled retry stale. Preserve its attempt
      // number so a flapping source cannot continually regain the first delay.
    }
    isVideoRecoveryPending() {
      return this.pending && !this.pendingAudioOnly;
    }
    resume(sample = this.last) {
      if (!this.interrupted || this.pending || !sample) return false;
      this.interrupted = false;
      return this.request('resume', { ...sample, hidden: false, offline: false });
    }
    observe(sample) {
      if (!sample?.key) return;
      if (sample.key !== this.key) { this.reset(); this.key = sample.key; }
      const now = this.now();
      const prior = this.last;
      const changedAttempt = prior?.attempt !== sample.attempt;
      const held = sample.paused || sample.hidden || sample.blocked || sample.offline || sample.ended;
      if (held) this.hold();
      if (sample.transitioning && !held) {
        this.cancelForTransition();
        this.videoAt = this.audioAt = this.healthyAt = now;
        this.driftAt = null;
      } else if (changedAttempt || held || !sample.started) {
        this.videoAt = this.audioAt = this.healthyAt = now;
        this.driftAt = null;
      } else {
        const progressed = sample.videoProgress > (prior?.videoProgress ?? -1);
        const audioProgressed = sample.audioTime > (prior?.audioTime ?? -1) + 0.02;
        if (progressed) this.videoAt = now;
        if (!sample.audioEnabled || audioProgressed) this.audioAt = now;
        if (progressed && (!sample.audioEnabled || audioProgressed)) {
          this.interrupted = false;
          // Playback may resume on its own before the queued retry fires.
          // Never interrupt a healthy stream just to spend a retry.
          if (this.timer != null) {
            this.cancel(this.timer);
            this.timer = null;
            this.generation++;
            this.pending = false;
            this.attempts = Math.max(0, this.attempts - 1);
            if (this.pendingAudioOnly) this.audioAttempts = Math.max(0, this.audioAttempts - 1);
          }
          if (now - this.healthyAt >= this.stableMs) {
            this.attempts = this.audioAttempts = 0;
            this.recoveryActive = false;
          }
        } else this.healthyAt = now;
        const drifted = sample.audioEnabled && Math.abs(sample.driftMs || 0) > 1500;
        if (drifted) this.driftAt ??= now;
        else this.driftAt = null;
        const audioRepairSuppressed = sample.audioStatus === 'retrying' || sample.audioStatus === 'gesture-required';
        if (sample.audioEnabled && !audioRepairSuppressed && (sample.audioError
            || (sample.videoAvailable && now - this.audioAt >= this.audioStallMs)
            || (this.driftAt != null && now - this.driftAt >= 5000))) {
          this.request('audio', sample);
        } else if (sample.canMeasureVideo && now - this.videoAt >= this.stallMs) {
          this.request('video', sample);
        }
      }
      this.last = { ...sample };
    }
    request(reason, sample = this.last) {
      if (!sample?.key || sample.paused || sample.hidden || sample.blocked || sample.offline || sample.ended || sample.transitioning) return false;
      if (sample.key !== this.key) { this.reset(); this.key = sample.key; }
      // A buffered audio transport has its own current-position repair path.
      // Only an independent video failure can preempt its scheduled retry.
      const audioOnly = reason === 'audio' && sample.canRepairAudio;
      if (this.pending && this.pendingAudioOnly && !audioOnly && this.timer != null) {
        this.cancel(this.timer);
        this.timer = null;
        this.generation++;
        this.pending = false;
        this.attempts = Math.max(0, this.attempts - 1);
        this.audioAttempts = Math.max(0, this.audioAttempts - 1);
      }
      if (this.pending) {
        // A video failure cannot be replaced by an audio-only follow-up.
        if (this.inFlight && (!audioOnly || !this.queued || this.queued.reason === 'audio')) {
          this.queued = { reason, sample };
        }
        return true;
      }
      this.attempts++;
      this.recoveryActive = true;
      if (audioOnly) this.audioAttempts++;
      this.pendingAudioOnly = audioOnly;
      const generation = this.generation;
      this.pending = true;
      const attempt = this.attempts;
      const delay = this.retryDelays[Math.min(attempt - 1, this.retryDelays.length - 1)];
      this.notify({ state: 'recovering', reason, audioOnly, attempt, delay });
      this.timer = this.schedule(async () => {
        this.timer = null;
        if (generation !== this.generation) return;
        this.inFlight = true;
        let failed = false;
        try {
          const result = await this.recover({ ...sample, reason, audioOnly, recoveryAttempt: attempt });
          if (generation === this.generation) {
            const status = result?.status;
            if (status === 'failed' || result?.ok === false) {
              failed = true;
              this.notify({ state: 'failed', reason, attempt });
            } else if (status === 'canceled' || result?.canceled === true) {
              this.notify({ state: 'canceled', reason, attempt });
            } else if (status === 'noop' || result?.noop === true) {
              this.notify({ state: 'noop', reason, attempt });
            } else if (status === 'playing' || result?.playing === true || result === true) {
              this.notify({ state: 'playing', reason, attempt });
            } else if (status === 'started') {
              this.notify({ state: 'started', reason, attempt });
            } else {
              // Legacy recovery callbacks return undefined. They completed,
              // but that is not proof that media actually started playing.
              this.notify({ state: 'noop', reason, attempt });
            }
          }
        }
        catch {
          failed = true;
          if (generation === this.generation) this.notify({ state: 'failed', reason, attempt });
        } finally {
          if (generation === this.generation) {
            this.inFlight = false;
            this.pending = false;
            this.videoAt = this.audioAt = this.healthyAt = this.now();
            this.driftAt = null;
            const queued = this.queued;
            this.queued = null;
            if (queued) this.request(queued.reason, queued.sample);
            else if (failed) this.request(audioOnly ? 'audio' : 'failure', sample);
          }
        }
      }, delay);
      return true;
    }
  }
  root.PlaybackRecovery = { Monitor, audioAlignmentPlan };
})(typeof window !== 'undefined' ? window : globalThis);
