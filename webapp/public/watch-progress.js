(function (root) {
  "use strict";

  function resumePosition(item = {}) {
    if (item.isLive || item.completed) return 0;
    const position = item.positionSeconds;
    if (typeof position !== "number" || !Number.isFinite(position) || position < 0) return 0;
    const duration = item.duration;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      if (position >= duration * 0.98 || (duration > 10 && position >= duration - 5)) return 0;
      return Math.min(position, duration);
    }
    return position;
  }

  class Tracker {
    constructor({ record, update, capture, onSaved = () => {}, onError = () => {} }) {
      Object.assign(this, { record, update, capture, onSaved, onError });
      this.session = null;
      this.chain = Promise.resolve();
    }

    enqueue(task) {
      const request = this.chain.then(task);
      this.chain = request.catch(this.onError);
      return request;
    }

    begin(payload) {
      this.stop();
      const session = {
        key: payload.youtubeId || payload.url,
        token: root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sequence: 0,
        entry: null,
      };
      this.session = session;
      return this.enqueue(async () => {
        session.entry = await this.record({ ...payload, playbackSessionId: session.token });
        if (!this.session || this.session === session || this.session.key !== session.key) this.onSaved(session.entry);
        return session.entry;
      });
    }

    save({ keepalive = false, positionSeconds } = {}) {
      const session = this.session;
      if (!session) return this.chain;
      const snapshot = this.capture();
      if (!snapshot || snapshot.isLive) return this.chain;
      if (positionSeconds !== undefined) snapshot.positionSeconds = positionSeconds;
      if (!Number.isFinite(snapshot.positionSeconds) || snapshot.positionSeconds < 0) return this.chain;
      const payload = { ...snapshot, playbackSessionId: session.token, sequence: session.sequence++ };
      return this.enqueue(async () => {
        if (!session.entry || session.entry.isLive) return null;
        const entry = await this.update(session.entry.id, payload, keepalive);
        if (this.session === session) {
          session.entry = entry;
        }
        // Update the old video's History row after Stop/switch, never a newer
        // viewing session for the same video.
        if (!this.session || this.session === session || this.session.key !== session.key) this.onSaved(entry);
        return entry;
      });
    }

    stop() {
      const request = this.save();
      this.session = null;
      return request;
    }
  }

  root.WatchProgress = { Tracker, resumePosition };
})(globalThis);
