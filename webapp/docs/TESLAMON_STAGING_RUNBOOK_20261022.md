# TeslaMon isolated Mac staging — 2026-10-22

**Latest status:** Mac staging is running; the separate public HTTPS hostname is DNS-routed and protected by Cloudflare Access. Google is configured as a Cloudflare identity provider, but **a successful Google login by ameshalexusa@gmail.com has NOT yet been verified**. The Google OAuth project is in *Testing* mode; its Audience page still visibly listed only `ameshalex@gmail.com` as a tester after attempts to add `ameshalexusa@gmail.com`. Treat owner Google login as a release **blocker**, not a completed test. Do not merge or deploy production.

## Staging vs production

- Staging source branch: `feature/teslamon-staging-20261022`, latest running code `3583ee85264ad7c485c50c99b430fb617db9b79e`; draft PR #87 stacked on Mac MVP draft PR #85.
- Mac staging service: `com.amesh.teslamon.staging`, `127.0.0.1:8107`, private separate data/control/library/chrome-profile dirs beneath `~/Library/Application Support/TeslaMonStaging/`. Stage launcher `run-stage.py` enables `YT_TESLAMON_ENABLED=1`, `YT_TESLAMON_STAGING=1`; the unrelated APNE background scanner is disabled.
- Mac production: separate `127.0.0.1:8099`, health passing at revision `4a846e53759969ac1076d69c2ef86dc5acd9a1a5`. Production process and source were neither restarted nor modified. **Caveat:** adding a new Google identity provider is a Cloudflare *account-wide* integration and could change login provider options for other Access applications that permit all IdPs; existing app allow/deny policies were not edited.
- Staging HTTPS: `https://teslamon-stage.ameshalex.com/`, attached only to separate named Cloudflare Tunnel `teslamon-stage` ID `4d562ecd-93f5-4179-9802-f6c68a981edf`. Dedicated tunnel LaunchAgent `com.amesh.teslamon.staging-tunnel` runs `cloudflared --config ~/.cloudflared/teslamon-stage.yml tunnel run teslamon-stage`; ingress proxies only the stage hostname to `http://127.0.0.1:8107`, otherwise 404. DNS route for the hostname was created 2026-10-22.
- Cloudflare Access self-hosted application **TeslaMon Staging**, ID `b6243c32-f277-4340-ab47-d34a1bcb0da4`, exact destination `teslamon-stage.ameshalex.com`.
- Access policy **TeslaMon staging Google owner**, ID `3bf80b93-75a6-4053-b12d-b53c4895237d`, Allow *Emails* selector set only to `ameshalexusa@gmail.com`; no Everyone rule or Bypass rule created.
- Stage Access audience tag `225020893dd2bde3e47990bac07f13352b9f954a40376120fe46e3e5d8fcefe8`, verified from the Cloudflare Access unauthenticated redirect's metadata and configured as stage-only `YT_AI_AGENT_ACCESS_AUDIENCE` in private stage launcher. Production Access audience was not changed.
- Google Cloud project **YT Streamer OAuth**, OAuth client **Cloudflare TeslaMon Google Sign-In**, type Web application; authorized origin `https://ameshalex.cloudflareaccess.com` and redirect `https://ameshalex.cloudflareaccess.com/cdn-cgi/access/callback`. The created client ID/secret were entered into a **Google TeslaMon Owner** Cloudflare identity provider. Keep client secret in Cloudflare/Google Cloud only; do not copy it to GitHub or Obsidian. Google Workspace is NOT required.

## Current verification and unresolved OAuth gate

- `GET http://127.0.0.1:8107/api/health`: 200; reports exact stage revision.
- `GET https://teslamon-stage.ameshalex.com/` without a login: **HTTP 302** to `https://ameshalex.cloudflareaccess.com/cdn-cgi/access/login/...` **before origin content**. HTML on the Access login page identifies **Google TeslaMon Owner** as an available login method.
- Staging endpoint without signed Access JWT: **401 signed_access_required**. Cross-origin POST: **403 wrong_origin** (previous private tests). Existing production 8099 remains healthy.
- Stage source: `npm --prefix webapp test` **609/609 pass**; `npm run check` passed. Isolated local headless Chrome pet overlay smoke: **7/7** viewport combinations Classic/New, including 320/375/390/430 width and 844x390 landscape. The 390px overflow issue was fixed.
- **Unverified:** Google OAuth authorization as the requested owner email. The OAuth Audience was *Testing* and displayed one registered tester `ameshalex@gmail.com`. Browser attempts to add `ameshalexusa@gmail.com` did not persist; Google login can therefore fail with `403 access_denied` / unapproved test-user error. A successful Cloudflare redirect and a visible Google provider DO NOT establish successful sign-in. Before inviting the user to test, add the owner account to Google Cloud project's OAuth Audience > Test users (or properly publish a minimal-scopes OAuth app) and verify a complete Google sign-in, signed staging JWT, exact-browser pairing and command.
- No physical iPhone/Tesla, live microphone, paid model inference or real personal playback accepted. Optional Whisper model is not configured. Default typed commands remain available only after authenticated owner login.

## Safe next steps

1. Open the OAuth Audience for project `yt-streamer-oauth` under the Google Cloud account with project permission; **add `ameshalexusa@gmail.com` as a TEST USER and confirm the list contains it** (or publish after Branding completion). Do not claim it was added solely because the text was typed in the form.
2. Test fresh browser Google sign-in to `https://teslamon-stage.ameshalex.com/` using `ameshalexusa@gmail.com`, confirm signed Access JWT has the staging AUD tag, and check owner-only restrictions.
3. Check two browser sessions with selected/decoy tab, search/play, pause/resume, fullscreen and reconnect; then later iPhone Safari and *parked* Tesla browser with owner approval. Do not test microphone before user permission.
4. Keep both feature PRs draft and both platform release gates separate; **do not deploy to production without approval**.

## Service and rollback

- Staging site stop: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.amesh.teslamon.staging.plist`
- Staging public ingress stop: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.amesh.teslamon.staging-tunnel.plist`
- Stage startup: bootstrap its own private plist only. Never stop the `yt-streamer` production Cloudflare tunnel or production app service.
- Logs under `~/Library/Application Support/TeslaMonStaging/{server.log,server.err.log,tunnel.log,tunnel.err.log}`. Avoid copying cookies/JWTs, raw audio, API credentials or OAuth client secrets into notes.

## 2026-10-22 self-tab playback correction (staging only)

The owner successfully signed into the staging site with ameshalexusa@gmail.com, but the TeslaMon UI displayed an unselected browser. That picker was inherited from the separate remote AI playback system, which is inappropriate for the owner's clarified requirement: TeslaMon controls ONLY the player in the current browser tab.

Implemented on the staging branch:
- The TeslaMon pet no longer has a browser picker, remote selection button, or extra pairing requirement. It displays "Controls this browser tab only" and "Ready to control this browser tab".
- The restricted existing page media facade is now loaded at the fixed staging hostname; TeslaMon uses that facade directly rather than the WebSocket remote pairing registry.
- New public/teslamon-local-player.js implements six typed playback actions, local search/results with 45-second opaque tokens, same-tab choice consumption, command serialization and playback-state readback. It cannot send commands to another browser and rejects arbitrary URLs/target IDs.
- Optional authenticated /api/teslamon/capabilities, /interpret and /transcribe remain server-side NON-playback helpers. Cloudflare JWT authentication is still required to use them.
- Staging private launcher sets YT_TESLAMON_SELF_TAB_ONLY=1; the three former remote TeslaMon HTTP endpoints /devices, /select, /command now return 410. This does not modify the separate legacy AI remote player feature or production.
- Versioned HTML script/CSS references are updated to avoid stale cached TeslaMon assets.
- Automated verification: npm test 618/618 pass; npm run check pass. New 9/9 local-player tests assert same-page routing, candidate boundaries, invalid target denial, pause/resume/fullscreen and truthful buffering state. Local headless Chrome staging-host smoke tests 7/7 viewport/UI pairs with NO browser selector, a self-target label and a Status command reading the current page's idle player.
- Not yet accepted on real iPhone, parked Tesla or signed-in public playback. No production merge or deployment.

Owner acceptance: hard-refresh https://teslamon-stage.ameshalex.com/, open TeslaMon, check the "Controls this browser tab only" label, try Status then Play/Pause/Resume in the same page. No browser registration is required.

## 2026-10-22 post-selection fullscreen improvement

- Selecting a new YouTube search candidate now automatically attempts fullscreen **once in the same browser tab** after playback is accepted. There is no remote tab or device selection.
- Fullscreen activation may be denied because the browser lost the initiating gesture. This is reported as a separate `needs_user_gesture` outcome; successful playback remains successful, with a direct fullscreen button still available. Native and in-page fullscreen are reported only from player readback.
- Pet status continues to distinguish playback phase from fullscreen status; a fullscreen state does not mask Playing/Paused when requesting status.
- Local same-tab tests cover fullscreen success, gesture rejection, unexpected exception and buffering. Production is unchanged, and no actual owner device, microphone, speaker or parked Tesla acceptance is claimed.

## 2026-10-22 — PowerALX-only TeslaMon voice, no Mac ASR models

**User hard constraint:** Mac mini M1 has 8 GB RAM. **No Mac transcription, Whisper model, model downloads or new model processes.** No new AI model download on PowerALX either. The earlier optional Mac whisper.cpp / native browser SpeechRecognition path is removed from the active staging voice workflow. Optional OpenAI Responses model interpretation is also explicitly disabled in staging (`YT_TESLAMON_DISABLE_MODEL=1`); typed playback uses the existing restricted deterministic intent grammar.

### Verified existing infrastructure reused

- Existing production **Life Recorder** Mac dispatcher `com.browseruse.life-recorder.poweralx-worker` is running and its SSH alias `poweralx` reaches the PowerALX Windows PC.
- Verified installed worker binary script at `C:\Users\Amesh\life-recorder-worker\releases\phase1-20260912-b\run-worker.cmd` without launching inference. It is the same production worker release currently used by Life Recorder, with the existing GPU model/cache and GPU lock. We do not install dependencies, build, download or introduce a new model.
- `webapp/src/lib/teslamon-transcribe.js` now spawns a small **Mac transport-only Python helper**, `teslamon-poweralx-bridge.py`, which reuses Life Recorder's tested `remote_worker.remote_command/transfer/ps_command` SSH/SCP transport primitives. The Mac does nothing more than validate MIME/size/duration/hash, create private temporary files, transfer <=5 MiB, receive validated text and clean up private temporary files. **No Mac ASR**.
- The helper sends each recording to its own UUID-bound directory `C:\Users\Amesh\life-recorder-worker\teslamon-jobs\<uuid>` rather than the existing Life Recorder SQLite queue or jobs; this cannot accidentally modify/complete a Life Recorder recording. Existing `run-worker.cmd` handles ASR only on the **PowerALX GPU**. The worker is invoked with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `HF_DATASETS_OFFLINE=1` to forbid any missing model weights from being fetched.
- Remote result must bind **matching UUID + SHA256**, have `final: true`, `status: complete`, valid segments, and nonempty text. The only returned value to the browser is <=220-character spoken text, which then passes the existing local six-tool TeslaMon command parser and controls the **same page**. No new remote playback or shell commands are exposed to the user/browser/model.
- If PowerALX/GPU is busy or unreachable, **fail closed** and keep typed controls available; never fall back to any Mac or browser transcription service. Server serializes at most one active TeslaMon voice dispatch. Transcription can be slower than a real-time streaming STT service because the existing worker is batch-oriented. Uncertain or timed-out remote jobs are *not* replayed blindly; inputs that may still be in use on Windows are preserved for manual review rather than deleted under an active process. Successful remote job directory cleanup is best-effort.
- Stage-only runtime config lives in the private `~/Library/Application Support/TeslaMonStaging/run-stage.py` with `TESLAMON_POWERALX_SSH_ALIAS=poweralx`, `TESLAMON_POWERALX_WORKER_ROOT=C:\Users\Amesh\life-recorder-worker`, `TESLAMON_POWERALX_WORKER_RELEASE=phase1-20260912-b`, and `YT_TESLAMON_DISABLE_MODEL=1`. No passwords/API secrets in version control.
- Staging public mic capture requires the existing signed Cloudflare Access session; the binary audio POST `/api/teslamon/transcribe` remains a bounded same-origin/signed route, not an open relay. Upload only on explicit user mic gesture, never background listening.

### Verification performed without invoking any ASR

- Existing PowerALX SSH alias and existing release script inspected; a **harmless remote `where.exe` PowerShell-command quoting probe** returned successfully without invoking the model/worker.
- Dedicated PowerALX adapter tests cover invalid input, disabled/unreachable worker, serializing one GPU request, byte-preserving transport, immutable command boundary, UUID/SHA/result validation, and no new Mac model fallback. No live media clip was transcribed during development.
- Updated UI explains `Sending audio to PowerALX for transcription...`, and suppresses stale voice transcripts after manual buttons/typed commands. All optional model interpretation disabled in staging.

**Owner's minimum final acceptance:** on the existing protected staging URL, tap/hold the pet microphone, speak `pause` (or `play latest MKBHD video`), release, and verify only the same page changes. Do this once on iPhone before deciding to release production. If PowerALX is unavailable, type the command and report the displayed error; no Mac model starts. Real ASR accuracy/latency and parked Tesla mic support remain unverified until user acceptance; do not call the original full 22-story epic 100% complete yet.

**Transport proof without ASR:** additionally used the existing Life Recorder `remote_worker.remote_command/transfer` to create one isolated PowerALX `teslamon-jobs/transport-<UUID>` directory, SCP-upload a harmless non-audio test marker, validate SHA-256 on Windows, SCP-download the file, verify byte-for-byte roundtrip and delete this isolated test directory. **All passed; no ASR/model was started or downloaded anywhere during this test.**

## 2026-10-22 — iOS microphone release/finalization fix

**Owner report:** On iPhone Chrome/WebKit at protected staging, holding the TeslaMon microphone displayed listening and then a generic `Microphone error` immediately after finger release, independent of spoken phrase. No proof that an audio upload or PowerALX transcription was ever reached. The recording lifecycle code had plausible failure paths before network upload:

- Previously `requestStop` stopped the microphone stream tracks **before** `MediaRecorder.stop()`. Safari/WebKit may only produce final `dataavailable` when `stop()` is called, and prematurely stopped tracks can cause recorder errors and empty blobs. Now recorder.stop() runs first; stream tracks are released only after stop/terminal cleanup or a guarded watchdog timeout.
- Strict full MIME equality rejected codec-augmented iOS `audio/mp4;codecs=mp4a.40.2` and empty Safari chunk MIME, even when the requested container was a supported audio/mp4. Now same-container base MIME comparison accepts legitimate codec parameters, while still rejecting unsupported/mismatched media containers.
- Stop watchdog increased from **1 second to 8 seconds** (with enforced 10-second maximum) to tolerate WebKit finalization; terminal cleanup and 5-MiB/20-second recording limits retained.
- Button **blur after ordinary finger release** must not cancel a recorder still finalizing. Window blur, page hide, active pointer cancellation and explicit target change still cancel correctly.
- UI now separates phases: microphone access → recording → finalizing → **Audio captured, sending to PowerALX**. A recording-stage failure gets a recorder-specific message, while server/PowerALX returns a separate, typed error. Empty recordings receive a specific message. No raw recording or transcript logs added. A phrase outside the playback grammar will be handled *after* transcription, not as a microphone failure.

**Tests:** Full `npm --prefix webapp test` **631/631 pass**; `npm --prefix webapp run check` pass. Added fake Safari stop-only final-chunk, codec-decorated mp4, empty chunk MIME, 1+ second async finalization and button-blur-after-release regression tests. **Real iPhone playback/PowerALX GPU inference remains unverified; user must retry the staging microphone.** This change does not run or download a model on the 8-GB Mac, does not modify the PowerALX worker, and does not touch production YT Streamer.
