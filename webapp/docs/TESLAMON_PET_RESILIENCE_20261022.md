# TeslaMon pet lifecycle resilience

Continuation of the unmerged Mac MVP at `f441210`. Source-only development; TeslaMon remains disabled by default. No deployment, microphone capture, model API call or physical-device acceptance is part of this change.

## Intended guarantees

- New device refreshes supersede older refreshes. Older replies and errors cannot replace current UI state.
- Browser selection requests are serialized because ignoring an old reply does not undo a server-side selection. Playback commands remain blocked while selection is unsettled.
- Closing, hiding, navigating away or changing the selected target cancels obsolete interpretation and transcription work. Cancellation after a playback command has been sent does not prove the command was cancelled and never triggers a replay.
- Native speech handlers are registered once, with stale session callbacks ignored. Capture bindings can be recreated after page restoration.

## Verification boundary

Offline lifecycle and pet integration regressions use synthetic DOM, speech and deferred fetch responses. They do not establish real Cloudflare authentication, microphone permission behavior, iPhone/Tesla acceptance, mobile layout acceptance or release readiness. Existing markup and CSS are preserved.

## Remaining project work

The persistent Codex runtime and enforced six-tool confinement remain outstanding. Capture branch integration, cross-host HA routing, cross-platform CI and release review remain separate. Device acceptance belongs to the owner as requested.

Keep implementation and acceptance as separate tracker fields. The earlier 55 percent figure is a rough engineering estimate, not a release score; this change does not by itself complete a whole backlog story or justify a new percentage.

## Rollback

Revert this feature commit or discard its isolated branch. No runtime state, configuration, recording, credential or persistent command journal is changed.

## Verified result

- Eight offline lifecycle regressions pass, including serial target selection, in-flight picker clearing, late interpretation/transcription after close, stale refresh suppression and fresh authority before reopening commands.
- Final isolated full repository suite: **617/617 passed, 0 failures** on local macOS. The snapshot contains base `f441210` plus only this continuation, excluding concurrent server/contract edits in the original checkout.
- `npm run check`, explicit helper/pet syntax checks and `git diff --check` pass. No shared CI, Linux/container or real-browser/device claim.
- Independent read-only review identified cached authority surviving reopen; root fixed it, added a deferred-refresh regression, and verified the final diff. A worker follow-up failed; root completed the remaining fixes and tests.
- Existing HTML/CSS and player layout are unchanged. No new mobile layout acceptance is claimed; the original required viewport/physical-device matrix remains pending.
