# YT Streamer shared deployment policy

A request to change YT Streamer targets both `stream.ameshalex.com` (Mac) and
`streamha.ameshalex.com` (Home Assistant Pi), unless the user scopes it otherwise.

- Start from the consolidated `main` branch; use a change branch and PR.
- Keep shared application logic in `webapp/`. Platform differences belong in
  explicit configuration/capability gates and `ha-addon/` packaging.
- Require the **Both platforms passed** workflow check before promotion.
- Run shared regressions on macOS and Linux and container checks on native
  amd64 and aarch64. Add meaningful coverage for changed behavior.
- Package both targets from the same immutable commit using
  `scripts/package-release.py`; never package live libraries, OAuth files,
  browser profiles, or local uncommitted changes.
- Deploy only a release whose workflow passed. Preserve both hosts' runtime
  data, take a scoped rollback snapshot/backup, and check for active jobs first.
- After deployment, compare `/api/health` release revisions on both hosts and
  exercise the affected user flow. Health alone does not prove media playback.
- Report CI-tested, installed, and verified separately for each host. Mac-only
  capture/browser/audio and iCloud features need explicit platform reporting.
- Publishing artifacts does not deploy them. See `docs/SHARED_RELEASE.md`.
