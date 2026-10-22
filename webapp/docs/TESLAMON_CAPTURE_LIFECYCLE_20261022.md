# TeslaMon TM-302: isolated capture lifecycle

This branch owns only the new capture module, fake-media unit tests, and this
handoff. It starts from consolidated main at
`1703926f2d54adb403dd38daef503dcd31a1f1b0`. Runtime/private MCP work remains
owned by the separate chat and branch. No shared player, relay, server, auth,
package, or release files are changed.

## Scope and boundaries

The module is an unmounted building block for future push-to-talk integration.
Creating or importing it must not request microphone access. Tests inject fake
media streams, recorder implementations, and timers; they do not capture audio.
No transcription provider, upload, model call, persistent audio storage, or
playback command is included.

The future UI owner must attach deliberate press/release events and cancellation
on pointer loss, page hide, target/session changes and teardown. A dedicated drag
handle must never invoke capture. Browser permission must come from an explicit
user action. The future authenticated STT boundary must independently validate
MIME, duration and size and delete transient audio on cancellation.

## Verification and remaining gates

Run from the repository root:

```
node --check webapp/public/teslamon-capture.js
node --test webapp/test/teslamon-capture.test.mjs
```

Run `npm run check` from `webapp/` for the existing source syntax suite.
These checks are local macOS fake-media evidence only. The shared Both platforms
passed CI gate is required before promotion; Linux/container results are separate.
TM-002 device/STT/topology feasibility and real TM-302 integration remain open.
A nonempty audio Blob is not proof of speech or successful transcription.

There is no rendered UI change, so no viewport or browser acceptance is claimed.
When mounting this module, test Classic/New at 320/375/390/430 CSS px, iPad and
mobile landscape with 44px controls, safe areas and player/Quality access.
Chrome emulation is separate from real iPhone Safari and parked Tesla testing.
No production deployment or real-device acceptance has occurred.

## Rollback

Keep the module unmounted until integration gates pass. Revert the capture commit
to remove this isolated addition; no runtime data or production configuration
requires restoration.

## Integration interface

Import `createTeslaMonCapture` from `public/teslamon-capture.js`. Supply
`getUserMedia`, `MediaRecorder`, and optional timer/callback dependencies.
`start()` returns a promise indicating whether recording started; `release()`
ends a successful recording. `cancel()`, `pointerCancel()`,
`lostPointerCapture()`, `pageHide()`, `targetChanged()` and `dispose()` discard it.
The owner must wire these to actual lifecycle events before mounting.

`onState` reports lifecycle states; `onAudio` receives a transient nonempty Blob
only after successful completion; `onError` reports errors. Callbacks must not
persist raw audio or imply transcription success. The controller cannot revoke a
Blob already handed to a consumer, so future STT integration owns an additional
abort signal and target/session validation before and after processing.

Default hard caps are 20 seconds and 5 MiB, configurable only downwards; a bounded
stop-event watchdog clears a hung recorder. MIME metadata checks are defensive
input filtering, not content inspection or proof of valid speech.

Local verification on 2026-10-22: capture tests **27/27 passed**, new module syntax
passed, existing `npm run check` passed, and staged diff whitespace check passed.
Independent source review identified missing chunk MIME validation; it was fixed
and regression-covered before push. No hosted or both-platform CI result is
claimed by these local checks.
