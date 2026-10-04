# Changelog

## 2.1.0-ha.4

- Pin consolidated main application commit `54c513413958c8ef723e92dc7ca02689589cb074`, including native audio FIFO cancellation.
- Install pinned yt-dlp default extras for the challenge solver.
- Validate Supervisor options and correct local installation/update instructions.

## 2.1.0-ha.3

- Use fully qualified build image names accepted by current Home Assistant Supervisor.

## 2.1.0-ha.2

- Support the Alpine base image injected by Home Assistant Supervisor on ARM64.
- Correct the current Terminal & SSH local app repository path and reload command.

## 2.1.0-ha.1

- Package the October 1 application commit for aarch64 and amd64 Home Assistant OS.
- Persist runtime data in `/data` and use conservative Raspberry Pi defaults.
- Document the separate `streamha.ameshalex.com` Cloudflare Tunnel route.
