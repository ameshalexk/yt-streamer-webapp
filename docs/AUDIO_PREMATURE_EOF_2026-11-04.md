# WebCodecs premature audio EOF recovery — prepared, NOT deployed

Date: 2026-11-04. User requested code fix and Obsidian note; no deployment.

## Evidence
Captured player/source diagnostics from the reported ~11:25 silence event
show the audio track ending about 97 seconds before video, while video kept
moving. The original FFmpeg stderr was unavailable, so why the audio was
truncated upstream is not proven.

The player could treat audio as complete while continuing silent video.
The baseline also contained a browser timer-binding bug (Illegal invocation)
that stopped scheduled retries. Include the same browser-safe timer wrapper
identified in the playback-speed work.

## Prepared change
- Detect premature terminal audio only once decoded samples have drained,
  with seek offset, rate, AAC end tolerance and reliable video-end evidence.
- Exclude mute, pause, stop, external audio, startup, normal media tails.
- Send true premature EOF through the existing bounded reconnect path,
  keeping playback position and sound preference.
- Include cache-busting and diagnostic evidence.
- This branch retains the three-attempt recovery budget. Separate draft
  PR #138 proposes continuous retry; the overlapping changes require
  careful reconciliation before any release.

## Verified
- Focused audio-scheduler tests 14/14 PASS, including realistic source
  offset and negative boundary scenarios.
- Local loopback Chrome full WebCodecs **10/10 PASS**, Classic/New at
  widths 320/375/390/430/768. Synthetic 8-second DASH video with
  only two seconds of audio triggered a new session from about four
  seconds in all ten cases, with quality touch target and overflow checks.
- Full Node/syntax checks and PR CI must pass before promotion.
- Physical iPhone/Tesla hardware and upstream FFmpeg cause not verified.

No merge, publication, service restart or production deployment authorized.
