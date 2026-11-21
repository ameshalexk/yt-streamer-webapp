import test from "node:test";
import assert from "node:assert/strict";
import { createTeslaMonCandidateRegistry } from "../src/lib/teslamon-candidate-registry.js";

const baseScope = () => ({
  subject: "owner-1", controllerId: "tesla-1", deviceKey: "key-1",
  connectionId: "connection-1", requestId: "request-1", origin: "https://stream.ameshalex.com",
});
const results = () => [
  { mediaId: "abcdefghijk", title: "One" },
  { mediaId: "lmnopqrstuv", title: "Two" },
];

function fixture(options = {}) {
  let time = 1_000;
  const registry = createTeslaMonCandidateRegistry({ now: () => time, ...options });
  return { registry, advance: (ms) => { time += ms; }, setTime: (value) => { time = value; } };
}

test("mints unique opaque tokens and resolves copies only for the complete trusted scope", () => {
  const { registry } = fixture();
  const scope = baseScope();
  const minted = registry.mint({ scope, results: results(), authExpiresAt: 100_000 });
  assert.equal(minted.length, 2);
  assert.notEqual(minted[0].token, minted[1].token);
  for (const item of minted) assert.match(item.token, /^[A-Za-z0-9_-]{16,96}$/);

  const resolved = registry.resolve({ token: minted[0].token, scope });
  assert.deepEqual(resolved, { mediaId: "abcdefghijk", title: "One", expiresAt: 31_000 });
  resolved.title = "changed";
  minted[0].title = "changed";
  assert.equal(registry.resolve({ token: minted[0].token, scope }).title, "One");

  for (const field of ["subject", "controllerId", "deviceKey", "connectionId", "requestId"]) {
    const wrongScope = { ...scope, [field]: `wrong-${field}` };
    assert.equal(registry.resolve({ token: minted[0].token, scope: wrongScope }), null, field);
  }
  assert.throws(() => registry.resolve({ token: minted[0].token, scope: { ...scope, origin: "https://attacker.example" } }), /invalid_scope/);
  assert.equal(registry.size(), 2);
});

test("expires at the earlier of the registry TTL and authorization expiry", () => {
  const x = fixture({ ttlMs: 25 });
  const [short] = x.registry.mint({ scope: baseScope(), results: results().slice(0, 1), authExpiresAt: 10_000 });
  x.advance(25);
  assert.equal(x.registry.resolve({ token: short.token, scope: baseScope() }), null);
  assert.equal(x.registry.size(), 0);

  const y = fixture({ ttlMs: 30_000 });
  const [authBound] = y.registry.mint({ scope: baseScope(), results: results().slice(0, 1), authExpiresAt: 1_010 });
  y.advance(10);
  assert.equal(y.registry.resolve({ token: authBound.token, scope: baseScope() }), null);
});

test("rejects invalid media, URLs, extra fields, and invalid scope without creating entries", () => {
  const { registry } = fixture();
  const scope = baseScope();
  const mint = (candidateResults, candidateScope = scope) => registry.mint({
    scope: candidateScope, results: candidateResults, authExpiresAt: 5_000,
  });
  assert.throws(() => mint([{ mediaId: "https://youtube.com/watch?v=abcdefghijk", title: "x" }]), /invalid_media_id/);
  assert.throws(() => mint([{ mediaId: "abcdefghijk", title: "x", url: "https://evil.example" }]), /invalid_result/);
  assert.throws(() => mint([{ mediaId: "abcdefghijk", title: "x" }], { ...scope, model: "authority" }), /invalid_scope/);
  assert.throws(() => mint([{ mediaId: "abcdefghijk", title: "   " }]), /invalid_title/);
  const sparse = new Array(1);
  assert.throws(() => mint(sparse), /invalid_results/);
  const accessorResults = [];
  Object.defineProperty(accessorResults, "0", { enumerable: true, get: () => ({ mediaId: "abcdefghijk", title: "x" }) });
  accessorResults.length = 1;
  assert.throws(() => mint(accessorResults), /invalid_results/);
  const extraArrayProperty = [{ mediaId: "abcdefghijk", title: "x" }];
  extraArrayProperty.extra = true;
  assert.throws(() => mint(extraArrayProperty), /invalid_results/);
  assert.throws(() => registry.mint({ scope, results: results(), authExpiresAt: 5_000, extra: true }), /invalid_mint_request/);
  const symbolRequest = { token: "A".repeat(20), scope };
  symbolRequest[Symbol("extra")] = true;
  assert.throws(() => registry.resolve(symbolRequest), /invalid_resolve_request/);
  assert.equal(registry.size(), 0);
});

test("validates the whole batch before minting and fails closed on capacity", () => {
  const x = fixture({ maxEntries: 2 });
  const scope = baseScope();
  assert.throws(() => x.registry.mint({
    scope, results: [{ mediaId: "abcdefghijk", title: "ok" }, { mediaId: "bad", title: "no" }], authExpiresAt: 5_000,
  }), /invalid_media_id/);
  assert.equal(x.registry.size(), 0);
  x.registry.mint({ scope, results: results(), authExpiresAt: 5_000 });
  assert.throws(() => x.registry.mint({ scope, results: [{ mediaId: "abcdefghijk", title: "third" }], authExpiresAt: 5_000 }), /capacity_exceeded/);
  assert.equal(x.registry.size(), 2);
});

test("revokes one token or every token in an exact trusted scope", () => {
  const { registry } = fixture();
  const scope = baseScope();
  const minted = registry.mint({ scope, results: results(), authExpiresAt: 5_000 });
  assert.equal(registry.revoke({ token: minted[0].token, scope: { ...scope, connectionId: "wrong" } }), false);
  assert.equal(registry.revoke({ token: minted[0].token, scope }), true);
  assert.equal(registry.resolve({ token: minted[0].token, scope }), null);
  assert.equal(registry.revokeScope({ scope }), 1);
  assert.equal(registry.size(), 0);
});

test("retries token collisions a bounded number of times and does not partially commit", () => {
  let generated = 0;
  const { registry } = fixture({ tokenGenerator: () => { generated += 1; return "A".repeat(20); } });
  const scope = baseScope();
  assert.throws(() => registry.mint({ scope, results: results(), authExpiresAt: 5_000 }), /token_collision/);
  assert.equal(generated, 1 + 8);
  assert.equal(registry.size(), 0);
});

test("rejects a clock that moves backward", () => {
  const x = fixture();
  const [candidate] = x.registry.mint({ scope: baseScope(), results: results().slice(0, 1), authExpiresAt: 5_000 });
  x.setTime(999);
  assert.throws(() => x.registry.resolve({ token: candidate.token, scope: baseScope() }), /invalid_clock/);
});

test("bounds configured capacity and rejects negative clocks", () => {
  assert.throws(() => createTeslaMonCandidateRegistry({ maxEntries: 10_001 }), /invalid_registry_options/);
  const x = fixture();
  x.setTime(-1);
  assert.throws(() => x.registry.size(), /invalid_clock/);
});
