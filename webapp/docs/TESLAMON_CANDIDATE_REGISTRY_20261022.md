# TeslaMon TM-103: scoped search candidate registry

## Ownership and baseline

This isolated branch starts from consolidated main at
`1703926f2d54adb403dd38daef503dcd31a1f1b0`. Existing work was reconciled before
choosing this task: S0 contract PR #77, capture PR #78, and private MCP fixture
PR #79. The MCP fixture explicitly lacked a candidate registry. This lane owns
only its new registry module, tests and this document. Runtime, private MCP,
authentication, relay, capture and player files remain with their existing owners.

Branch: https://github.com/ameshalexk/yt-streamer-webapp/tree/feature/teslamon-candidate-registry-20261022

## Trust boundary

The registry is server-internal and has no network listener or tool registration.
The future coordinator must derive identity and selected-tab authority from the
verified authenticated relay; never construct trusted scope from model arguments,
transcripts or arbitrary browser fields. Only validated results of an authorized
search can enter the registry. A valid-looking media ID alone does not prove a
search provider returned it.

Tokens are opaque, short-lived references to stored YouTube media IDs and inert
titles. They bind origin, subject, controller, target device, connection generation
and request. Expiry is bounded by the registry TTL and site authentication expiry.
Wrong-scope access fails closed; title text never becomes executable instructions.
No arbitrary playback URL is accepted.

## Integration remaining

The future MCP/relay owner must call mint after search, resolve the candidate
against the same trusted scope immediately before dispatch, and verify live
consent/authentication/connection generation again. Scope revocation must occur
on target change, request cancellation and session revocation. Resolve is a lookup,
not a playback action, command deduplication ledger, or one-use authorization.
It does not replace TM-104's cancellation and idempotency guarantees.

Nothing is mounted in the site, and no player control, STT, microphone or model
call is included. No server authentication or runtime confinement is proven by
these isolated tests. TM-103 stays partial until the actual search/play transaction
and fresh player readback pass. Existing overall story counts are not advanced.

## Verification and rollback

Run from repo root:

```
node --check webapp/src/lib/teslamon-candidate-registry.js
node --test webapp/test/teslamon-candidate-registry.test.mjs
```

Run `npm run check` from `webapp/` for existing source syntax checks.
Local unit results are separate from Both platforms passed CI, amd64/aarch64
container checks, deployment and physical acceptance. No layout changed, so no
viewport/browser/device acceptance is claimed. iPhone-first Classic/New checks
remain mandatory when this feature is integrated into the page.

Rollback removes this isolated addition by reverting its commit. No runtime
configuration, stored media, history or production data requires restoration.

## API for the bridge owner

`createTeslaMonCandidateRegistry({ now, tokenGenerator, ttlMs, maxEntries,
maxResults })` creates an in-memory registry. Defaults use cryptographic random
tokens and a 30-second TTL. Test-only dependency injection is trusted server code.

- `mint({scope, results, authExpiresAt})`: atomically creates a batch of candidates.
  Results have exactly `{mediaId,title}`; candidates return token, media ID, title,
  and expiry. A full registry rejects new batches instead of evicting live tokens.
- `resolve({token,scope})`: returns a detached result copy or null for an unknown,
  expired or wrong-scope token. Repeated lookup is intentionally non-consuming.
- `revoke({token,scope})`: removes one matching token.
- `revokeScope({scope})`: removes every token in that exact request scope.
- `size()`: purges expiry and reports stored candidates.

Scope contains exactly `origin`, `subject`, `controllerId`, `deviceKey`,
`connectionId`, and `requestId`. Only the Mac stream origin is permitted in this
pilot; HA requires its separately approved cross-host route. Coordinator code
must retain old request scopes to revoke all affected requests on target/session
changes. Do not expose these server methods directly to model input.

MIME/audio, credentials and private playback history are outside this module.
The implementation accepts trusted search-result metadata only in memory; do not
log it or publish private result lists as verification evidence.

Local verification (2026-10-22): **8/8** focused tests pass; new-module syntax,
existing `npm run check`, and staged whitespace checks pass. Independent review
identified sparse results bypassing validation; dense data-only arrays and
regression cases now reject sparse/accessor/extra-property arrays. No live search
or player interaction was used.
