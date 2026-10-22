import { randomUUID } from "node:crypto";

const ACTIONS = new Set(["list_devices", "get_player_state", "search_media", "play_media", "pause", "resume", "stop"]);
const VALID_STATUSES = new Set(["completed", "failed", "unsupported", "needs_user_gesture", "accepted", "playing", "paused", "buffering"]);
const VALID_PHASES = new Set(["idle", "buffering", "playing", "paused", "failed", "needs_user_gesture"]);
const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
export function validateMediaCommand(action, args = {}) {
  if (!ACTIONS.has(action) || action === "list_devices") fail("invalid_action");
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("invalid_args");
  if (Object.keys(args).some((key) => !["media_id", "query", "limit"].includes(key))) fail("unknown_argument");
  if (action === "search_media" && (!text(args.query, 120) || args.query.trim().length < 2)) fail("invalid_query");
  if (action === "search_media" && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) fail("invalid_limit");
  if (action !== "search_media" && (args.query !== undefined || args.limit !== undefined)) fail("extraneous_argument");
  if (action === "play_media" && !text(args.media_id, 160)) fail("invalid_media_id");
  if (action !== "play_media" && args.media_id !== undefined) fail("extraneous_argument");
  return Object.freeze({ ...args });
}
function boundedState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = {};
  for (const key of ["title", "media_id", "mode", "playback_phase", "observed_at"]) if (typeof value[key] === "string") state[key] = value[key].slice(0, 180);
  for (const key of ["position_seconds", "duration_seconds", "rendered_frames"]) if (Number.isFinite(value[key]) && value[key] >= 0) state[key] = Math.min(value[key], 864000);
  if (typeof value.paused === "boolean") state.paused = value.paused;
  if (value.playback_phase !== undefined && (!VALID_PHASES.has(value.playback_phase) || typeof value.playback_phase !== "string")) return null;
  return state;
}

export class AgentSessionRegistry {
  #sessions = new Map(); #pending = new Map(); #completed = new Map();
  constructor({ authorizePairing = () => false, now = Date.now, ttlMs = 30000, timeoutMs = 3000, commandTtlMs = 60000, maxPending = 4, maxCompleted = 256, maxSessions = 64 } = {}) { this.authorizePairing = authorizePairing; this.now = now; this.ttlMs = ttlMs; this.timeoutMs = timeoutMs; this.commandTtlMs = commandTtlMs; this.maxPending = maxPending; this.maxCompleted = maxCompleted; this.maxSessions = maxSessions; }
  register({ principal, pairingProof, label, connectionId, send }) {
    if (!text(principal, 160) || !text(label, 64) || !text(connectionId, 160) || typeof send !== "function") fail("invalid_registration");
    if (this.authorizePairing({ principal, pairingProof, connectionId }) !== true) fail("unauthorized_pairing");
    if (this.#sessions.size >= this.maxSessions) fail("session_limit");
    const session = { id: randomUUID(), principal, label, connectionId, send, lastSeenAt: this.now(), lastState: null };
    this.#sessions.set(session.id, session); return { device_id: session.id, label };
  }
  #active(deviceId, principal) { const s = this.#sessions.get(deviceId); if (!s || s.principal !== principal) return null; if (this.now() - s.lastSeenAt > this.ttlMs) { this.disconnect({ deviceId, connectionId: s.connectionId }); return null; } return s; }
  heartbeat({ principal, deviceId, connectionId, state }) { const s = this.#active(deviceId, principal); if (!s || s.connectionId !== connectionId) return false; s.lastSeenAt = this.now(); if (state !== undefined) s.lastState = boundedState(state); return true; }
  list(principal) { return [...this.#sessions.values()].filter((s) => this.#active(s.id, principal)).map((s) => ({ device_id: s.id, label: s.label, online: true, last_seen_at: s.lastSeenAt, state: s.lastState })); }
  async dispatch({ principal, deviceId, action, args = {}, commandId = randomUUID() }) {
    const validated = validateMediaCommand(action, args); const s = this.#active(deviceId, principal); if (!s) return { status: "offline", device_id: deviceId, command_id: commandId };
    if (!text(commandId, 160)) fail("invalid_command_id");
    this.#expireCommands();
    if (this.#completed.has(commandId) || this.#pending.has(commandId)) return { status: "duplicate_command_id", device_id: deviceId, command_id: commandId };
    let pendingForSession = 0; for (const pending of this.#pending.values()) if (pending.s === s) pendingForSession += 1;
    if (pendingForSession >= this.maxPending || this.#pending.size + this.#completed.size >= this.maxCompleted) return { status: "busy", device_id: deviceId, command_id: commandId };
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#pending.delete(commandId); this.#remember(commandId, { status: "timeout_uncertain", device_id: deviceId, command_id: commandId }); resolve({ status: "timeout_uncertain", device_id: deviceId, command_id: commandId }); }, this.timeoutMs);
      this.#pending.set(commandId, { s, resolve, timer });
      try { if (s.send({ kind: "command", command_id: commandId, device_id: deviceId, action, args: validated }) === false) this.#finish(commandId, { status: "offline", device_id: deviceId, command_id: commandId }); } catch { this.#finish(commandId, { status: "offline", device_id: deviceId, command_id: commandId }); }
    });
  }
  #remember(id, outcome) { this.#completed.set(id, { outcome, expiresAt: this.now() + this.commandTtlMs }); }
  #finish(id, outcome) { const p = this.#pending.get(id); if (!p) return false; clearTimeout(p.timer); this.#pending.delete(id); this.#remember(id, outcome); p.resolve(outcome); return true; }
  #expireCommands() { const now = this.now(); for (const [id, record] of this.#completed) if (record.expiresAt <= now) this.#completed.delete(id); }
  acknowledge({ principal, deviceId, connectionId, commandId, status, state, result, error }) { const p = this.#pending.get(commandId); const s = this.#active(deviceId, principal); if (!p || !s || p.s !== s || s.connectionId !== connectionId || !VALID_STATUSES.has(status)) return false; if (state?.playback_phase !== undefined && !VALID_PHASES.has(state.playback_phase)) return false; const clean = boundedState(state); if (clean) s.lastState = clean; return this.#finish(commandId, { status, device_id: deviceId, command_id: commandId, ...(clean ? { state: clean } : {}), ...(result && status === "completed" ? { result } : {}), ...(error && status !== "completed" ? { error: String(error).slice(0, 160) } : {}) }); }
  disconnect({ deviceId, connectionId }) { const s = this.#sessions.get(deviceId); if (!s || s.connectionId !== connectionId) return false; this.#sessions.delete(deviceId); for (const [id, p] of this.#pending) if (p.s === s) this.#finish(id, { status: "offline", device_id: deviceId, command_id: id }); return true; }
  sweep() { for (const s of this.#sessions.values()) this.#active(s.id, s.principal); this.#expireCommands(); return this.#sessions.size; }
}
