import { randomBytes } from "node:crypto";

const ORIGIN = "https://stream.ameshalex.com";
const SCOPE_FIELDS = ["subject", "controllerId", "deviceKey", "connectionId", "requestId", "origin"];
const MEDIA_ID = /^[A-Za-z0-9_-]{11}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,96}$/;
const TOKEN_ATTEMPTS = 8;

function fail(code) { throw Object.assign(new Error(code), { code }); }

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected, code) {
  if (!plainRecord(value)) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
}

function boundedText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim().length > 0;
}

function validateScope(value) {
  exactKeys(value, SCOPE_FIELDS, "invalid_scope");
  const maxima = { subject: 160, controllerId: 128, deviceKey: 160, connectionId: 160, requestId: 160 };
  for (const [field, max] of Object.entries(maxima)) {
    if (!boundedText(value[field], max)) fail("invalid_scope");
  }
  if (value.origin !== ORIGIN) fail("invalid_scope");
  return Object.fromEntries(SCOPE_FIELDS.map((field) => [field, value[field]]));
}

function validateResults(value, maxResults) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxResults) fail("invalid_results");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys[ownKeys.length - 1] !== "length") fail("invalid_results");
  const dense = [];
  for (let i = 0; i < value.length; i += 1) {
    if (ownKeys[i] !== String(i)) fail("invalid_results");
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("invalid_results");
    dense.push(descriptor.value);
  }
  return dense.map((item) => {
    exactKeys(item, ["mediaId", "title"], "invalid_result");
    if (typeof item.mediaId !== "string" || !MEDIA_ID.test(item.mediaId)) fail("invalid_media_id");
    if (!boundedText(item.title, 240)) fail("invalid_title");
    return { mediaId: item.mediaId, title: item.title };
  });
}

function authTime(value, now) {
  if (!Number.isSafeInteger(value) || value <= now) fail("authorization_expired");
  return value;
}

export function createTeslaMonCandidateRegistry({
  now = Date.now,
  tokenGenerator = () => randomBytes(32).toString("base64url"),
  ttlMs = 30_000,
  maxEntries = 500,
  maxResults = 10,
} = {}) {
  if (typeof now !== "function" || typeof tokenGenerator !== "function") fail("invalid_registry_options");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30_000 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000 ||
      !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) fail("invalid_registry_options");

  const entries = new Map();
  let lastTime = -1;
  function currentTime() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time < lastTime) fail("invalid_clock");
    lastTime = time;
    return time;
  }
  function purge(at) {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= at || entry.authExpiresAt <= at) entries.delete(token);
    }
  }

  return Object.freeze({
    mint(input = {}) {
      exactKeys(input, ["scope", "results", "authExpiresAt"], "invalid_mint_request");
      const { scope: rawScope, results: rawResults, authExpiresAt: rawAuthExpiresAt } = input;
      const at = currentTime();
      purge(at);
      const scope = validateScope(rawScope);
      const results = validateResults(rawResults, maxResults);
      const authExpiresAt = authTime(rawAuthExpiresAt, at);
      if (entries.size + results.length > maxEntries) fail("capacity_exceeded");
      const ttlExpiresAt = at + ttlMs;
      if (!Number.isSafeInteger(ttlExpiresAt)) fail("invalid_clock");
      const expiresAt = Math.min(ttlExpiresAt, authExpiresAt);
      const minted = [];
      const reserved = new Set();
      for (const result of results) {
        let token;
        for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
          const candidate = tokenGenerator();
          if (typeof candidate !== "string" || !TOKEN.test(candidate)) fail("invalid_generated_token");
          if (!entries.has(candidate) && !reserved.has(candidate)) { token = candidate; break; }
        }
        if (!token) fail("token_collision");
        reserved.add(token);
        minted.push({ token, ...result, expiresAt });
      }
      for (let i = 0; i < minted.length; i += 1) {
        const { token, mediaId, title } = minted[i];
        entries.set(token, { scope: { ...scope }, mediaId, title, expiresAt, authExpiresAt });
      }
      return minted.map((candidate) => ({ ...candidate }));
    },

    resolve(input = {}) {
      exactKeys(input, ["token", "scope"], "invalid_resolve_request");
      const { token, scope: rawScope } = input;
      const at = currentTime();
      purge(at);
      if (typeof token !== "string" || !TOKEN.test(token)) return null;
      const scope = validateScope(rawScope);
      const entry = entries.get(token);
      if (!entry || !SCOPE_FIELDS.every((field) => entry.scope[field] === scope[field])) return null;
      return { mediaId: entry.mediaId, title: entry.title, expiresAt: entry.expiresAt };
    },

    revoke(input = {}) {
      exactKeys(input, ["token", "scope"], "invalid_revoke_request");
      const { token, scope: rawScope } = input;
      const at = currentTime();
      purge(at);
      if (typeof token !== "string" || !TOKEN.test(token)) return false;
      const scope = validateScope(rawScope);
      const entry = entries.get(token);
      if (!entry || !SCOPE_FIELDS.every((field) => entry.scope[field] === scope[field])) return false;
      return entries.delete(token);
    },

    revokeScope(input = {}) {
      exactKeys(input, ["scope"], "invalid_revoke_request");
      const { scope: rawScope } = input;
      const at = currentTime();
      purge(at);
      const scope = validateScope(rawScope);
      let revoked = 0;
      for (const [token, entry] of entries) {
        if (SCOPE_FIELDS.every((field) => entry.scope[field] === scope[field])) {
          entries.delete(token);
          revoked += 1;
        }
      }
      return revoked;
    },

    size() {
      const at = currentTime();
      purge(at);
      return entries.size;
    },
  });
}
