# YT Streamer on Home Assistant OS

This add-on runs the same Node webapp as the Mac deployment, pinned to the
consolidated main commit `54c513413958c8ef723e92dc7ca02689589cb074`. It downloads
that public GitHub source at build time; there is no separate fork or duplicated
application implementation.

Supported hosts: 64-bit Raspberry Pi Home Assistant OS (`aarch64`) and `amd64`.
The add-on must be built on the host; the first installation takes several minutes.

## Install from the reviewed packaging revision

Until the add-on is merged, install it as a local add-on. In the existing
Terminal & SSH add-on, run:

```sh
set -eu
# Reviewed immutable packaging revision; APP_REF below pins the application.
SOURCE_REF=26b9f804041439111df658a841fcc789f5deac73
STAGING="$(mktemp -d)"
curl -fL "https://codeload.github.com/ameshalexk/yt-streamer-webapp/tar.gz/${SOURCE_REF}" -o "$STAGING/source.tar.gz"
tar -xzf "$STAGING/source.tar.gz" -C "$STAGING"
ha backups new --name yt-streamer-pre-install
mkdir -p /local_apps/yt_streamer
cp -R "$STAGING"/yt-streamer-webapp-*/ha-addon/. /local_apps/yt_streamer/
ha apps reload
ha apps install local_yt_streamer
ha apps start local_yt_streamer
ha apps info local_yt_streamer
```

Open `http://homeassistant.local:8099` (currently `http://192.168.50.94:8099`). Verify:

```sh
curl -f http://homeassistant.local:8099/api/health
```

Once merged to the default branch, add
`https://github.com/ameshalexk/yt-streamer-webapp` under **Settings → Add-ons →
Add-on Store → Repositories**, then install **YT Streamer** from that repository.
Enable **Start on boot** and **Watchdog** in the add-on page.

## Publish streamha.ameshalex.com

In the Cloudflare Tunnel that runs on the Home Assistant host, add a public
hostname with these values:

- Hostname: `streamha.ameshalex.com`
- Service type: HTTP
- Service URL: `homeassistant:8099`

For a locally managed Cloudflare add-on using `additional_hosts`, the entry is:

```yaml
additional_hosts:
  - hostname: streamha.ameshalex.com
    service: http://homeassistant:8099
```

Append it to the existing list. A remotely managed tunnel uses its dashboard
instead. The tunnel must run on the Pi to remain available when the Mac is off.
The app has no built-in login; use Cloudflare Access for this hostname. Its direct
port is for the trusted LAN only; do not forward port 8099 on the router.

Authenticate through Cloudflare Access using the emailed one-time code first.
The configured session lasts 30 days (user-confirmed October 3, 2026); an
unauthenticated redirect is expected. After signing in, verify
`https://streamha.ameshalex.com/api/health` and the normal player.
The Mac hostname continues to point to its existing service.

## Features and data

IPTV, YouTube resolution/downloads, saved playlists, downloaded media playback,
and FFmpeg streaming run locally on the Pi. The initial settings limit streaming
to one session, with 480p downloads and 12 FPS MJPEG to suit a Raspberry Pi 4.
Actual performance depends on the source and playback mode.

Mac desktop capture/control, the Mac real-Chrome remote browser and Core Tap
browser audio, Mac launchd restart controls, and iCloud exports are unavailable
on this host. Chromium is not bundled, so the Browser tab is also unavailable.
The APNE workflows that depend on remote Chrome cannot run here. This is a
Linux deployment of the existing app, not a Linux replacement for those features.

The add-on stores playlists, downloads, and other runtime state in its persistent
`/data` directory. APNE export files use `/data/apne-exports`, and OAuth tokens
use `/data/youtube-oauth.json`. Data starts fresh; sharing a GitHub commit does
not synchronize libraries, accounts, or playlists between machines. Use the
add-on's HA backup support to retain its data. No HA token, config mount, Docker
socket, or privileged host access is required.

## Updates and rollback

Use an immutable commit SHA in `build.yaml` → `args.APP_REF` and in the
Dockerfile default. Bump `config.yaml` → `version` when changing the application
or packaging. Deploy the same application SHA to the Mac to keep both on the
same version. Neither host automatically changes branches or pulls code.

From the Terminal & SSH app, copy the updated packaging files into
`/local_apps/yt_streamer`, run `ha apps reload`, then rebuild/update using the
add-on page. Take a backup before upgrading. To roll back, restore the previous
packaging and SHA, rebuild, and restart; preserve `/data`. To disable this
deployment, stop the add-on and remove only the `streamha` tunnel hostname.
