# YT Streamer — AI Media Agent & WebMCP
Status: **Planning (2026-10-08)**. No runtime/production changes.

## Goal
Enable a **natural-voice AI assistant** on phone (ideally ChatGPT Voice, after a real capability test) to control an **already-open YT Streamer browser session** on a selected device, especially a **parked Tesla**. Users can ask for videos/songs, change media, skip, seek, pause, resume, check playback and request fullscreen where the browser permits. Retain the same media engine and Classic/New UI functionality.

**Tracking:** [Epic #26](https://github.com/ameshalexk/yt-streamer-webapp/issues/26) · [UI modernization issue #24](https://github.com/ameshalexk/yt-streamer-webapp/issues/24) (separate) · branch `feature/ai-media-agent-webmcp`.

## Architecture (the important distinction)
1. **Voice agent/client:** natural-language request, e.g. iPhone ChatGPT Voice. Confirm whether *this actual voice client* can call an authenticated custom remote MCP before building around it. If not, test an alternative voice frontend that can, rather than inventing ChatGPT Voice capabilities.
2. **Remote MCP server:** narrow authenticated tools (`list_devices`, `get_player_state`, `search_media`, `play_media`, `pause`, `resume`, `next`, `seek`, `set_volume`, `request_fullscreen`); consistent schemas and actual outcomes. Model-agnostic.
3. **Playback-device relay:** the backend routes a command to an authorized *specific active tab* using an authenticated WebSocket or documented alternative. Heartbeats, expiry, reconnect, command IDs, acknowledgments and result-state readback are required. Do not confuse “command sent” with “media started”.
4. **In-page WebMCP enhancement:** progressive exposure of existing controls to compatible *same-browser* AI agents with the current API (check `document.modelContext` support in target browser). WebMCP does **not**, by itself, let an agent in one browser control a different Tesla tab.
5. **Existing player:** route actions through existing player state/actions. No separate streaming engine or API that blindly clicks the DOM.

```text
iPhone voice client (capability check)
   -> authenticated remote MCP tool call
   -> YT Streamer server: authorization + command router
   -> device/session channel
   -> existing Tesla/TV/phone browser player
   -> actual state + ACK -> agent confirmation

Same-browser agent -> WebMCP feature-detected page tools -> same player actions
```

## Initial minimal functional contract
- **Device**: list online players with user-chosen labels; choose explicit target, require sufficient authority, expire offline sessions.
- **Search/play**: search YouTube/saved playlists through actual supported sources; give choices when ambiguous; play on selected target and confirm current item.
- **Playback**: pause/resume/next/seek/volume as supported, state readback, clear unsupported-action errors.
- **Fullscreen**: prefer native fullscreen when allowed, but browser user activation may be required. Return `needs_user_gesture` and display a touch-friendly action **on that Tesla tab**. Do not spoof gestures or claim success without state verification.
- **Voice**: first prove MCP clients work with text tools, then test voice. Never depend on an always-running voice session; media playback should remain independent.
- **Safety**: video only while Tesla is parked; never bypass vehicle restrictions. Audio-only usage must respect browser and vehicle policies.

## Implementation plan — 2 short sprints
| Sprint | Story | Task | Completion |
|---|---|---|---|
| 1 | [#27](https://github.com/ameshalexk/yt-streamer-webapp/issues/27) | Inspect production, voice-client compatibility, security design | pending |
| 1 | [#28](https://github.com/ameshalexk/yt-streamer-webapp/issues/28) | Authorized session registry + reliable browser relay | pending |
| 1 | [#29](https://github.com/ameshalexk/yt-streamer-webapp/issues/29) | Search and playback command adapter + readback | pending |
| 2 | [#30](https://github.com/ameshalexk/yt-streamer-webapp/issues/30) | Authenticated remote MCP integration + voice trial | pending |
| 2 | [#31](https://github.com/ameshalexk/yt-streamer-webapp/issues/31) | Native WebMCP enhancement and fallback | pending |
| 2 | [#32](https://github.com/ameshalexk/yt-streamer-webapp/issues/32) | End-to-end iPhone-to-parked-Tesla tests and rollback | pending |

## Gates and cautions
- Repository is public: never commit credentials, personal media history, private screenshots or token-bearing URLs.
- Existing UI v3 work has a separate worktree, tracked at #24 / draft PR #25. **Before coding:** inspect real deployed build/commit and reconcile with dirty local source and pending PR. No blind checkout/reset/overwrite of ongoing work.
- Do not change the media transport, current audio sync paths, `/money`, existing dashboards, Cloudflare routes, auth or launchd to achieve this feature unless separately justified and approved.
- Cloudflare must not expose anonymous remote-control tools; check existing authentication and protect MCP/relay sessions from cross-user/target abuse.
- Negative tests: invalid auth, stale target, offline tab, concurrent connections, duplicates, reconnect, malformed and prompt-injected media metadata.
- Validate in supported desktop Chrome first; **do not assume Tesla WebMCP/microphone/fullscreen/autoplay**. Test real parked Tesla separately.
- All implementation behind isolated feature flags, tests and rollback. **No production deployment without explicit owner approval**.

## Research references
- https://developer.chrome.com/docs/ai/webmcp
- https://developer.chrome.com/docs/ai/webmcp/secure-tools
- https://github.com/webmachinelearning/webmcp

## Handoff
Start at **#27**, not at implementation. Use the canonical Obsidian project note `Projects/YT Streamer - AI Media Agent and WebMCP.md`; update GitHub issues and Obsidian for each meaningful checkpoint.
