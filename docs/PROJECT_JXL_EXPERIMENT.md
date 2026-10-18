# PROJECT: JXL Isolated FFmpeg — Experimental Research

**Status:** Installed locally on the Mac mini; encoding + decoding verified in isolation; NOT deployed, NOT merged.
**Project ID:** `YT-JXL-EXP`
**Parent experiment:** `experiment/jpeg-xl-streaming-20261017` / draft PR [#49](https://github.com/ameshalexk/yt-streamer-webapp/pull/49).
**Installation / safeguards branch:** `project/jxl-isolated-ffmpeg-20261018` (stacked on the parent; draft PR).
**Owner:** YT Streamer. **Last verified:** October 18, 2026.

## Why this separate project exists

The default Mac mini FFmpeg at `/opt/homebrew/bin/ffmpeg` (9.0.2) lacks JPEG XL `libjxl`. The JXL prototype needs a separate encoder that can be removed without modifying the existing MJPEG, WebCodecs, Homebrew, APNE, or deployed streaming service.

The isolated Apple Silicon FFmpeg 9.0.2 comes from conda-forge (Apple `osx-arm64`), whose published build includes `--enable-libjxl`. The environment is standalone, using micromamba **only inside the project folder**. No Conda activation, global shell changes, Homebrew installations/upgrades, production env changes, scheduled jobs, or service restarts were made.

## Installed path, accurate size

```
~/Library/Application Support/YTStreamer-JXL-Experiment/
├── ffmpeg/bin/ffmpeg        # dedicated executable; ffmpeg environment ~409 MiB
├── bin/micromamba          # local environment manager, not on PATH
├── manager/                # emptied temporary package cache
├── downloads/              # installer/archive/logs and explicit package list
└── tests/                  # tiny synthetic encoder samples
```

- **Actual total after package cache cleanup: ~429 MiB**, not the pre-install forecast of ~150–350 MB. The full environment uses ~409 MiB; auxiliary tools/logs ~20 MiB.
- First installation pulled 92 environment packages (~91 MiB compressed); temporary package cache was cleared afterwards.
- Homebrew FFmpeg is unchanged at 9.0.2 and still does **not** have libjxl.
- `JXL_FFMPEG_PATH` must be set to an explicit **absolute executable file**. The experiment never silently selects Homebrew `ffmpeg-full` or the default FFmpeg.

## Start/preflight the isolated encoder (does NOT change any running server)

From the repository's `webapp` directory:

```bash
export JXL_FFMPEG_PATH="$HOME/Library/Application Support/YTStreamer-JXL-Experiment/ffmpeg/bin/ffmpeg"
npm run check
npm test
npm run test:jxl-real
```

`npm run test:jxl-real` starts **only a temporary, localhost-only HTTP test server**, feeds real `libjxl`-encoded frames through the actual `streamJxl` implementation to local Chrome, and checks canvas pixels. It does **not** launch or alter production.

Do not add `JXL_FFMPEG_PATH` to global shells/launchd or production configuration without a new approval. Leave the production service and URLs untouched.

## Installation strategy (documented, not a deployment script)

- Download the official osx-arm64 micromamba distribution from `https://micro.mamba.pm/api/micromamba/osx-arm64/latest`.
- Extract only `bin/micromamba` into the project-specific `bin/` directory.
- Use `MAMBA_ROOT_PREFIX="$ROOT/manager"` and `"$ROOT/bin/micromamba" create -y -p "$ROOT/ffmpeg" -c conda-forge --strict-channel-priority 'ffmpeg=9.0.2'`.
- Verify `"$ROOT/ffmpeg/bin/ffmpeg" -hide_banner -encoders` lists `libjxl` and `-decoders` lists `libjxl`.
- Run `"$ROOT/bin/micromamba" clean --all --yes` (after recording the explicit package list) to remove project-local downloads/cache; recheck encoder after cleanup.

**Supply-chain note:** Packages originate from conda-forge, not an unknown third-party binary bundle. This is a fully separate FFmpeg environment, but it isn't one statically linked FFmpeg file: its `lib/` libraries must remain installed together.

## Test evidence

- Dedicated FFmpeg's encoder and decoder both report `libjxl`.
- Actual native encoder: 12 independent 640×360 JPEG XL frames generated from FFmpeg's `testsrc2` at 6 FPS and emitted with `tee`/`image2pipe` + `framecrc`. Sum of 12 frame-index packet lengths = 151455 bytes = exact encoded byte stream length.
- Native JXL encode→decode via same experimental FFmpeg: PASS.
- Browser/HTTP integration: **8/8 genuine FFmpeg-created JXL frames** rendered in local Mac Chrome from `streamJxl`; canvas test pixel passed. Does not prove real YouTube stream, Tesla compatibility, audio/seek, or target 720p performance.
- Existing MJPEG and WebCodecs production paths not modified.
- Tesla's browser must pass the experimental client JXL decoder probe; no WASM fallback yet.

## Easy rollback, in correct order

1. This project has NOT been deployed, so there is currently **nothing to revert in production**.
2. If a future separate experiment server is launched, stop **only that process** and remove its `JXL_FFMPEG_PATH` configuration.
3. To remove the isolated package environment, from a terminal:

```bash
ROOT="$HOME/Library/Application Support/YTStreamer-JXL-Experiment"
export MAMBA_ROOT_PREFIX="$ROOT/manager"
"$ROOT/bin/micromamba" env remove -p "$ROOT/ffmpeg" --yes
# The remaining tools/downloads/tests are inside $ROOT; inspect contents
# and delete this one dedicated project directory if no longer needed.
```

4. Close the stacked draft PR / delete `project/jxl-isolated-ffmpeg-20261018` when finished; optionally close parent JXL PR #49 if abandoning JPEG XL completely. Neither changes existing `main` unless explicitly merged.
5. Verify `/opt/homebrew/bin/ffmpeg -version` and the main YT Streamer health endpoint. No Homebrew rollback is required.

## Acceptance gates before even proposing production

- Benchmark CPU/RAM/thermal load on the M1 Mac mini and memory pressure during normal streaming.
- Test real YouTube 480p/720p: video, audio sync, pause, seek, cancellation, concurrent stream constraints.
- Check iPhone and the parked Tesla browser; if native decoding fails, keep MJPEG fallback. Do not promise WASM compatibility without a separate implementation and measurement.
- Preserve MJPEG and WebCodecs regression tests and the unaffected shared Mac/HA release.
- Obtain explicit user approval before merging either draft PR, changing launchd, exposing an experimental URL, or deploying.
