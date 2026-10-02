# Changelog

## 2.1.0-ha.3

- Use fully qualified build image names accepted by current Home Assistant Supervisor.

## 2.1.0-ha.2

- Support the Alpine base image injected by Home Assistant Supervisor on ARM64.
- Correct the current Terminal & SSH local app repository path and reload command.

## 2.1.0-ha.1

- Package the October 1 application commit for aarch64 and amd64 Home Assistant OS.
- Persist runtime data in `/data` and use conservative Raspberry Pi defaults.
- Document the separate `streamha.ameshalex.com` Cloudflare Tunnel route.
