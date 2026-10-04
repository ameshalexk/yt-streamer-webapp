# One source, two deployments

`main` is the shared application source for `stream.ameshalex.com` on the Mac
and `streamha.ameshalex.com` on the HAOS Pi. Hosts retain separate libraries,
accounts and configuration. A code release does not synchronize their data.

## Pipeline

Every pull request and push to main runs **Shared release**:

1. Node 22 syntax and complete regression suites on macOS and Ubuntu, including
   isolated HTTP/media tests and platform storage/persistence tests.
2. Home Assistant option/packaging tests and release integrity tests; the Mac
   native audio helper is compiled on macOS without accessing an audio device.
3. Mac and HA bundles built from one exact application commit, with checksums,
   a manifest and embedded `release.json` identifying that commit.
4. Native amd64 and aarch64 HA container builds, health/revision/configuration,
   FFmpeg fixture generation and persistent-volume survival checks.
5. **Both platforms passed** fails if any required job fails or is cancelled.

The HA build defaults retain the last reviewed standalone source pin. The
release packager replaces both APP_REF pins and the add-on version in generated
artifacts; it never advances a host behind the user's back.

## Publish a release

From GitHub Actions, run **Shared release** on **main** with **publish** checked,
or use:

```sh
gh workflow run shared-release.yml --repo ameshalexk/yt-streamer-webapp --ref main -f publish=true
```

After all checks pass, GitHub publishes `shared-<full SHA>` with both bundles,
`manifest.json` and `SHA256SUMS`. No SSH, HA or OAuth secrets are needed by CI.
Publishing runs on main only. A tag/release already present is not overwritten.
For local inspection: `python3 scripts/package-release.py --ref HEAD --output /tmp/yt-release`.
Packaging alone does not certify a passing pipeline.

## Coordinated rollout

Download all four assets from the same release and verify SHA256SUMS before
extracting either bundle. Record the manifest SHA in the rollout report.
Check both hosts for active streams, browser sessions and APNE/download jobs;
wait until idle. Back up Mac application code and take an HA backup containing
`local_yt_streamer` before any update. Keep both previous versions available.

Mac: extract `webapp/`, run `npm ci` there, then its
`scripts/deploy-runtime.sh`. This preserves runtime `data` and the signed native
helper identity. Restart only the `com.ytstreamer.webapp` LaunchAgent. The launchd
configuration, OAuth values and public tunnel are not part of a release.

HA: extract `ha-addon/` into a staging folder, copy its files (including
`release.json`) into `/local_apps/yt_streamer`, and run `ha apps reload`.
Rebuild/update only `local_yt_streamer` through Supervisor. The generated Dockerfile
fetches the same application SHA as the Mac bundle. Preserve `/data` and all
existing Supervisor options; do not uninstall the app to update it.

Check local `/api/health` on both hosts: `release.revision` must equal the release
manifest SHA, and `release.platform` must be `darwin` / `linux` respectively.
Then check the authenticated public URLs through the owner's Chrome profile and
exercise the affected flows, including video/audio when applicable. Record
**tested**, **installed** and **verified** separately for each host. If either
host fails, halt rollout and restore the previous code/package on the changed
host(s); never claim the pair is synchronized until both revisions agree.

## Rollback and limits

Mac rollback restores the previous application code and dependencies while
preserving runtime data and native helper identity, then restarts its LaunchAgent.
HA rollback reinstalls the prior packaging/source pin and rebuilds the app while
retaining `/data`. If a change migrates stored data, assess backward compatibility
before rollout and restore the pre-upgrade data backup only when required.
Backup restore must be reported as untested until exercised.

CI uses synthetic local media and isolated state. It does not prove third-party
YouTube/APNE availability, physical Tesla playback, Mac privacy permissions,
real microphone/capture behavior, signed-in public playback, or Raspberry Pi
performance. Validate the affected external/platform behavior during rollout.
Browser/iCloud features remain Mac-specific. The pipeline publishes tested
artifacts; live rollout remains a deliberate coordinated operation.
