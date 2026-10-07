# yt-dlp extractor resilience

All yt-dlp invocations in `src/lib/ytdlp.js` use `--ignore-config --js-runtimes node` by default. Set `YTDLP_JS_RUNTIME` to an explicitly supported yt-dlp runtime value when the operator has configured a different runtime. The value is passed as one argument and is never interpreted by a shell.

The primary executable remains `YTDLP_PATH` (default `yt-dlp`). If `YTDLP_FALLBACK_PATH` is set, its value is authoritative: a nonempty value chooses that executable, and an explicitly empty value disables fallback selection. When the variable is unset, the app uses `config.dataDir/extractor-backup/bin/yt-dlp` only if that path exists. Extraction operations try the primary first and make at most one fallback attempt, and only for recognized extraction errors. Startup failures, timeouts, malformed output, local IO errors, and ordinary JSON parsing failures do not trigger fallback. Downloads always use the primary executable once; they are never retried because a second attempt could create duplicate files.

Each captured process has a bounded timeout, stdout limit, and stderr limit. Playlist and search extraction use a longer bounded timeout than single-item extraction. Downloads have a six-hour ceiling and a bounded stdout ceiling. Error text exposed to callers is length-limited and redacts URLs and credential-like values.

## Root integration API

`src/lib/ytdlp.js` exports:

- `commonArgs(args)`: prepends `--ignore-config --js-runtimes <configured-runtime>` for all executable paths, including direct consumers such as `processed-library.js`.
- `capture(args, options)`: runs the primary executable with bounded output and timeout and applies the classified, single-attempt extraction fallback policy. It returns captured stdout as text.
- `getExtractorDiagnostics()`: locally probes configured candidate versions and reports only executable basenames, versions, availability, and whether a fallback is configured.
- `selfTestExtractorCandidates()`: performs the same local version probe plus a bounded yt-dlp help invocation using the configured JS runtime. Its `compatibility` result checks local executable/runtime-option compatibility; it does not contact YouTube or establish that extraction currently works.
- `testExtractorPlayback(url)`: an explicit network canary that validates an HTTPS URL on an exact supported YouTube hostname, then runs every configured candidate independently with a 15-second timeout and an 8 MiB JSON-output limit. It validates the parsed stream selection and returns candidate basename, success, source ID, and sanitized error only. It never returns stream URLs or falls back between candidates.

The server may mount the diagnostics and local self-test functions behind its own authorization boundary. The playback canary makes network requests, so expose it only through an explicit operator action (for example, a POST to a protected route with a fixed/test URL). It does not run automatically during startup or diagnostics. A candidate probe or canary never installs, updates, promotes, or rewrites either executable. `YTDLP_FALLBACK_PATH` is an operator-selected override; success does not promote it or change the active primary.

The processed-library extraction capture uses `capture()` and its direct yt-dlp progress/download invocation uses `commonArgs()`. Download processing remains single-attempt and does not use the extraction fallback.

## Retaining a known-working version

Run the operator script only when intentionally installing and playback-testing a pinned version. It creates `PATH/extractors/VERSION` as a venv, installs only `yt-dlp[default]==VERSION` from the official PyPI index, checks the reported version, then performs the same bounded 480p extraction canary. Only after every step passes does it atomically point `PATH/extractor-backup` to that venv. The installed venv stays at its original path so its generated executable shebang remains valid. Existing version directories and retained versions are never deleted; an existing usable version may be canaried again, while an incomplete directory is preserved and rejected. A real file or directory at `PATH/extractor-backup` is never overwritten.

Example CLI:

```sh
python3 scripts/retain-extractor.py \
  --version 2026.08.19 \
  --data-dir /path/to/app-data \
  --test-url https://www.youtube.com/watch?v=jNQXAC9IVRw
```

This command is an explicit operator action. The app does not install, update, or promote a candidate on startup or after a canary.
