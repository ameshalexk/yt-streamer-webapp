# TeslaMon Home Assistant: hands-free execution (PR only, 2026-11-05)

Owner request: remove the 'Confirm Home Assistant change' dialog for a true hands-free voice/Grok URL experience.

## Behavior
- A signed, same-origin POST to `/api/teslamon/ha-plan` now both validates/plans and applies a **fixed allowlist** of light on/off (entity or area), switch/fan on/off and thermostat setpoint (55–85 °F) actions. Safe reads continue unchanged.
- The authenticated browser receives the outcome directly. Aura shows completed or failure status without a second tap, modal, token, or `/ha-confirm` endpoint.
- Both explicit `/ha/<encoded-command>` and ordinary Grok URLs routed to HA use this path. On command dispatch, the URL is cleared and a reload does not re-run it. The GET itself is a static SPA navigation; the browser makes an authenticated POST.
- The unrelated Mac Control confirmation dialog and `/api/teslamon/mac-confirm` route remain unchanged.

## Boundaries / caveats
- Cloudflare Access identity verification, signed origin/session validation, local-only HA MCP connection, Codex plan schema, entity/room validation, exact entity matching for writes and restricted tool selection remain in place.
- This change **does** permit an authenticated HA command to change a device immediately without a human tap. Malformed, unauthorized, unsupported, out-of-range and ambiguous requests still fail closed. No locks, garage doors, covers, alarms, cameras, scripts, automations or arbitrary service calls.
- Upstream HA MCP still receives its required `confirm:true` flag for a validated write; that flag is an MCP argument, **not** a user-facing approval. Provider errors must not be reported as success.
- No real home devices were switched during tests. Browser integration uses a synthetic fixture; it confirms UI routing and absence of a modal, not actual physical operation.

Release scope: separate GitHub PR only. **Do not merge, deploy, restart services, or alter Cloudflare/Home Assistant.**
