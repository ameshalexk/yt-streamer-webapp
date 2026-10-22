# TeslaMon S1 — private MCP fixture implementation

Date: 2026-10-22. **Experimental, isolated, not linked to live YT Streamer, not installed or deployed.**

## Dependency and branch

- Project: [TeslaMon epic #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26), not Tesla vehicle control.
- Base: `feature/teslamon-s0-contract-20261022`, commit `036a988` (stacked on top of draft PR #77). A stacked change is not a green release.
- New branch: `feature/teslamon-s1-private-mcp-20261022`.
- No edits to the production relay, browser player, Cloudflare policies, runtime, config or environment credentials.

## Implemented

1. `webapp/src/lib/teslamon-private-mcp.js`: `createTeslaMonMcpHandler`, `serveTeslaMonMcpStdio`, exact six-tool MCP schema. Only stdin/stdout JSON-RPC; no HTTP listener, shell, Mac Control, Home Assistant, Tesla Fleet or filesystem manipulation tools.
2. Transport negotiates `2025-11-25` (accepts older `2025-06-18` initiation), requires initialize/initialized before tool use, lists six fixed tools and rejects unknown methods. Input is bounded to 16 KiB per frame.
3. Tool calls require a **server-only injected** `getAuthority()` which must later use existing signed Access/selected browser registry. It refuses implicit sole-tab selection, bad origin, missing consent, expired auth and user/model-provided target overrides.
4. The command binder requires exact owner/controller/device/connection-generation identity and creates a UUID command ID. Dispatcher is an injected interface: **no actual live dispatch is provided in this branch.**
5. Accepted ACK is not observed playback. Responses are checked against command ID, owner, tab, connection generation and freshness, and report `uncertain` when evidence is insufficient. MCP RPC requests are cached by ID, bounded/expired; duplicate ID cannot repeat effects. Parallel calls are rejected as busy; matching cancellation ID cancels, unrelated ID cannot cancel another request. Post-dispatch cancellation is `uncertain`, never claimed as undone.
6. `webapp/test/fixtures/teslamon-private-mcp-fixture.mjs` simulates a selected tab with a synthetic driver and **does not touch browser/player/network**.
7. `webapp/test/teslamon-private-mcp.test.mjs` checks handshake, tool inventory, strict params, auth/origin/target, malicious calls, truthful ACK/readback, duplicate replay and cancellation and real Node child-process stdio JSON-RPC.

## Validation (on isolated branch)

- `node --test test/teslamon-contract.test.mjs test/teslamon-private-mcp.test.mjs`: **17/17 passed** (9 S0 + 8 S1).
- `npm run check`: **pass**.
- `git diff --check`: **pass**.
- Actual stdio client↔child-process fixture call: initialization, tool list, synthetic pause and forbidden tool rejection **pass**.
- No external MCP SDK conformance, real selected YT Streamer tab, Cloudflare Access, Codex tool execution, desktop/mobile media or HA acceptance yet. Dependencies of original unrelated relay regression tests are missing from this clean worktree.

## S0 Codex capability probe

- Resolved CLI location: `~/.codex/plugins/.plugin-appserver/codex-cli/bin/codex`; version `0.163.0-alpha.10.2` verified.
- Launched `codex app-server --stdio` with a temporary independent `CODEX_HOME`; initialized with user agent `teslamon-isolated-readonly-probe`. Handshake **passed (~409 ms)**, process terminated and temporary home removed. No thread, model, tool invocation or paid operation executed.
- **TM-003 remains blocked:** app-server handshake is not proof that the account/agent can be restricted to the six MCP tools. Do not connect the model until tool confinement is independently verified; `sandbox=readOnly` alone does not remove shell/read/network/tool capabilities.
- Relevant official docs: https://learn.chatgpt.com/docs/app-server and https://modelcontextprotocol.io/specification/2025-11-25/server/tools.

## Remaining security/product work

- The current MCP handler is a fixture-backed component, **not a production-ready authenticated endpoint**. The eventual integrator must inject authority directly from existing authenticated selected-tab registry, never parsed client JSON or model output.
- Implement candidate/result registry and explicit media ID authorization before search/play; current token shape check alone cannot validate a candidate. Do not trust arbitrary result tokens.
- Implement TTL-aware outstanding command ledger across process crashes/reconnects. This fixture deduplicates per-process JSON-RPC IDs but is not a persisted exactly-once production system.
- Add actual model runtime restriction proof, hosted-page-to-Mac coordinator path, model unavailable fallback and separate HA-origin capability gate.
- Implement fullscreen by updating every production layer (current relay does not permit it); truthful unsupported/gesture-required until then.
- Need browser hardware microphone test + chosen STT provider, then pet UI, mobile matrix, native-versus-in-page fullscreen and required shared both-platform CI. Keep separate authentication PR #75 intact.
- No prod deployment, merge or user-device testing authorized by this branch; rollback is removing the isolated stacked branch/worktree. Existing stream playback remains untouched.

## Story state

- TM-001 baseline: complete.
- TM-004 contract: complete for mock-only design.
- TM-102 MCP protocol/isolated fixture: **completed at its isolated-fixture acceptance level**, but live relay service integration is unverified and the MVP is not functional.
- TM-002 speech/STT: blocked/unverified; TM-003 Codex tool confinement: partial research, still blocked.
- TM-101/103/104 and S2–S5: incomplete.
