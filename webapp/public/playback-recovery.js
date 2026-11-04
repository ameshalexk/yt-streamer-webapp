(function (root) {
  'use strict';
  // Keep retrying the same media with capped backoff. A real, sustained
  // playback recovery resets the delay. Stop/Pause/source changes cancel
  // pending timers, and offline/hidden holds resume on return.
  class Monitor {
    constructor({ recover, notify = () => {}, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
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
      if (changedAttempt || held || !sample.started) {
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
        if (sample.audioEnabled && (sample.audioError
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
      if (!sample?.key || sample.paused || sample.hidden || sample.blocked || sample.offline || sample.ended) return false;
      if (sample.key !== this.key) { this.reset(); this.key = sample.key; }
      if (this.pending) {
        // Failures can fire synchronously while replay() is still rebuilding
        // media. Requeue after it settles instead of dropping the only error.
        if (this.inFlight) this.queued = { reason, sample };
        return true;
      }
      this.attempts++;
      this.recoveryActive = true;
      const audioOnly = reason === 'audio' && sample.canRepairAudio && this.audioAttempts < 1;
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
        try { await this.recover({ ...sample, reason, audioOnly, recoveryAttempt: attempt }); }
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
            else if (failed) this.request('failure', sample);
          }
        }
      }, delay);
      return true;
    }
  }
  root.PlaybackRecovery = { Monitor };
})(typeof window !== 'undefined' ? window : globalThis);
