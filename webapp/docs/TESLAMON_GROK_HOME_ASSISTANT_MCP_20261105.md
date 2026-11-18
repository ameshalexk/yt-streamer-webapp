# Grok → Aura → Home Assistant MCP (review only)

- Base: merged Aura Grok PR #149 on `main` (2026-11-05).
- Command namespace: `https://stream.ameshalex.com/ha/<URL-encoded request>`.
- Existing arbitrary-path Grok video commands remain **strictly video-only**; `/ha` is reserved in the video router and never sent to video Codex.
- Browser opens Aura with the exact decoded text. A same-origin POST is signed against the existing Cloudflare Access identity. Codex is used for *structured intent extraction only*, with `--ignore-user-config`, read-only sandbox, no approvals and **no MCP tools**. A fixed policy in Node selects a small allowlist of existing local HA MCP methods.
- Read now: entity search, sensor/thermostat/light state and HA area names. Search results are bounded to eight items; raw attributes, config IDs, tokens, automation bodies and camera images are not surfaced.
- Changes (hands-free once authenticated; superseded by follow-up PR): light on/off by exact entity or by named area, switch/fan on/off, climate temperature 55–85 °F. Friendly-name write targets must resolve to a single entity; ambiguous targets fail closed. No lock, cover, alarm, garage, automation/script, camera, media or arbitrary `call_service` permissions.
- **2026-11-05 follow-up:** The owner requested removal of the browser confirmation tap for Home Assistant actions. See `TESLAMON_HA_HANDSFREE_20261105.md` for the updated security boundary, test cases, and release constraints. Mac Control still uses one-use confirmation tokens.
- Existing Cloudflare Access and same-origin JWT validation are preserved; no new public MCP endpoint. MCP backend is local to Mac (`127.0.0.1:3848/mcp`) and never exposed to Grok. If the upstream MCP or Codex is unavailable, return a bounded error without invoking an action.
- Source/config: `webapp/src/lib/teslamon-device-{plan,mcp}.js` and plan schema, `webapp/public/teslamon-device-url.js`, `teslamon-pet.js`, plus signed endpoints in `server.js`.
- Limitations: Codex account quota may block intent extraction. Home Assistant's native Fahrenheit config is assumed for the `thermostat_temp` path. Actual Tesla/Grok pronunciation, live MCP state and physical device switching are **not** proven by mocks. Never test physical mutations without explicit approval. The streamer on StreamHA cannot run the Mac-hosted Codex workspace and returns unavailable.
- Release boundary: **PR only. No merge, runtime deployment, Mac/HA restart, add-on installation, tunnel, Cloudflare or production state change.**
