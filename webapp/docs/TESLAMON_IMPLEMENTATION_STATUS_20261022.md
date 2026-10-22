# TeslaMon implementation and acceptance status

Continuation based on PR #88 (`0b15360`). The earlier 55% estimate is historical and is not a release score. This tracker uses concrete states rather than assigning source-code credit to physical acceptance or deployment stories. No 100% claim is made.

## Current backlog evidence

| Story | Source status | Remaining evidence / blocker |
|---|---|---|
| TM-001 Baseline and ownership | Implemented | Draft stack remains unmerged; unrelated staging lane preserved |
| TM-002 Input/speech feasibility | Partial | Real input-device path and configured local STT deferred to owner |
| TM-003 Codex confinement | Blocked | Installed App Server schema/docs do not establish removal of all built-ins |
| TM-004 Contracts | Implemented | Live acceptance separate |
| TM-101 Exact playback service | Implemented | Signed-fixture HTTP/WS target and decoy tests; live site separate |
| TM-102 Private six-tool MCP | Implemented | Product Codex activation remains blocked by TM-003 |
| TM-103 Search/play transaction | Implemented | Fresh same-media readback; independent fullscreen result; real playback separate |
| TM-104 Cancellation/dedup | Implemented | Abort propagated HTTP→coordinator→candidate→relay/ledger; uncertain mutation quarantined |
| TM-201 Persistent runtime lifecycle | Partial | Transport-injected driver fixture-tested; real startup deliberately unavailable until TM-003 |
| TM-202 Ingress/targeting | Partial | Existing signed browser controls implemented; real Codex integration blocked |
| TM-203 Natural-language runtime | Partial | Safe grammar and opt-in parser exist; actual Codex conversation blocked |
| TM-301 Pet shell | Implemented source | Reset, keyboard, cancel, 44px controls, safe visual viewport; Chrome matrix blocked/unaccepted |
| TM-302 Capture lifecycle | Implemented | Capture refusal fix integrated; actual device permission/voice deferred |
| TM-303 STT backend | Implemented source | Private temp files, subprocess deadlines/abort, cleanup; actual model/audio not exercised |
| TM-304 Spoken end-to-end runtime | Partial | Capture→STT→safe parser wired; actual Codex/physical speech proof missing |
| TM-401 Fullscreen | Implemented | Play attempts once; native/in_page/none/gesture outcomes independent of playback; device proof separate |
| TM-402 Mobile regressions | Blocked | Signed-profile Chrome fixture navigation blocked by client; no viewport pass claimed |
| TM-403 Failure matrix | Partial | Offline auth/reconnect/cancel/limits/injection coverage; real runtime/device failures unverified |
| TM-404 Review/candidate packaging | Partial | Review findings fixed; current exact-head CI/package evidence required |
| TM-501 Real devices | Deferred | Owner requested to handle physical testing |
| TM-502 Release dossier | Partial | Source-only package can be prepared after immutable commit; live backups/jobs deferred until approved release |
| TM-503 Deployment | Not authorized | Separate scoped approval after concrete release gates pass |

## New completion work

- Safe-area/visualViewport pet placement, keyboard move/reset, >=44px handle, accessible Cancel, container-fullscreen placement. Video-only native fullscreen cannot render DOM overlays; no always-visible pet claim.
- Pending input is tracked per request/session, so a late canceled request cannot disable Cancel for newer work. Cancel aborts pre-dispatch inputs while leaving already-sent commands unreplayed and honestly uncertain.
- HTTP response abandonment/deadlines propagate abort to model parsing, STT and selected-tab command chains. Authentication-bound request token buckets cap each controller (30 burst, one token per 2 seconds; bounded 256 controller entries, no background polling).
- Search cancellation prevents later play. Post-mutation cancellation stays uncertain and quarantines the journal. Successful verified play makes one fullscreen attempt, retaining playback success if fullscreen fails.
- Bounded title/media ID/observation time/audio-element observation pass through private MCP and HTTP. Element activity never claims audible speaker proof.
- STT abort waits for actual child close (with bounded TERM→KILL escalation) before deleting temporary audio.

## Browser evidence and limits

The AMESH Chrome profile was discovered through the browser extension. Native profile-picture/account verification was unavailable while the Mac was locked. Chrome refused the isolated loopback fixture with `ERR_BLOCKED_BY_CLIENT`. No workaround or replacement browser/profile was used. The required 320/375/390/430, iPad and 844x390 landscape matrix in Classic/New is therefore **not passed**. `npm run preview:teslamon` starts only a loopback synthetic-data fixture for that next check; it never authenticates or controls production.

## Rollback

Revert this continuation's commits; TeslaMon stays default-off. No real microphone, model, production configuration, security policy, service, command journal or deployment state was changed.

## Final local validation of this continuation

- **691/691 full repository tests passed**, zero failures, on local macOS.
- Runtime protocol **20/20** fixture tests; pet positioning/cancel/speech/fullscreen lifecycle **24/24**; actual adapter audio-state VM tests, HTTP request lifecycle, controller rate limits, STT child-close cleanup and candidate/fullscreen metadata regressions are included in the full total.
- `npm run check` and `git diff --check` passed. Loopback fixture HTML/module/API smoke passed; this is not Chrome rendering evidence.
- Independent review findings in Cancel tracking and runtime pending-start invalidation were fixed and regression-covered. Final runtime review found no remaining material issue in the reviewed paths.
- The required `mobile-player-browser-check.mjs` was not launched with its default fresh profile because the owner requires the existing signed-in Chrome profile. That profile's extension navigation to loopback was blocked. No phone/browser success is inferred.
- Product Codex activation stays disabled with `runtime_confinement_unverified`; the injected driver does not spawn a model/process. Owner decision about an explicitly different closed-allowlist API runtime is pending.
- Previous PR #88 passed both OS regressions, both container architectures, bundles and Both platforms passed at `0b15360`; this does not validate the new continuation.
