# AI Media Agent — Phase 1 + Phase 2 Compatibility Preview

Date: 2026-10-21

## Scope

This is a **development-only integration preview** of two independently developed branches; not a merge to `main`, not a live release, and not proof that ChatGPT can call tools against Tesla.

- Starting source revision: `6adcff204b37206d4f897b3f41f612a179d52c1a` (current Mac streamer health revision when first audited).
- ChatGPT Phase 2: `feature/ytstreamer-ai-agent-phase2-auth-20261021` at `4a86b89a6f9315a9ad3aafd1a5f76ae0831fdb4f`, draft PR #69.
- Codex Phase 1 **snapshot**: `feature/ai-media-agent-phase1-20261021` at `7eec312164d105cfd03e2ebb7038ee09d8d856c2`. Codex may continue adding commits; this preview does not move or edit Codex's worktree or branch.
- Preview branch: `integration/ai-media-agent-phase3-preview-20261021`.

## Conflict reconciliation

The branches independently added `scripts/ai-agent-local-relay.mjs`, `src/lib/ai-media-agent-session-registry.js` and their two tests (4 add/add collisions).

- Preserve Phase 2's authenticated MCP + trusted Access browser WebSocket gateway and server-side authorization primitives. They remain opt-in and **loopback-only**.
- Preserve Phase 1's browser adapter and independent `public/ai-media-agent-dev.js` test UI under the existing `?ai_agent_dev` localhost gate.
- Reconcile common session registry to keep Phase 2's transport-neutral authorized selected-device dispatch and actual ACK, while retaining Phase 1's **caller-provided command IDs, duplicate/expired/replayed command protection, bounded active sessions, bounded remembered command IDs, and validated playback phase**. The remote MCP still generates server-side command IDs and separately enforces signed Access JWT/nonce.
- Reconcile private loopback dev relay so Phase 1's explicit browser origin and command ID are honored. For Phase 2's historical synthetic server-to-server test fixture, omit-Origin on an exact `127.0.0.1` listener remains allowed **only with a distinct long bearer token**; this is *not* suitable for public ingress and the `/dev/*` handlers remain separate from the remote MCP/production app. Explicit-Origin browser sessions reject absent/incorrect Origin.
- Keep both previous suites rather than deleting one: Phase 2's original tests plus Phase 1's preserved source tests in `ai-media-agent-phase1-*-compat.test.mjs`. Adjusted only the legacy fixture's assumption that every loopback harness must be launched with explicit Origin; no public binding allowed.

## Verification

- `npm run check`: PASS.
- `npm test`: **478 tests passed; 0 failures, skips or cancellations** (Phase 1 + Phase 2 + current streamer source).
- `npm run test:ai-agent-browser`: PASS in real local Google Chrome 155, with deterministic video/audio fixture. Search results: 1; Classic and Experimental modes each observed real play, pause, resumed frame progression and stop; legacy MJPEG displayed frames, paused/resumed/stopped; an **unselected decoy tab remained idle**. Responsive screenshots for six viewport sizes. The original Codex evidence snapshots are preserved rather than replacing them with this test's generated images.
- Base Phase 2 PR #69 head `4a86b89` GH Actions run `39711546448`: **SUCCESS**, including both macOS/Ubuntu and HA containers, as verified before preview creation. Preview itself requires its **own** CI before approval.
- No real Cloudflare Access login, real iPhone/ChatGPT custom tool call, publicly reachable trusted browser connector, or physical Tesla audio/video test was performed.

## Known follow-up gates

1. Phase 1 Codex branch may still be advancing. Reconcile any later commits before considering this preview final.
2. The Phase 1 browser adapter currently pairs only to the **localhost developer relay**, and its `?ai_agent_dev` gate deliberately prevents public/Tesla activation. It **does not yet implement** the trusted Access browser WS client + its secure explicit-consent UI.
3. A WebSocket `approve_remote_request` frame is not independent proof of a trusted user gesture. CSP/XSS and local-click semantics need a security review before any real remote access.
4. The remote MCP server is not mounted in production. Public TLS Access / audience/JWKS/issuer/subject provisioning and live credential handling require a separately approved rollout plan.
5. Direct ChatGPT text-to-MCP write-tool availability must be empirically verified; voice availability remains unconfirmed. Do not assume native Tesla browser WebMCP.
6. Do **not** merge to main, deploy Mac/HA, update Cloudflare/Tunnel, or attempt in-motion vehicle video. Physical Tesla tests require Park and user authorization.

## Handoff

Review this separate draft integration branch and its CI. Phase 3 needs a **trusted browser pairing/approval implementation** plus a real MCP client capability test. Work on it only after coordination with Codex's Phase 1 owner; preserve the current production JXL/seek, fullscreen, touch, audio and Classic/New modes.
