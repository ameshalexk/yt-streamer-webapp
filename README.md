# YT Streamer

Self-hosted media streaming stack for playing m3u8/IPTV streams, YouTube links, and downloaded videos in a browser, with a Tesla-friendly web UI and optional Home Assistant integration files.

The main app lives in `webapp/`. It runs a local Node/Express server, uses `ffmpeg` for live transcoding, uses `yt-dlp` for YouTube metadata/download/stream resolution, and serves a touch-oriented single-page player.

## What is in this repo

```text
.
├── webapp/                  # Node webapp, API, player UI, deploy helpers
│   ├── src/                 # Express server, store, catalog, ffmpeg/yt-dlp wrappers
│   ├── public/              # Browser UI
│   ├── deploy/              # launchd and Cloudflare Tunnel examples
│   └── data/                # Runtime data if present; ignored by git
├── config_flow.py           # Home Assistant custom integration setup flow
├── coordinator.py           # Home Assistant stream/download coordinator
├── views.py                 # Home Assistant HTTP views
├── services.yaml            # Home Assistant service definitions
├── manifest.json            # Home Assistant integration manifest
└── TROUBLESHOOTING_SAVED_STREAMS.md
```

## Features

- Browser player optimized for Tesla/limited-bandwidth use.
- Saved playlists and quick-play URLs.
- Built-in IPTV catalog from iptv-org, with country/category browsing.
- Auto-organized saved channels by country and category metadata.
- YouTube support through `yt-dlp`: metadata, playlist import, direct stream resolution, and downloads.
- Live transcoding through `ffmpeg`.
- Primary synced playback path: H.264 + AAC in MPEG-TS via `mpegts.js`.
- Legacy/fallback paths for MJPEG video and MP3 audio.
- Clear `502 Bad Gateway` failure responses when `ffmpeg` cannot produce stream output.
- Optional Cloudflare Tunnel deployment so the local Mac app is reachable at a public HTTPS hostname without opening inbound ports.

## Requirements

- macOS
- Homebrew
- Node.js 18+
- `ffmpeg`
- `yt-dlp`
- `cloudflared` if exposing through Cloudflare Tunnel

Install everything for the webapp:

```bash
cd webapp
bash deploy/setup.sh
```

Manual equivalent:

```bash
brew install ffmpeg yt-dlp node cloudflared
cd webapp
npm install
npm run setup
```

## Run Locally

```bash
cd webapp
npm start
```

Default local URL:

```text
http://127.0.0.1:8099
```

Health check:

```bash
curl http://127.0.0.1:8099/api/health
```

Development mode with Node watch:

```bash
cd webapp
npm run dev
```

Syntax check:

```bash
cd webapp
npm run check
```

## Current Local Deployment

This repo is set up to run from:

```text
/Users/amesh/Desktop/ytstreamerhabkupfin/webapp
```

The durable local webapp service is expected to be managed by this LaunchAgent:

```text
/Users/amesh/Library/LaunchAgents/com.ytstreamer.webapp.plist
```

It should bind to:

```text
127.0.0.1:8099
```

The public Cloudflare Tunnel path used for the deployed app is:

```text
https://stream.ameshalex.com
```

Tunnel config is expected at:

```text
/Users/amesh/.cloudflared/yt-streamer.yml
```

To restart the local LaunchAgent after code changes:

```bash
launchctl unload ~/Library/LaunchAgents/com.ytstreamer.webapp.plist
launchctl load ~/Library/LaunchAgents/com.ytstreamer.webapp.plist
```

Then verify:

```bash
curl http://127.0.0.1:8099/api/health
```

## Configuration

Environment variables are read in `webapp/src/config.js`.

Common variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local bind address |
| `PORT` | `8099` | Local webapp port |
| `DATA_DIR` | `webapp/data` | Runtime data directory |
| `LIBRARY_DIR` | `webapp/data/library` | Downloaded media directory |
| `FFMPEG_PATH` | `ffmpeg` | Override `ffmpeg` binary path |
| `YTDLP_PATH` | `yt-dlp` | Override `yt-dlp` binary path |
| `MJPEG_QUALITY` | `7` | MJPEG quality, lower is better |
| `MJPEG_FPS` | `12` | Default stream FPS |
| `MJPEG_HEIGHT` | `480` | Default stream height |
| `MAX_FPS` | `30` | Maximum selectable FPS |
| `DL_MAX_HEIGHT` | `720` | Max YouTube download/stream height |
| `VIDEO_ENCODER` | `libx264` | Use `h264_videotoolbox` on Mac for lighter CPU |
| `AUDIO_BITRATE_K` | `128` | AAC audio bitrate for MPEG-TS |
| `MAX_STREAMS` | `3` | Concurrent ffmpeg stream cap |
| `CATALOG_TTL_MS` | `21600000` | IPTV catalog cache duration |

For lower CPU usage on macOS:

```bash
cd webapp
VIDEO_ENCODER=h264_videotoolbox npm start
```

## Runtime Data

The webapp stores local state under `webapp/data/` unless overridden:

- `webapp/data/store.json`: playlists and saved items.
- `webapp/data/library/`: downloaded videos.
- `webapp/data/server.log`: LaunchAgent stdout when configured.
- `webapp/data/server.err.log`: LaunchAgent stderr when configured.

Runtime data should stay out of git.

## Cloudflare Tunnel

The app has no built-in authentication and should stay bound to localhost. Expose it through Cloudflare Tunnel rather than binding directly to `0.0.0.0`.

Basic tunnel flow:

```bash
cloudflared tunnel login
cloudflared tunnel create yt-streamer
cloudflared tunnel route dns yt-streamer stream.yourdomain.com
```

Use `webapp/deploy/cloudflared-config.example.yml` as the starting point for ingress config, pointing the hostname to:

```text
http://127.0.0.1:8099
```

## Home Assistant Integration Files

The Python files at the repo root are for a Home Assistant custom integration named `yt_streamer`. They define setup, services, camera/view behavior, and stream/download coordination.

The exposed services are:

- `download_url`
- `play_saved`
- `delete_saved`
- `stop_playback`

See `services.yaml` for service fields.

## Useful Commands

```bash
# Start app
cd webapp && npm start

# Check required binaries
cd webapp && npm run setup

# Syntax-check server files
cd webapp && npm run check

# Check live local service
curl http://127.0.0.1:8099/api/health

# Upgrade YouTube extractor
brew upgrade yt-dlp
```

## Troubleshooting

- If the player opens but no frames arrive, check `webapp/data/server.err.log` and the HTTP response from the stream route. The server is designed to return `502 Bad Gateway` when `ffmpeg` exits before producing output.
- If a channel fails only on VPN, test with VPN off or another exit location. Some stream providers deny specific networks or require headers.
- If the public URL works elsewhere but not on the Mac, check local DNS, Tailscale, or router resolver caching before changing Cloudflare config.
- If frontend changes do not appear, restart the LaunchAgent and hard-refresh the browser. The SPA disables caching for core assets, but the running backend still needs to be restarted for server changes.
- For saved-stream issues, see `TROUBLESHOOTING_SAVED_STREAMS.md`.

## More Detail

See `webapp/README.md` for deeper webapp usage, endpoints, and deployment notes.
