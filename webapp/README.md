# YT Streamer — webapp

A self-hosted web app to **stream m3u8 playlists and YouTube videos as MJPEG** to any browser — built for the Chromium browser in a Tesla. You manage playlists in a touch-friendly UI; the server transcodes any source to MJPEG on the fly with `ffmpeg`, and downloads/expands YouTube with `yt-dlp`.

No accounts, no auth — you are the sole user. It runs on **your Mac** and is published to **your custom domain through a free Cloudflare Tunnel**.

---

## Why this architecture

Cloudflare has **no VPS/VPC** — Workers/Pages are serverless and can't run `yt-dlp` or `ffmpeg` (no native binaries, no persistent process, hard timeouts). The download + MJPEG transcode work needs a real always-on process, so the app runs on your Mac and Cloudflare Tunnel securely exposes it on your domain. Result: **$0 hosting**, full features, and your home broadband's upload speed (almost always faster and lower-latency than a free cloud tier).

```
Tesla browser ──HTTPS──> Cloudflare edge ──Tunnel──> your Mac (Node + ffmpeg + yt-dlp)
                                                         └── m3u8 / YouTube ──MJPEG──┘
```

---

## 1. Install & run locally

Requires macOS with [Homebrew](https://brew.sh).

```bash
cd webapp
bash deploy/setup.sh      # installs ffmpeg, yt-dlp, node, cloudflared + npm deps
npm start                 # http://127.0.0.1:8099
```

Open `http://127.0.0.1:8099` to confirm it works before exposing it.

Manual install instead of the script:

```bash
brew install ffmpeg yt-dlp node cloudflared
npm install
npm run setup             # verifies ffmpeg + yt-dlp are reachable
npm start
```

---

## 2. Publish to your custom domain (Cloudflare Tunnel)

Your domain must already be on Cloudflare (nameservers pointed at Cloudflare). Then:

```bash
# a) Log in (opens browser, pick your domain/zone)
cloudflared tunnel login

# b) Create a named tunnel
cloudflared tunnel create yt-streamer
#    -> prints a Tunnel ID and writes ~/.cloudflared/<ID>.json

# c) Route your chosen hostname to the tunnel (DNS record auto-created)
cloudflared tunnel route dns yt-streamer stream.yourdomain.com

# d) Configure ingress
cp deploy/cloudflared-config.example.yml ~/.cloudflared/config.yml
#    edit it: set the tunnel ID, credentials path, and hostname

# e) Test it
cloudflared tunnel run yt-streamer
```

Visit `https://stream.yourdomain.com` — that's the URL you open in the Tesla.

### Run the tunnel permanently

```bash
sudo cloudflared service install     # runs the tunnel on boot
```

### Run the app permanently (so it survives reboots/crashes)

```bash
# edit the node path + project path inside the plist first (which node)
cp deploy/com.ytstreamer.webapp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ytstreamer.webapp.plist
```

Now both the app and the tunnel start automatically — leave the Mac on and awake (System Settings → Battery/Energy → prevent sleep, or `caffeinate -s`).

---

## 3. Using it from the Tesla

Open `https://stream.yourdomain.com` in the car browser, then:

- **Playlists** (left): create lists like “Road Trip”, “News”, “Live Cams”.
- **Add** (middle, `+ Add`) supports four sources:
  - **M3U8 / Live** — paste any `.m3u8` or stream URL.
  - **YouTube link** — saved as a reference; the stream URL is re-resolved fresh on each play (nothing stored).
  - **Download YT** — downloads the video to your Mac's library (≤720p) and adds it; plays instantly afterward.
  - **Import YT list** — bulk-adds every video from a YouTube playlist/channel as references.
- **Play** — tap any item; it streams into the player on the right.
- **Quick play** — paste a URL in the box to stream immediately without saving.

### 📺 Channels (built-in IPTV catalog)

The **Channels** button (top bar) opens a browser over the free [iptv-org](https://github.com/iptv-org/iptv) catalog of thousands of live channels — no setup, baked in:

- Pick a catalog: **All channels**, any iptv-org country, or by category (News, Sports, Movies, Music, Kids, ...).
- **Search** by name and filter by **group/category**.
- **▶** plays a channel instantly in the main player.
- **+** saves it to your selected playlist (or auto-creates a “Channels” playlist), keeping any required user-agent/referer headers so protected streams keep working.

Catalogs are fetched from iptv-org and cached for 6h (`CATALOG_TTL_MS`). Country choices come from `https://iptv-org.github.io/api/countries.json`; category playlists and catalog endpoints can be adjusted in `src/config.js`, and pasted M3U URLs can still be opened as custom playlists. Note: iptv-org streams are community-maintained — some channels are geo-blocked or occasionally offline; that's the source, not the app.

### Bandwidth controls (important for 4G)

MJPEG is the heaviest format (every frame is a full JPEG — no inter-frame compression), so tune it to the Tesla's connection:

| Control | For 4G / premium connectivity | For strong Wi-Fi |
|--------|-------------------------------|------------------|
| Resolution | 360p–480p | 720p–1080p |
| FPS | 8–12 | 24–30 |
| Quality | Low (4G) / Medium | High |

Changing a control while playing restarts the stream with the new settings. The `~Mbps est.` hint is a rough guide.

### Sound & A/V sync

The player streams **one synced H.264 + AAC stream (MPEG-TS)** played via [mpegts.js](https://github.com/xqq/mpegts.js) (MSE) in the browser — audio and video share one container and one clock, so they're **locked in sync** (no two-stream drift). Toggle sound with **🔊 / 🔇** in the player header. The player chases the live edge to stay low-latency.

This also means much **lower bandwidth than MJPEG** at the same resolution/fps, so higher frame rates (e.g. 30fps) actually hold up on 4G. The Resolution / FPS / Quality controls map to the H.264 encode (scale, `-r`, and CRF + capped bitrate).

**Mac CPU tip:** `libx264` (default) transcodes on the CPU. On a Mac you can switch to the hardware encoder for far lower CPU use:

```bash
VIDEO_ENCODER=h264_videotoolbox npm start
```

mpegts.js is served locally from `node_modules` at `/vendor/mpegts.js` (with a CDN fallback), so run `npm install` once after updating.

---

## Configuration

Override defaults with environment variables (e.g. in the launchd plist or your shell):

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8099` | Local port the app binds |
| `HOST` | `127.0.0.1` | Bind address (keep localhost; tunnel connects here) |
| `MJPEG_QUALITY` | `7` | ffmpeg `-q:v` 2 (best) … 31 (worst) default |
| `MJPEG_FPS` | `12` | Default stream FPS |
| `MJPEG_HEIGHT` | `480` | Default stream height (0 = source) |
| `DL_MAX_HEIGHT` | `720` | Max download/stream resolution |
| `DESKTOP_INPUT_ENABLED` | unset | Set to `1` to enable touch input for the Mac desktop stream |
| `DESKTOP_INPUT_TOKEN` | unset | Optional shared code required before desktop input events are accepted |
| `DESKTOP_INPUT_WIDTH` / `DESKTOP_INPUT_HEIGHT` | auto | Optional coordinate mapping override |
| `MAX_STREAMS` | `3` | Concurrent ffmpeg streams cap |
| `LIBRARY_DIR` | `./data/library` | Where downloads are stored |
| `FFMPEG_PATH` / `YTDLP_PATH` | on PATH | Override binary locations |

Playlists are stored server-side in `data/store.json`. Downloads live in `data/library/`.

---

## Project layout

```
webapp/
  src/
    server.js        Express app: SPA + REST API + MJPEG endpoints
    config.js        All settings (env-overridable)
    lib/
      store.js       Server-side JSON store for playlists/items
      ytdlp.js       yt-dlp wrapper: info, playlist expand, stream URL, download
      stream.js      ffmpeg -> multipart MJPEG transcoder
  public/            Tesla-optimized SPA (index.html, app.js, styles.css)
  scripts/check-deps.js
  deploy/            cloudflared config, launchd plist, setup.sh
```

---

## Endpoints (reference)

```
GET    /api/health
GET    /api/playlists
POST   /api/playlists                       {name}
PATCH  /api/playlists/:id                    {name}
DELETE /api/playlists/:id
POST   /api/playlists/:id/items              {type,url,title}
DELETE /api/playlists/:id/items/:itemId
POST   /api/playlists/:id/import-youtube     {url}
GET    /api/youtube/info?url=
GET    /api/youtube/playlist?url=
POST   /api/download                         {url,playlistId} -> {jobId}
GET    /api/download/:jobId
GET    /api/desktop/input/status
POST   /api/desktop/input                    {type,x,y}
GET    /api/probe?url=
GET    /stream/item/:itemId?height=&fps=&quality=
GET    /stream/url?url=&live=1&height=&fps=&quality=
GET    /stream/youtube?url=&height=&fps=&quality=
```

---

## Notes & limits

- **MJPEG only**, by design — no HLS/audio/fallbacks. MJPEG has no audio track; if you need sound, that's a different transport (ask and it can be added via an `<audio>` side-channel).
- Keep the Mac awake; if it sleeps, streams stop.
- YouTube occasionally changes formats — keep `yt-dlp` current: `brew upgrade yt-dlp`.
- This binds to localhost and is only reachable through your tunnel. Since there's no auth, **don't** add a `0.0.0.0` bind or expose the port directly. If you ever want a lock, Cloudflare Access (free for one user) can gate the hostname.
- Desktop touch input is disabled by default. The app prefers `cliclick` for mouse input and falls back to a generated CoreGraphics helper; whichever executable sends input needs macOS Accessibility permission. Public/tunneled deployments should use Cloudflare Access or `DESKTOP_INPUT_TOKEN`.
```
