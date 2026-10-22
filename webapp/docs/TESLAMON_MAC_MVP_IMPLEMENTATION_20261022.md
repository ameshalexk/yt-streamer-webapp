# TeslaMon — Mac MVP implementation, code handoff

Date: 2026-10-22. **Source implemented in isolated branch. Not merged, deployed, signed-browser tested, or verified on an iPhone/Tesla.** User requested to defer hands-on tests and finish code first.

## Branch and composition

- Feature: `feature/teslamon-mvp-full-code-20261022`, based on S1 coordinator commit `0dfc95d`.
- Reuses the independently written and unmerged PR #78 push-to-talk lifecycle and binding via cherry-pick (`c236a18`, `27375a5`). It also reuses S0/S1 stacked components (contracts, private six-tool MCP, candidate service, exact-tab selected relay, command journal, coordinator).
- Parallel candidate registry branch was reviewed but not duplicated: current `teslamon-candidates.js` owns the behavior and its opaque token lifetime. Do not import both without a full reconciliation.
- The existing YT Streamer production deployment is unchanged; release requires both Mac + HA gates per `AGENTS.md`. **HA-origin TeslaMon control is explicitly unavailable** until a signed cross-host Mac bridge is built and approved.

## Newly coded flows

1. **Existing Cloudflare sign-in reused.** `startProductionMediaRelay` accepts optional `enableTeslaMon`. TeslaMon remains **off by default** unless `YT_TESLAMON_ENABLED=1`. All TeslaMon actions require a signed Access JWT verified by the existing `flow.authenticateHttp(req)` plus strict same-origin checks. No second AI account or browser JWT exposure.
2. **Server-internal exact browser authority.** Existing `selected-device.json`, ticket-verified WSS `clients`, and signed HTTP controller identity are independently matched using `AsyncLocalStorage`. A server-provided `deviceId` and `connectionId` must match the real `AgentSessionRegistry` for each command. No implicit sole-online-browser fallback for TeslaMon. The original Mac Control bridge is not used by TeslaMon's six controls.
3. **Authenticated Mac-origin endpoints** with no arbitrary device fields in command requests:
    - `POST /api/teslamon/devices` lists only verified owner-connected tabs and selected key; includes local STT capability.
    - `POST /api/teslamon/select` with `{deviceKey}` explicitly selects a connected same-subject tab, revoking old search tokens. No model or text decides owner/target.
    - `POST /api/teslamon/command` with **only** `{tool,args}`: six bounded playback tools. Sends through selected relay, candidate service and journal. Never arbitrary media URLs, shell, filesystem, Tesla Fleet, Home Assistant, or browser network scripting.
    - `POST /api/teslamon/transcribe` with a bounded supported audio Blob, if local model configured, after Access and origin verification.
4. **Movable browser pet** from `public/teslamon-pet.js` and CSS, loaded on the main YT Streamer page. Dedicated drag handle is isolated from microphone capture; the panel is keyboard accessible with connected-browser picker, text command, push-to-talk, pause/resume/status controls, multiple search result choices, status and network errors. Position is stored locally, no audio or conversation history is persisted. Classic/New UI use the same overlay. At minimized state there is no background polling or mic use.
5. **Voice/intent path** uses local restricted `teslamon-intent.js` command grammar to safely recognize play/search, pause, resume, status, enter/exit fullscreen. This fallback does **not** pretend to be a free-form Codex language model.
6. **Optional AI interpretation** uses a separate server-only OpenAI Responses API parser when BOTH `TESLAMON_OPENAI_API_KEY` and `TESLAMON_OPENAI_MODEL` are configured **and** the user checks the explicit in-panel opt-in. Only unmatched phrases are submitted; model output is strict JSON constrained to six playback intents, revalidated before dispatch, with no model tools, browser selection, filesystem, Mac Control, Home Assistant or vehicle actions. Separate API charges may apply; this is **not** Codex CLI, a Plus-plan entitlement, or a persistent agent. With no API configuration or unchecked opt-in, there is no model request.
7. **Browser speech** uses native `SpeechRecognition`/`webkitSpeechRecognition` when no local STT model is configured and supported; this browser API may use an OS/browser speech service, depending on platform. Otherwise the existing explicitly pressed `MediaRecorder`/capture binding records a max 20s / 5MiB audio clip in memory, uploads only under the same existing authenticated site session, and requests local Mac Whisper. It converts the media via FFmpeg to 16-kHz mono WAV and transcribes using `whisper-cli`. The server deletes both input/output temporary files in a `0700` temp directory after success, failure or cancellation. No API keys are sent to the browser.
8. **Fullscreen** action was threaded through the existing `app.js` screen controls, `ai-media-agent-adapter.js`, browser WSS action allowlist, `AgentSessionRegistry`, selected relay, ledger and coordinator. When native fullscreen is disallowed by browser user-gesture restrictions, the existing app's synthetic/in-page fallback is used; the result reports `native` vs `in_page` vs `none`. It doesn't force a browser to grant native fullscreen without activation.
9. **Safe replay**: command journal is owner-only local disk and fsyncs mutation reservations before dispatch; an uncertain result blocks subsequent new mutations until manual reconciliation (no blind replay on reconnect or timeout).

## Configuration — deliberate opt-in during later testing

The Mac already needs `YT_AI_AGENT_ACCESS_AUDIENCE` and `YT_AI_AGENT_CONTROL_DIR` for the existing signed Cloudflare + WSS relay. Set **only for the Mac service when ready**:

```ini
YT_TESLAMON_ENABLED=1
# Optional: if omitted, use browser speech recognition where supported or text.
TESLAMON_WHISPER_MODEL=/absolute/private/path/to/whisper-ggml-model.bin
# Optional if binaries not in service PATH:
TESLAMON_WHISPER_BINARY=/absolute/path/to/whisper-cli
TESLAMON_FFMPEG=/absolute/path/to/ffmpeg
# OPTIONAL paid model interpretation, completely disabled unless also opted in via UI:
TESLAMON_OPENAI_API_KEY=your_server_side_api_key
TESLAMON_OPENAI_MODEL=your_supported_responses_model
```

Do not commit model files, API credentials, personal recordings or executable binaries. STT availability is checked at request time; if disabled the UI offers text/native browser speech. A false-positive binary/model path results in a clear local transcription failure, not a cloud fallback.

User flow after a later approved release:
- Open the existing `https://stream.ameshalex.com` page through normal Cloudflare Access.
- Enable the existing **AI playback** browser opt-in in the original panel (so the tab pairs by a single-use signed ticket).
- Tap the TeslaMon pet, refresh and explicitly select one connected browser. Hold to talk when local STT is configured, or tap to talk when native SpeechRecognition is supported. Typed commands always work when the controller is enabled and signed.
- Example: `play latest MKBHD video`, `pause`, `resume`, `what's playing`, `fullscreen`, `exit fullscreen`. Multiple video matches require choosing one.
- For expired Cloudflare authentication, reopen the site; no separate login flow is created.

## Explicit remaining acceptance and limits

**What code cannot establish without an external environment/user test**:
- A **six-tool-constrained persistent Codex model runtime** is *not* installed or active. The previous Codex app-server initialize handshake did not prove sandbox/tool confinement, and a user Plus subscription does not automatically supply an OpenAI API key. By default this MVP uses a deterministic safe command grammar. Optional narrowly scoped OpenAI API intent interpretation is implemented behind separate credentials plus per-page consent; it is **not** a persistent Codex CLI runtime or an entitlement from the Plus subscription. Adding a supported model runtime requires a separate security review and credential/billing decision.
- The authenticated controller relay passed local tests with signed JWT fixture requests and two simulated WebSocket clients. This is not a Cloudflare-proxied live website or two real browsers, which still need device acceptance. The original login/sign-in PR #75 is separate.
- Local Whisper model availability, actual microphone grant on iPhone/Tesla/desktop, FFmpeg conversion, native fullscreen behavior and audio output must be tested on devices later. Browser native SpeechRecognition coverage differs by browser.
- `streamha.ameshalex.com` cannot run this Mac-only private controller until a trusted authenticated cross-host route is designed; its current TeslaMon UI is intentionally unavailable.
- Application regression, mobile-first browser matrix (320/375/390/430 CSS pixels, iPad/landscape, Classic/New, WebCodecs/MJPEG), macOS/Linux/arm64 both-platform CI and real hardware acceptance are required **before merging/deployment**. No claim of real speaker output proof is made: observed playback means a matching browser state snapshot.
- Owner-only journal may be quarantined after timeout/restart; operator reconciliation is required. Never delete a live lock or replay an uncertain mutation blindly.

## Verification notes

- Node syntax checks pass for changed JS (including server and pet).
- Original integrated S0–S1 and imported fake-microphone unit suites **114/114 passed** after updating fullscreen expectations; new parser/STT fixture tests **6/6 passed**. The production Access/WSS relay's dedicated local signed-session regression suite also **4/4 passed**, including two simulated signed WebSocket tabs, explicit target selection and no fallback/replay. **124 developer tests passed across these runs; five additional optional-model parser tests passed (129 total).**
- **These are developer-level static/fixture checks, not the device testing the user deferred.** No user-facing installation, real mic capture, remote playback or production deployment was performed.

## Rollback

All new code is in this feature branch; no live runtime state was modified. Reverting the branch removes TeslaMon changes. If deployed later, first disable `YT_TESLAMON_ENABLED`, then use the normal shared release process and preserve the owner-only journal as evidence until any uncertain commands are reconciled.

## Recommended next handoff

1. Inspect this branch/draft PR and run broad code/test acceptance later, including two signed browsers with a decoy, login, host compatibility and real physical devices. Resolve any failures.
2. If a real Codex natural-language agent is still required, implement a dedicated model-only runtime with **actual enforced six-tool confinement** and no shell/Mac Control/Tesla/HA/filesystem capability; do not treat system prompts as a sandbox.
3. Only after approval and both-platform CI, merge and deploy one immutable shared release, preserving old player routes and rollback.
