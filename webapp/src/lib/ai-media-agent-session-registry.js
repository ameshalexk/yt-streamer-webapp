import { randomUUID } from "node:crypto";

// Transport-neutral core: callers of this module must independently authenticate
// the owner and browser at ingress. Pairing validation deliberately defaults DENY.
const MUTATIONS = new Set(["play_media", "pause", "resume", "stop", "next", "seek", "set_volume", "request_fullscreen"]);
const READS = new Set(["get_player_state", "search_media"]);
const VALID_STATUSES = new Set(["completed", "failed", "unsupported", "needs_user_gesture", "accepted", "playing", "paused", "buffering"]);
const VALID_PHASES = new Set(["idle", "playing", "paused", "buffering", "failed", "needs_user_gesture"]);

function text(value, max = 80) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function fail(reason) { throw Object.assign(new Error(reason), { code: reason }); }
function boundedResult(value) {
  if (!value || !Array.isArray(value.results)) return null;
  return { results: value.results.slice(0, 10).filter(item => item && typeof item === "object")
    .map(item => ({
      media_id: String(item.media_id || "").slice(0, 40),
      title: String(item.title || "").slice(0, 160),
      creator: String(item.creator || "").slice(0, 100),
      duration_seconds: Number.isFinite(item.duration_seconds) ? Math.max(0, Math.min(86400, item.duration_seconds)) : null,
    })).filter(item => /^[a-zA-Z0-9_-]{11}$/.test(item.media_id)) };
}
function boundedState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.playback_phase !== undefined && !VALID_PHASES.has(value.playback_phase)) return null;
  const state = {};
  for (const name of ["title", "media_id", "mode", "fullscreen_kind", "playback_phase", "audio_observation"]) {
    if (typeof value[name] === "string") state[name] = value[name].slice(0, 180);
  }
  for (const name of ["position_seconds", "duration_seconds", "volume_percent", "rendered_frames"]) {
    if (Number.isFinite(value[name]) && value[name] >= 0) state[name] = Math.min(value[name], 864000);
  }
  if (Number.isFinite(value.av_drift_ms) && Math.abs(value.av_drift_ms) <= 600000) state.av_drift_ms = value.av_drift_ms;
  if (typeof value.paused === "boolean") state.paused = value.paused;
  return state;
}
export function validateMediaCommand(action, args = {}) {
  if (!MUTATIONS.has(action) && !READS.has(action)) fail("invalid_action");
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("invalid_args");
  if (Object.keys(args).some((name) => !["media_id", "position_seconds", "value_percent", "query", "limit"].includes(name))) fail("unknown_argument");
  if (action === "search_media" && (!text(args.query, 120) || args.query.trim().length < 2)) fail("invalid_query");
  if (action === "search_media" && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) fail("invalid_limit");
  if (action !== "search_media" && (args.query !== undefined || args.limit !== undefined)) fail("extraneous_argument");
  if (action === "play_media" && !text(args.media_id, 160)) fail("invalid_media_id");
  if (action === "seek" && (!Number.isFinite(args.position_seconds) || args.position_seconds < 0 || args.position_seconds > 86400)) fail("invalid_position");
  if (action === "set_volume" && (!Number.isFinite(args.value_percent) || args.value_percent < 0 || args.value_percent > 100)) fail("invalid_volume");
  if (action !== "play_media" && args.media_id !== undefined) fail("extraneous_argument");
  if (action !== "seek" && args.position_seconds !== undefined) fail("extraneous_argument");
  if (action !== "set_volume" && args.value_percent !== undefined) fail("extraneous_argument");
  return Object.freeze({ ...args });
}

export class AgentSessionRegistry {
  #sessions = new Map();
  #pending = new Map();
  #completed = new Map();
  #now; #authorizePairing; #ttlMs; #timeoutMs; #maxPending; #rateLimit; #rateWindowMs;
  #maxSessions; #maxCompleted; #commandTtlMs;

  constructor({ authorizePairing = () => false, now = Date.now, ttlMs = 30000,
    timeoutMs = 3000, maxPending = 4, rateLimit = 20, rateWindowMs = 10000,
    commandTtlMs = 60000, maxCompleted = 256, maxSessions = 64 } = {}) {
    if (typeof authorizePairing !== "function" || typeof now !== "function") fail("invalid_configuration");
    this.#authorizePairing = authorizePairing;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#timeoutMs = timeoutMs;
    this.#maxPending = maxPending;
    this.#rateLimit = rateLimit;
    this.#rateWindowMs = rateWindowMs;
    if (![maxSessions,maxCompleted,commandTtlMs].every(Number.isSafeInteger)
        || maxSessions<1 || maxSessions>256 || maxCompleted<1 || maxCompleted>4096
        || commandTtlMs<1 || commandTtlMs>600000) fail("invalid_configuration");
    this.#maxSessions=maxSessions;
    this.#maxCompleted=maxCompleted;
    this.#commandTtlMs=commandTtlMs;
  }
  #pruneCompleted() {
    const at=this.#now();
    for (const [id,seenAt] of this.#completed) if(at-seenAt>=this.#commandTtlMs)
      this.#completed.delete(id);
  }

  register({ principal, pairingProof, label, connectionId, send }) {
    if (!text(principal, 160) || !text(connectionId, 160) || !text(label, 64) || typeof send !== "function") fail("invalid_registration");
    if (this.#authorizePairing({ principal, pairingProof, connectionId }) !== true) fail("unauthorized_pairing");
    this.sweep();
    if(this.#sessions.size>=this.#maxSessions) fail("session_limit");
    const session = {
      id: randomUUID(), principal, connectionId, label, send,
      lastSeenAt: this.#now(), lastState: null, commandTimes: [],
    };
    this.#sessions.set(session.id, session);
    return { device_id: session.id, label };
  }

  #active(deviceId, principal) {
    const session = this.#sessions.get(deviceId);
    if (!session || session.principal !== principal) return null;
    if (this.#now() - session.lastSeenAt > this.#ttlMs) {
      this.disconnect({ deviceId, connectionId: session.connectionId });
      return null;
    }
    return session;
  }

  heartbeat({ principal, deviceId, connectionId, state }) {
    const session = this.#active(deviceId, principal);
    if (!session || session.connectionId !== connectionId) return false;
    session.lastSeenAt = this.#now();
    if (state !== undefined) session.lastState = boundedState(state);
    return true;
  }

  connectionFor(principal, deviceId) {
    const session = this.#active(deviceId, principal);
    return session ? session.connectionId : null;
  }
  notifyDevice(principal, deviceId, frame) {
    const session = this.#active(deviceId, principal);
    if (!session) return false;
    try { return session.send(frame) !== false; } catch { return false; }
  }
  list(principal) {
    if (!text(principal, 160)) fail("invalid_principal");
    return [...this.#sessions.values()].filter((session) => this.#active(session.id, principal))
      .map((session) => ({
        device_id: session.id, label: session.label, online: true,
        last_seen_at: session.lastSeenAt, state: session.lastState,
      }));
  }

  async dispatch({ principal, deviceId, action, args = {}, commandId = randomUUID() }) {
    const validated = validateMediaCommand(action, args);
    if (!text(deviceId, 80) || !text(principal, 160)) fail("invalid_target");
    if(!text(commandId,160)) fail("invalid_command_id");
    this.#pruneCompleted();
    if(this.#pending.has(commandId) || this.#completed.has(commandId))
      return {status:"duplicate_command_id",device_id:deviceId,command_id:commandId};
    const session = this.#active(deviceId, principal);
    if (!session) return { status: "offline", device_id: deviceId, command_id: commandId };
    if(this.#pending.size+this.#completed.size>=this.#maxCompleted)
      return {status:"busy",device_id:deviceId,command_id:commandId};
    const at = this.#now();
    session.commandTimes = session.commandTimes.filter((time) => at - time < this.#rateWindowMs);
    if (session.commandTimes.length >= this.#rateLimit) return { status: "rate_limited", device_id: deviceId };
    if ([...this.#pending.values()].filter((p) => p.session === session).length >= this.#maxPending) return { status: "busy", device_id: deviceId };
    session.commandTimes.push(at);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#finish(commandId,{ status:"timeout_uncertain",device_id:deviceId,command_id:commandId });
      }, this.#timeoutMs);
      // Keep a pending command timeout referenced until it resolves; otherwise an
      // isolated MCP call/test can be abandoned when no other event-loop handles exist.
      this.#pending.set(commandId, { session, action, resolve, timer });
      try {
        const sent = session.send({
          kind: "command", command_id: commandId, action, args: validated, device_id: deviceId,
        });
        if (sent === false) this.#finish(commandId, { status: "offline", device_id: deviceId, command_id: commandId });
      } catch {
        this.#finish(commandId, { status: "offline", device_id: deviceId, command_id: commandId });
      }
    });
  }

  #finish(commandId, outcome) {
    const pending = this.#pending.get(commandId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(commandId);
    this.#pruneCompleted();
    this.#completed.set(commandId,this.#now());
    pending.resolve(outcome);
    return true;
  }

  acknowledge({ principal, deviceId, connectionId, commandId, status, state, result, error }) {
    const pending = this.#pending.get(commandId);
    const session = this.#active(deviceId, principal);
    if (!pending || !session || pending.session !== session || session.connectionId !== connectionId) return false;
    if (!VALID_STATUSES.has(status)) return false;
    const confirmedState = boundedState(state);
    if (state !== undefined && confirmedState===null) return false;
    if (confirmedState) session.lastState = confirmedState;
    return this.#finish(commandId, {
      status, device_id: deviceId, command_id: commandId,
      state: confirmedState, ...(status === "completed" && result && pending.action === "search_media" ? { result: boundedResult(result) } : {}), ...(typeof error === "string" && status !== "completed" ? { error: error.slice(0, 160) } : {}),
    });
  }

  disconnect({ deviceId, connectionId }) {
    const session = this.#sessions.get(deviceId);
    if (!session || session.connectionId !== connectionId) return false;
    this.#sessions.delete(deviceId);
    for (const [id, pending] of this.#pending) {
      if (pending.session === session) this.#finish(id, { status: "offline", device_id: deviceId, command_id: id });
    }
    return true;
  }

  sweep() {
    for (const session of this.#sessions.values()) this.#active(session.id, session.principal);
    return this.#sessions.size;
  }
}
