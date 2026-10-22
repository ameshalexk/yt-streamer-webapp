# TeslaMon — S1 TM-104 crash-conservative mutation journal

Date: 2026-10-22. **Isolated fixture only. Not wired to any live media, backend, Codex process or production site.**

## Source, ownership and dependency

- Epic: [TeslaMon #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26).
- Branch: `feature/teslamon-s1-command-ledger-20261022`, stacked on `feature/teslamon-s1-exact-relay-20261022` (PR #82), itself stacked on PR #81 / #79 / #77.
- Separate independent capture PR #78 and parallel candidate-registry worktree were not altered.
- Own files: `webapp/src/lib/teslamon-command-ledger.js`, `webapp/test/teslamon-command-ledger.test.mjs`, and this document. No existing shared relay/server/app/Cloudflare/playback files changed.

## Intended security property

`openTeslaMonCommandLedger({dir,now,maxCommands,timeoutMs})` is a *server-only* journal for mutations, not a tool exposed to a model. The Mac integrator must supply a **private, owner-only (0700)** runtime directory; journal and lock are owner-only (0600). The directory is validated for ownership/mode. The open file uses `O_NOFOLLOW` to reject symlink substitution at open. The single-process lock uses `wx` and fails closed on a stale lock instead of forcibly disconnecting another active job.

Each request must first pass normal server-side authentication, explicit selected-tab/generation checks, argument validation and a short deadline. The ledger alone is not an authorization layer and does not verify a device. The caller supplies a server-minted UUID command ID, action, bound target and expiry. The journal stores **only** command UUID, SHA-256 fingerprint of action/binding/arguments, timestamp and coarse status — no raw tokens, titles, media URLs, user labels, recordings or credentials.

Before execute, the journal writes a `start` record and **fsyncs it**. It reserves the command ID before dispatch; a duplicate UUID with the same fingerprint returns `duplicate_suppressed`, never resending, including after reopening the journal. Same ID with changed target/args is rejected. Reservation check + durable append + insertion are serialized as one unit to prevent a concurrent double-send race across target generations. Mutations on the same selected target cannot overlap. The journal records a final coarse outcome after dispatch and fsyncs again.

A timeout, post-dispatch cancellation, thrown transport error, or journal finalization failure is **uncertain**, never automatically retried. Work sent before timeout may still complete afterward; returning uncertain does not cancel the browser's ongoing media action. Pre-dispatch cancellation prevents effect. A killed process may leave a durable `start` without `finish`: it remains uncertain on restart and will not be replayed by the same ID.

The journal is append-only with a capacity limit, not silently pruned. When capacity is reached, new requests fail closed; a later **scoped, operator-reviewed** compaction/rotation procedure is required. Do not delete a potentially active ledger or stale lock automatically. `close()` refuses while commands are active, checks lock identity, closes descriptors and releases only the lock it owns.

## Important limits

- This code is **not integrated** into the existing `AgentSessionRegistry`, candidate service, MCP or Codex coordinator. TM-104's actual cross-layer cancellation and replay behavior remains unaccepted until integration.
- fsync and a single-owner lock are a strong development baseline, but **no claim of durable exactly-once execution in every OS crash, filesystem/power-loss or multi-host scenario** is made. Power-loss directory-entry durability and distributed coordination need separate evidence if required.
- Lock recovery after a crashed process requires an operator to establish the old process is gone and examine journal data. No automatic unlink on startup.
- Never recreate a fresh command ID when uncertain for the same user mutation without reconciling actual player state and target generation.
- The simulator reports no real media frame/audio evidence. Background work can finish after timeout; UI must communicate this honestly.
- No global Codex tool confinement, real microphone/STT, Cloudflare Access verification, Mac/HA coordinator network route, iPhone/Tesla acceptance, or production release.

## Tests actually run

From `webapp/`:
- `node --test test/teslamon-contract.test.mjs test/teslamon-private-mcp.test.mjs test/teslamon-candidates.test.mjs test/teslamon-selected-relay.test.mjs test/teslamon-command-ledger.test.mjs`: **63/63 passed** (15 new ledger + 48 previous isolated fixtures).
- `npm run check`: **passed**.
- `git diff --check`: **passed**.
- New tests cover fsync-before-dispatch evidence, no plaintext private data, same ID after reopen/restart, ID tampering, concurrent same ID across tabs, serialization by target, timeout uncertainty, cancellations, expired request, simultaneous owner lock, stale lock recovery blocking, corrupt journal refusing startup, world-readable file rejection, capacity and close while active.
- No full current app regression or Both-platform CI was run here (new clean worktree lacks dependencies). No live browser or playback/media commands were executed.

## Resume plan

1. Review, harden and merge the **isolated** S0/S1 building blocks into one candidate branch after resolving parallel candidate-registry ownership. Do not blindly cherry-pick conflicting implementations.
2. Integration owner adds the trusted controller/browser/explicit-selection callbacks *inside* the existing signed Access/WS relay, proves actual two-tab and reconnect behavior without disturbing the existing legacy selected controls.
3. Wire `createTeslaMonCandidateService` and this mutation ledger as private dependencies of the six-tool MCP. Integrator owns shared server/player changes; no public playback endpoint or second sign-in.
4. Prove TM-003 Codex tool confinement and TM-002 mic/STT route. Until then, model/voice execution remains disabled and unclaimed.
5. Complete fullscreen, pet UI, responsive widths and both-host CI; then physical iPhone/parked Tesla and approved release.

No merge or production deployment is authorized by this fixture PR. Rollback: drop/revert its isolated feature branch; deployed YT Streamer is unchanged.
