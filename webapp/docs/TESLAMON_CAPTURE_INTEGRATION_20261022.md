# TeslaMon capture integration and bounded native speech

This continuation is stacked on pet lifecycle PR #86 (`e34ccf2`). It composes the previously isolated capture fix `e01cc5d` into the integrated MVP as `72eba8d`, preserving its 15 real-controller/binding synthetic regressions.

## Behavior

A capture start refused while a previous recording is stopping now releases only the rejected button press. Releasing that press cannot cancel the earlier recording. Denied microphone permission also releases pointer capture.

Native browser SpeechRecognition receives a 20-second deadline and cancellation when the interaction loses focus or is closed, hidden, retargeted or unloaded. Timers and session callbacks must be retired together; timeout discards incomplete speech rather than dispatching a partial command. Local recorder limits remain 20 seconds / 5 MiB.

## Evidence boundaries

All verification here is offline and synthetic on macOS. No actual microphone, paid model call, Cloudflare login, real browser or physical iPhone/Tesla acceptance occurs. Existing HTML/CSS is unchanged, so the original mobile acceptance matrix remains pending. No service, global config, journal or deployment changes.

PR #86 already passed macOS, Ubuntu, amd64/aarch64 containers, bundle checks and Both platforms passed. Those results belong to `e34ccf2`, and do not establish CI success for this new continuation.

## Rollback and next work

Revert the new native-speech commit and `72eba8d` to remove this continuation. Device acceptance and release remain separate. Persistent Codex confinement/runtime and authenticated HA cross-host routing remain unfinished; source/test success does not close either.

## Final verification

- Full local macOS repository suite: **636/636 passed**, zero failures.
- Capture/controller/binding regressions: **53/53**. Pet lifecycle suite: **12/12**, including four added native speech regressions.
- Repository `npm run check`, final pet syntax check and `git diff --check` pass.
- Independent read-only review found no material integration defect; a constructor-exception edge was handled and regression-covered before the final suite.
- No real microphone, browser permission, mobile viewport, Cloudflare-proxied site, model API, Linux/container or physical-device result is claimed for this continuation.
