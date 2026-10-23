# TeslaMon Codex CLI natural-language playback (2026-10-22)

## Runtime flow
1. Signed-in iPhone browser captures voice by push-to-talk.
2. Existing Mac forwarding pipeline sends audio to the existing PowerALX GPU ASR worker. No Mac transcription model.
3. Cloudflare Access protected same-origin `POST /api/teslamon/plan` accepts up to 220 characters of transcript or typed command; the existing cryptographically verified Access principal and an ephemeral random tab UUID scope the model's session.
4. Existing account's Codex CLI runs with `--ignore-user-config`, read-only sandbox, no approvals, an empty isolated Git workspace and no inherited plugins. No second login, no separate API key, no CLI argument containing the voice transcript.
5. Codex returns exactly one JSON command under a strict schema. Server validates that it is one of the six supported playback commands, plus unsupported. It cannot select a different browser tab, arbitrary URL or desktop action.
6. The requesting browser invokes the chosen command through its current-tab six-tool playback facade and verifies the result. Quick controls bypass Codex.

## Limits and transparency
- Codex is used for natural-language reasoning, not voice recognition. As the model is a cloud service, **the transcript text is sent to the signed-in Codex account's model service**; the captured audio remains with the existing PowerALX path.
- Codex thread state is resumed across follow-up commands using `codex exec resume`; **the CLI process is restarted for each request**, not a permanently running app-server.
- At most 10 per-tab conversation entries, 30 minute idle expiry, one concurrent Codex request, timeout 45 seconds, bounded process output. No transcript or audio is stored in YT Streamer.
- Code is Mac-only. HA reports Codex unavailable; no unauthorized remote browser or cross-host control.
- This is a Codex-to-six-command **validated action bridge** using existing current-tab media tools. It does not yet expose the six actions as a directly model-invoked MCP protocol session; that would require a separate authenticated bidirectional browser execution channel.
- Codex read-only sandbox and no-plugin configuration limit its built-in tools, but do not prove absolutely tool-less execution. Tool-use events cause rejection and termination; model responses are never treated as shell scripts or passed to system executors.

## Mac runtime
- Uses existing working Codex CLI sign-in and the binary bundled with ChatGPT; no local model installation or new tokens/API-key handling.
- Empty owner-only Git workspace at `~/Library/Application Support/YTStreamerWebapp/private/teslamon-codex/workspace`. Initialized as git so CLI resume accepts it. Do not check in credentials or source files there.
- Existing Cloudflare auth accepted via signed header or signed cookie. No new sign-in.
- Verified real CLI first turn selected search_and_play for an MKBHD request; follow-up on the same CLI thread selected pause. Full unit/webapp and seven-viewpoint browser checks used. A physical owner iPhone voice-to-playback acceptance has not yet been performed.
