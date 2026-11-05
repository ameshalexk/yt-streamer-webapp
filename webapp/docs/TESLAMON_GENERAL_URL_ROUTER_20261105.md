# TeslaMon general natural-language URL router (2026-11-05)

## Goal

`https://stream.ameshalex.com/<spoken words>` is a general *intent entry point*, not a raw command shell. The existing explicit `/ha/<command>` and `/mac/<command>` routes remain supported, and reserved app/static paths such as `/retro`, `/retrotv/`, `/games/`, `/api/`, and encoded forms do not become commands.

## Flow

1. A browser navigation loads the streamer app; the eligible path is captured and removed from browser history. Opening a URL cannot directly mutate a device.
2. An origin-bound, Cloudflare Access authenticated POST to `/api/teslamon/url-route` asks a **tool-free** Codex CLI process to classify the unspaced or encoded utterance using a strict JSON schema: `video`, `ha`, `mac`, `answer`, `unsupported`.
3. For `video`, the existing restricted local-tab player planner runs. Video search and local player controls are allowed, but no MCP or other device tools.
4. For `ha` or `mac`, the original signed provider planner interprets the normalized text. Read-only results are shown; authenticated and allowlisted HA changes execute hands-free in the dedicated HA planner, while Mac Control changes still require an expiring one-use approval token and browser click. Routing/classification alone never calls a device tool.
5. For `answer`, Codex may give a brief, static general-knowledge response. For other actions or missing integrations (such as Tesla), the router responds `unsupported` rather than fabricating a result. Arbitrary filesystem, shell, coding-agent execution, email, secrets and security changes are never available through this URL router.
6. Aura shows the received text, classification progress, and result or reason for failure. Busy errors receive bounded retry only; quota errors are not masked or retried indefinitely.

## Security and operational constraints

- Existing signed Cloudflare Access principal and exact browser origin gate are reused. Classification process has `--ignore-user-config` and `--sandbox read-only`, no MCP configuration; output is schema-validated.
- Each provider retains its own explicit allowlist, session/principal-bound one-use write confirmation and separate independent signed POST endpoint.
- The page processes a captured path only once per document; `history.replaceState` clears the command path so a reload does not re-execute it. No automatic device changes from navigation.
- A Codex usage limit prevents classification; the UI must report the limitation. This is not a bypass of Codex quota.
- The Tesla connector is not yet present in the streamer server; Tesla actions are not claimed supported.
- Do not deploy this branch automatically. Run local Node/browser tests and shared Mac/HA CI, then require an approved release plan with backups and verification.
