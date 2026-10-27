# TeslaMon pause on wake — 2026-10-27

Every accepted wake phrase now requests `pause` through the existing same-tab
`YTStreamerMediaAgent` before starting the normal command capture. This replaces
temporary HTML media volume reduction and uses the player pause path for all
supported playback modes. Already-paused playback stays paused. Voice cleanup,
silence, cancellation, and microphone-off do not resume playback; an explicit
play/resume command can still do so. Wake detection and transcription are unchanged.

The wake handler awaits the pause request before starting capture; idle or
unavailable playback does not block the existing microphone flow.

Changed `public/teslamon-pet.js`, `public/teslamon-handsfree.js`, and their cache
versions in the pet import and `public/index.html`.
Based on consolidated main `d1ae37ce889f112dc929f42ecf8dddd22d8612c9`.

Tests and browser/device checks were intentionally not run at the user's request.
No merge or deployment is authorized by this implementation request. Deployment
still requires the user's go-ahead and the existing shared release workflow.
Physical iPhone/Tesla behavior remains unverified.

Rollback: revert the pause-on-wake commit and ship through the normal shared
release process, or restore the pre-release host backup after deployment.
