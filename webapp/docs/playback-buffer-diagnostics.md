# Periodic playback buffer diagnostics

The browser sends a `playback_buffer_sample` event to the existing `/api/playback-event` endpoint at most once every 15 seconds per active stream attempt. This works for buffered MJPEG and WebCodecs. The sample includes the existing whitelisted buffer/queue/throughput/render metrics, transport label, and selected quality mode. This complements the startup, rebuffer and stop summaries.

Sampling begins only after the first rendered frame. User-pause, background tabs, inactive stream attempts, and stopped streams do not send samples. Auto quality switches stay silent; logging has no UI effect. New stream attempts are sampled independently.

Read recent samples locally:

```sh
grep '"event":"playback_buffer_sample"' "$HOME/Library/Application Support/YTStreamerWebapp/data/playback-events.jsonl" | tail -20
```

The server validates logged fields and rotates the playback event log at 5 MiB, retaining one rotated file. Event logs can include private stream URLs and user agents; do not publish them. No new media capture or public diagnostics endpoint is introduced. Real Tesla acceptance remains a separate end-to-end check.
