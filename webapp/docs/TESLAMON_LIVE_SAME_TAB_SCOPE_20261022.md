# TeslaMon same-tab live rollout scope (2026-10-22)

This narrow live candidate is based on consolidated main plus already-running Mac production adjustments: Cloudflare login UI cache reference and category-only bootstrap diagnostic. It does not transplant the unfinished staging server/MCP/model integration.

- Movable TeslaMon pet, six typed local playback actions, 45-second local search candidate tokens, local player readback and one fullscreen attempt after a new play. There is no remote browser selector, WebSocket TeslaMon controller, or cross-tab target.
- Native SpeechRecognition is offered only where supported. Typed commands work without microphone. Local Whisper, optional paid AI, persistent Codex, parked Tesla voice acceptance, and HA-origin control are outside this production scope.
- Existing restricted same-page media facade and playback engine are reused, without changing media transport or site Cloudflare policy.
- Chrome CI smoke uses synthetic local content and the production hostname within an isolated browser route; it does not sign in or play real videos.
- Both platforms passed is required at exact candidate commit before Mac installation. Real-device media playback is unverified until owner acceptance.
- Rollback: restore prior code/artifact without altering runtime data, user library or authentication configuration.
