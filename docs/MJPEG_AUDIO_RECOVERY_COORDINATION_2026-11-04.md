# MJPEG audio startup and recovery coordination

Status: fully tested locally; shared GitHub CI pending; no deployment authorized.

Base: shared main `6bf567e4c807da9b6a8c34dd8c75acd95155326b`.
Branch: `fix/mjpeg-audio-recovery-20261104`.

## Reported failure and evidence

The deployed Mac player recorded iPhone Safari playing YouTube video
`g6Die8gVFn0` using buffered MJPEG with separate MP3 audio. On November 4,
2026 at approximately 9:33–9:34 PM America/Chicago:

- Audio repeatedly failed the 4.5-second `HAVE_FUTURE_DATA` readiness gate.
- Video reached the full six-second queue while audio readiness and audio
  playback-start milestones remained unset.
- The local audio loader and the general playback recovery monitor both
  scheduled repair. Local repair stopped video rendering while loading audio.
- At 9:34:17 PM the old local three-retry handler displayed “Sound unavailable ·
  video continues silently. Tap Retry audio.” The continuous global retry
  policy did not remove that separate local retry limit.
- At 9:34:36 PM the video reader reported “Load failed.” The error path cleared
  the picture; that is consistent with the supplied black-player screenshot.

These logs establish the failure sequence and coordination problem. They do
not establish whether the original audio stall began upstream, in the proxy,
or in Safari. In particular, media error code zero is not an autoplay-denial
diagnosis.

The startup sequence also waited for future audio data before requesting
playback. Apple documents media preloading as browser controlled and playback
as subject to user-interaction policy. This makes a readiness/gesture cycle
plausible, without proving it caused this particular incident. References:
[Safari media delivery](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari)
and [archived iOS media policy](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html).

## Design constraints

- Keep MJPEG video, separate audio, source identity, watch position, mute,
  Pause/Stop/visibility/offline cancellation, and desktop/Tesla behavior.
- Use one capped-backoff recovery owner and one active audio load per player.
- Request audio playback without waiting for a preloading readiness event;
  handle browser gesture denial explicitly without an automatic reload loop.
- Keep useful video rendering while audio transport reconnects, and align
  actual playable audio to the current video position before switching clocks.
- Keep recoverable video failures distinct from audio faults. Preserve the
  last picture while reconnecting and show truthful status.
- Retain scalar client media-state and server first-output/byte/termination
  evidence, never raw audio, signed source URLs, credentials, or FFmpeg stderr.

## Verification

- `npm run check` passed; `npm test` **751/751** passed, including
  aligned audio repair, Pause/visibility cancellation, audio transport
  telemetry, and buffered video playback state.
- `node scripts/mobile-player-browser-check.mjs` **12/12** Classic/New
  responsive layouts passed.
- `node scripts/mjpeg-audio-coordination-browser-check.mjs --automated
  --deep-only` passed **10/10** local generated-media recovery scenarios:
  slow audio readiness, pause/hidden repair cancellation, unlimited capped
  audio retries without opening another video connection, autoplay gesture
  denial, video fetch reconnection, and stop/source-switch cancellation.
- Regression discovery: the startup priming callback could pause audio a
  second time when `canplay` arrived as buffered video started. We now prime
  once per source and only report sound synchronized once both clocks play.
- Full `node scripts/mjpeg-audio-coordination-browser-check.mjs --automated`
  passed **32/32** generated-media Classic/New browser cases across 12
  responsive layouts and 20 deep recovery cases. Source hashes remained
  unchanged throughout. Evidence: `docs/evidence/mjpeg-audio-coordination-20261104.json`.
- Shared GitHub CI is a separate release gate. Physical iPhone Safari and
  Tesla testing are still pending;
  a generated Chrome fixture cannot prove Safari's original stall was fixed.
- Browser verification distinguishes automated Chrome fixtures from the
  existing signed-in Chrome profile and real-device acceptance.

## Release boundary

No merge, shared release publication, production install, or restart is
authorized by this fix preparation. Both deployed hosts remain on the base
release. After an approved future deployment, verify at least fifteen minutes
of audible playback, audio reconnect, video reconnect, Pause/Resume and source
switch on physical iPhone/Tesla. Reuse scoped per-host rollback procedures and
preserve each host's data and native helper.
