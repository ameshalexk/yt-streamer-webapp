(function (root) {
  'use strict';
  // One bounded budget follows a source across reconnects. Only sustained
  // healthy playback or an explicit user action gives it a fresh budget.
  class Monitor {
    constructor({ recover, notify = () => {}, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
      stallMs = 15000, audioStallMs = 8000, stableMs = 60000, maxAttempts = 3 } = {}) {
      Object.assign(this, { recover, notify, now, schedule, cancel, stallMs, audioStallMs, stableMs, maxAttempts });
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
      this.last = null;
      this.videoAt = this.audioAt = this.healthyAt = this.now();
      this.driftAt = null;
      this.exhausted = false;
    }
    hold() {
      if (this.timer != null) {
        this.cancel(this.timer);
        this.timer = null;
        this.generation++;
        this.pending = false;
        this.attempts = Math.max(0, this.attempts - 1);
        if (this.pendingAudioOnly) this.audioAttempts = Math.max(0, this.audioAttempts - 1);
      }
      this.videoAt = this.audioAt = this.healthyAt = this.now();
      this.driftAt = null;
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
          if (now - this.healthyAt >= this.stableMs) {
            this.attempts = this.audioAttempts = 0;
            this.exhausted = false;
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
      if (this.pending) return true;
      if (this.attempts >= this.maxAttempts) {
        if (!this.exhausted) this.notify({ state: 'exhausted', reason, attempt: this.attempts });
        this.exhausted = true;
        return false;
      }
      this.attempts++;
      const audioOnly = reason === 'audio' && sample.canRepairAudio && this.audioAttempts < 1;
      if (audioOnly) this.audioAttempts++;
      this.pendingAudioOnly = audioOnly;
      const generation = this.generation;
      this.pending = true;
      this.notify({ state: 'recovering', reason, audioOnly, attempt: this.attempts });
      const delay = [1000, 3000, 8000][this.attempts - 1] || 8000;
      this.timer = this.schedule(async () => {
        this.timer = null;
        if (generation !== this.generation) return;
        try { await this.recover({ ...sample, reason, audioOnly, recoveryAttempt: this.attempts }); }
        catch { if (generation === this.generation) this.notify({ state: 'failed', reason, attempt: this.attempts }); }
        finally {
          if (generation === this.generation) {
            this.pending = false;
            this.videoAt = this.audioAt = this.healthyAt = this.now();
            this.driftAt = null;
          }
        }
      }, delay);
      return true;
    }
  }
  root.PlaybackRecovery = { Monitor };
})(typeof window !== 'undefined' ? window : globalThis);
