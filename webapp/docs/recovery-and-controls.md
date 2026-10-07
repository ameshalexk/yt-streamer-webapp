# Recovery and everyday controls

Playback recovery samples buffered MJPEG rendered frames, the WebCodecs clock,
and separate audio progress. A video stall lasting 15 seconds, audio clock stall
lasting 8 seconds with buffered video available, or persistent drift above 1.5
seconds can initiate recovery. Audio-only repair keeps the JPEG queue and rebases
the restarted audio clock. If that fails, recovery reconnects both paths at the
captured playback position. It never switches the video transport.

A source gets three attempts with 1/3/8-second delays; 60 seconds of healthy
playback restores the budget. Pause, background, offline state, end of media and
browser autoplay restrictions suppress automatic recovery. Stop/source changes
cancel stale retries. Startup failures and premature buffered EOF use the same
budget. Legacy image MJPEG lacks per-frame telemetry, so it recovers reported
errors/startup failures rather than claiming to detect every frozen image.
Intentional silent scenes are not treated as failures.

Resume reopens the newest unfinished history entry (or resumes a paused current
stream). Favorites, Search/Browse and Downloads open existing accordion panels;
none of these controls replaces the media elements. Storage is under Downloads;
YouTube tool diagnostics and a real extraction canary are under Stream settings.

Storage cleanup defaults off. Enabling it permits a separately previewed,
confirmed cleanup of watched processed downloads older than the chosen retention.
It does not start a background deletion schedule. Applying requires the precise
previewed IDs and an idle server. Pinning, marking watched, policy writes and
cleanup serialize; new media/download requests are held while cleanup runs.
Original APNE files, regular library files, iCloud exports and history stay out of
cleanup scope. Natural processed playback completion or an explicit Mark watched
records a completion timestamp; opening or stopping a video does not.

Local automated media/API tests use synthetic fixtures and temporary data.
Chrome tests and live YouTube extraction are distinct from physical Tesla,
public authentication and Pi performance acceptance.
