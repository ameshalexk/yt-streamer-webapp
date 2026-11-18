# Grok → Aura → Mac Control MCP (review only)

This PR is **stacked on** the separately reviewable Home Assistant integration PR #150, not `main`. The UI/auth/confirmation scaffolding belongs to that HA PR; this PR adds Mac-specific functionality only. Neither PR should be merged or deployed without an independent instruction.

- Explicit command prefix: `https://stream.ameshalex.com/mac/<URL-encoded command>`. `/mac/` and encoded aliases are reserved from the existing Grok video URL parser. Ordinary site and video paths remain unchanged.
- JWT-validated Cloudflare Access principal, same-origin POST validation, isolated Mac Codex read-only JSON planner with no MCP tools, fixed local MCP tool allowlist, human click confirmation for app mutations.
- Read-only: system version/uptime/free disk, local primary network interface/IP/DNS count, open application names (never window titles), installed status for approved applications, and current launch-agent status by label.
- Permitted changes after one explicit confirmation tap: **launch** an allowlisted application or **focus** its window. Allowed applications: Safari, Google Chrome, Finder, Notes, Calendar, Music, Photos, Preview and TextEdit. The upstream MCP's native permissions and app policies still apply.
- Excluded: shell/terminal, command/code execution, filesystem read/write, messages, screenshots/screen recording, clipboard, browser URLs, installations, security settings, credentials, processes, power operations, and arbitrary MCP tool names. No Mac Control token or MCP endpoint is sent to a browser or Grok.
- Upstream Mac Control MCP is accessed through Mac loopback `http://127.0.0.1:3850/mcp`, not a public port. SDK's automatic output-schema validator does not support this provider's metadata; the adapter explicitly validates the standard `tools/call` result envelope and sanitizes fixed output fields.
- A command URL never directly mutates the Mac. Mutating plan returns a 90-second, 192-bit random, one-use approval token bound to verified Cloudflare Access subject and the exact browser session UUID. A separate signed POST is required after the user clicks Confirm. Cancel, failure, expiry, mismatch and replay cannot execute.
- Mac feature is gated by the Mac-hosted Codex binary/workspace and local MCP service. An HA-hosted copy cannot run the Mac-specific planner.
- Unit tests and the shared app suite use mocks; a real **read-only** Mac Control MCP request for Safari installed status succeeded. No real application was opened/focused, and physical Grok/Tesla navigation still needs acceptance after an explicitly approved deployment.
- **NO merge, release publication, Mac/StreamHA installation, service restarts, Cloudflare or production state changes.**
