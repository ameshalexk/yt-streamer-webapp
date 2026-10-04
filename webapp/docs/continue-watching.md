# Continue Watching

History shows **Resume** and the saved timestamp for partially watched on-demand videos. **Start over** resets saved progress immediately when the new viewing session is recorded. Videos marked Watched start at the beginning when played again. Live streams do not record a resume point.

Progress saves every five seconds and on pause, stop, switching videos, completion, backgrounding, and page exit. Exit/background saves use fetch keepalive; abrupt browser/device termination can lose the most recent unsaved seconds. Saving progress does not increment the play count or move the History entry to the top.

The shared player passes one resume timestamp to both the video and separate audio requests. Seeking and changing quality retain the viewing session. A fresh playback session gets a new ID; stale-session and out-of-order progress updates are rejected. Newer updates may move backward after a seek.

Positions are finite nonnegative seconds, bounded by a known duration. Completion means at least 98% watched or within five seconds of the end for media longer than ten seconds. Missing duration does not prevent progress saving; live/unseekable playback is excluded.

API: `POST /api/watch-history` accepts `playbackSessionId` and optional boolean `restartProgress`. `PATCH /api/watch-history/:id/progress` accepts the current `playbackSessionId`, increasing integer `sequence`, numeric `positionSeconds`, optional positive numeric `duration`, and optional boolean `isLive`. Errors return 400 for invalid data, 404 for a missing entry, and 409 for a stale session or sequence.

This implementation targets the current shared MJPEG/MPEG-TS playback paths, including downloaded YouTube items with original source identity. The separate WebCodecs toggle feature needs its own integration with this tracker. Production deployment and physical Tesla acceptance are separate steps.
