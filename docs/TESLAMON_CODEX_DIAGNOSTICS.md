# TeslaMon Codex timing diagnostics

Production: Mac mini `com.ytstreamer.webapp`, log at
`~/Library/Application Support/YTStreamerWebapp/data/server.log`.

The `[teslamon-codex]` lines are compact JSON events. Events for the same request
share an anonymous random `traceId`. `elapsedMs` measures wall-clock time from
the accepted Codex planner request, rather than model-token latency.

Phases:
- `request_started`: validated planner input; `resumed` says whether this
  request uses an existing Codex thread.
- `process_spawned`: Codex subprocess successfully launched.
- `first_stdout`: first structured CLI event arrived.
- `thread_started`: CLI reported a thread start (the ID itself is never logged).
- `mcp_started` / `mcp_completed`: allowed light MCP call, its approved tool
  name, call number/success flag. These phases can reveal tool latency.
- `turn_completed`: CLI reported a completed model turn.
- `service_failure`: safe normalized error code; never CLI error text.
- `termination_requested`: reason `deadline`, `request_cancelled`, or
  `output_limit`.
- `guardrail_termination`: unexpected/disallowed tool attempted.
- `process_closed`: numeric exit code and stdout/stderr byte counts (not content).
- `process_error` / `spawn_failed`: local process failure.
- `finished`: final status, safe code, and termination reason.

Examples:

```sh
rg -F '[teslamon-codex]' "$HOME/Library/Application Support/YTStreamerWebapp/data/server.log" | tail -n 60
```

If a request hits the 45-second deadline, examine the last phase for its
`traceId`:
- No `first_stdout`: delay before CLI event output (startup/auth/network possible).
- `thread_started` but no `mcp_started` or `turn_completed`: planner/model delay.
- `mcp_started` but no `mcp_completed`: tool call or downstream HA delay.
- `turn_completed` before process close: CLI cleanup/exit delay.

Privacy: no speech, user prompts, raw CLI output/stderr, session/thread IDs,
Cloudflare identities or credentials are included. Events are emitted to the
existing server log under its existing retention/permissions. The client
response and 45-second deadline are unchanged. This is diagnostic telemetry,
not proof of a root cause until a subsequent request is observed.
