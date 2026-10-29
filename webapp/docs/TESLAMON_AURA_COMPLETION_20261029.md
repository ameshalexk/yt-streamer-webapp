# Aura wake-to-player completion correction

User report: wake correctly entered Aura, but a movie opened behind the overlay
and remained hidden until a tap. The player could be paused or buffering. The
latest requested behavior supersedes the October 28 persistent-standby contract:
an eligible wake opens Aura; task completion returns to the ordinary player;
the next wake opens a new invocation.

## Cause and change

- Aura used actual `playing` evidence as the only automatic exit for media.
  Buffering, errors and non-video outcomes could therefore leave the takeover
  indefinitely. Its wake pause guard could also stay latched when the recording
  snapshot was buffering rather than paused/idle. This matches the report; the
  exact production event ordering was not logged and is not claimed.
- Completed voice actions now close their owning Aura entry, including an
  accepted media handoff. A buffering/failed player remains visible; accepted
  dispatch still is not reported as confirmed video playback.
- The preparation guard ends when capture starts, after pause succeeds. Stale
  player snapshots cannot dismiss capture/transcription. Terminal failure,
  uncertainty, no-speech, recovery and normal completion all release takeover.
- Aura preference On only arms future wakes. The manual Preview control is
  removed. Tap/Escape remains presentation-only, while Mic Off still cancels
  voice. Dismissal never resumes media or disables the wake preference.
- Invocation + entry ownership prevents late A events from closing B. A failed
  voice request clears only its matching voice draft, so the next wake can retry
  without treating the old transcript as a newly typed draft.
- No codec, transport, authentication, planner backend, wake model or HA action
  behavior changes. The existing priority pause fence for obsolete operations
  remains intact. Both deployment targets use the same shared code.

## Verification

- Local syntax checks and complete Node suite: 688/688 pass.
- Actual `streamYoutubeSearchResult` + actual adapter fixture proves a completed
  wake pause followed by an explicit movie request hands off buffering media
  once, without a second pause, and permits later frame evidence.
- User's signed-in AMESH Chrome profile, isolated synthetic fixture: wake opens;
  accepted search/play closes Aura with playback still buffering, search/play
  count 1/1, microphone requests 0; planner error closes; next wake can play.
- Classic/New overlay measurements at widths 320/375/390/430/768/844: full frame
  coverage, zero horizontal overflow. This is Chrome viewport testing, not real
  iPhone Safari or Tesla acceptance.
- Expanded composed browser regression covers repeated wakes, terminal results,
  voice retry, no speech, stale A/B, visual dismissal and no keyboard/mic access.
  Its automated execution is required by shared CI. CI now also runs the existing
  12-scenario mobile-player check on both platforms.
- Independent source review found no material issue. Exact release publishing,
  installation, backups and host health are recorded in canonical Obsidian notes;
  this source document does not itself certify deployment.

## Rollout acceptance

Use the exact merged/published SHA after Both platforms passed. Preserve both
hosts' data/options and the signed Audio Tap helper; back up and wait for idle
before installation. Verify each live revision and served asset cache marker.
Real-device check: wake, request a movie, confirm Aura disappears without a tap,
player becomes visible and video/audio starts; repeat another wake and task.
Record any source/autoplay failure separately from overlay lifecycle.
