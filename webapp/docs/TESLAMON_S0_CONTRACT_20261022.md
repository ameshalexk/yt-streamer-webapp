# TeslaMon S0 — baseline and draft interface contract

Date: 2026-10-22. State: isolated feature branch; **no production integration, service, microphone capture, Codex model session, or deployment**. This is the YT Streamer pet, not vehicle control.

## Verified source baseline (TM-001)

| Item | Observed | Limit |
| --- | --- | --- |
| Repository | `ameshalexk/yt-streamer-webapp` | Existing shared Mac/HA app |
| Initial S0 base | `origin/main` at `1703926f2d54adb403dd38daef503dcd31a1f1b0` | Clean isolated worktree; may advance before integration |
| Feature branch | `feature/teslamon-s0-contract-20261022` | Not merged, not deployed |
| Auth PR #75 | Open/unmerged at S0 inspection | Do not modify/duplicate; real sign-in acceptance remains gated |
| Existing adapter | `webapp/public/ai-media-agent-adapter.js` | Existing search/play/pause/resume/state; no TeslaMon linkage |
| Relay | `webapp/src/lib/ai-media-agent-production-relay.js` | Validates Access same-origin ticket and tracks selected tab |
| Known relay hazard | `chosen()` can select the only online tab without explicit owner selection; `resume` can queue for up to 120 s after disconnect | **TeslaMon must not inherit** sole-tab fallback or queue/replay |
| Current relay controls | `get_player_state,search_media,play_media,pause,resume,stop` | Fullscreen missing in production relay |
| Shared release | Root `AGENTS.md` requires consolidated main, both-platform checks, immutable artifact and approved release | Separate Mac runtime topology is not established |
| Legacy runtime code | `ai-media-agent-mac-control-bridge.js` | **Not** the TeslaMon runtime; existing product controls must not be broken |

Existing remote control may continue independently. The new contract is **not** evidence a persistent Codex process or private MCP exists.

## S0 interface frozen for isolated fixture-only lanes (TM-004)

Pure validation implementation: `src/lib/teslamon-contract.js`, tests: `test/teslamon-contract.test.mjs`.

- Tool allowlist: `search_and_play`, `pause`, `resume`, `get_playback_state`, `request_fullscreen`, `exit_fullscreen`.
- Model-facing request: `{tool,args}`; non-playback tools require exactly `{}`. Search requires exactly one of a 2–160 character query or a minted candidate token. Arbitrary target, owner, URL and extra fields are rejected.
- **Trusted authority (out-of-band):** `{origin,subject,controllerId,deviceKey,connectionId,explicitSelection,tabConsent,authExpiresAt}`; bind only after server verifies session and reads the explicitly selected live target from the relay. Model/page input cannot assert these values. `connectionId` represents a unique registry connection generation.
- Mac-origin pilot contract uses `https://stream.ameshalex.com`. An HA-hosted page is **not authorized** for TeslaMon requests until an approved Mac cross-host coordinator route exists. This is a validation gate, not permission to deploy Mac-only.
- Bind `commandId` as a fresh UUID; expire command after at most 30 seconds or earlier site-auth expiry. Client/controller target change, revocation, reconnect/generation change and explicit cancel invalidate pending work. One active mutation per target. New target selection must not replay a previous queued resume.
- Observations correlate command ID, subject, target key and connection generation. `received`, `accepted`, `observed`, `failed`, `unsupported`, `needs_user_gesture`, `offline`, `uncertain`, `cancelled` are separate outcomes. `observed` requires timestamp no more than 10 seconds old, after dispatch, and validated playback/fullscreen enums. ACK does not prove audible output.
- Candidate tokens must be minted by a future server-side result registry, scoped to owner/request/target/generation with bounded TTL, and resolved to validated YouTube results before play. `search_and_play` cannot accept arbitrary media URLs.
- Retries: retain a bounded per-target command ID ledger; duplicate ID must be idempotent. Timeout after dispatch returns **uncertain** with explicit readback, never blind replay. Cancellation before dispatch prevents action; after dispatch it cannot claim playback was undone. This ledger is **not implemented** by this S0 contract.
- Future private MCP is local stdio or equivalent strictly private IPC, with only the six tools; never a public controller endpoint. Must prove capability confinement (shell, filesystem, Mac Control, Tesla Fleet, HA, other plugins **unavailable**), not rely on prompt instructions.
- Pet event names: `ready`, `requesting_permission`, `listening`, `transcribing`, `thinking`, `acting`, `result`, `cancelled`, `offline`, `needs_sign_in`, `needs_user_gesture`, `error`. Dedicated drag handle/move mode; drag is never record. Touch targets >=44 px. Fullscreen result is independent of playback result.
- Transcription adapter (planned): deliberate activation only, max 20 s, max 5 MiB, MIME checks, cancel/late-grant cleanup of **every** media track, empty input no action, no raw audio/history by default. No microphone, STT provider, audio upload or cloud usage yet.
- Authentication: reuse site's existing Cloudflare sign-in once. No second AI login. No credentials, model tokens, transcripts or private playback history in frontend, GitHub or Obsidian.
- Platforms: shared code compatible with Mac/HA; Mac runs proposed Codex runtime. HA shows explicitly unavailable until approved authenticated host route; cannot silently pass as tested.
- Test requirements before user-facing claim: 320/375/390/430 CSS px, iPad, mobile landscape, Classic/New, MJPEG+separate audio and WebCodecs; real iPhone and parked Tesla results must be separately recorded.

## S0 gate and implementation dependencies

| Story | Evidence | Current status |
| --- | --- | --- |
| TM-001 baseline | Clean main isolation, actual relay/AGENTS.md and PR state inspected | **complete** |
| TM-002 speech/browser/topology | `whisper` and `whisper-cli` binaries discoverable; no accuracy/permission/end-to-end capture proof. HA cross-host not designed | **blocked on isolated test + device/STT choice** |
| TM-003 Codex runtime confinement | Existing planning describes installed CLI, but the S0 shell PATH does not expose `codex`; no new version/protocol/tool-inventory proof | **blocked** |
| TM-004 tool/UI/ingress contract | Side-effect-free initial module and tests, event/edge design captured above; consumers not yet reviewed | **design complete for isolated mock lanes; integration not accepted** |

S1 **mock-only contract lane** can proceed without microphone or live model; live MCP/relay integration **must wait** for actual authority and runtime checks. S3 draggable pet UI can proceed with mock events after owner assigns exclusive new module files. S2 persistent Codex text alpha waits for TM-003 confinement, and live S3 speech waits for TM-002.

## Verification

Run `node --test webapp/test/teslamon-contract.test.mjs` from repository root (or test path from `webapp`). Check exact results at each revision. These are *isolated unit tests*, not live playback, Codex or physical device acceptance.

## Ownership / rollback

Feature branch owns only `webapp/src/lib/teslamon-contract.js`, `webapp/test/teslamon-contract.test.mjs` and this document. Do not alter the existing auth fix PR, deployed runtime, shared server, player transport, Cloudflare Access or original worktrees. Revert this feature commit or delete the isolated worktree to roll back; existing YT Streamer runtime remains unchanged.
