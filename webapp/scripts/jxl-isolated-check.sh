#!/usr/bin/env bash
# Diagnostics only. Does not start a persistent stream or modify production.
set -euo pipefail
ROOT="${YT_STREAMER_JXL_ROOT:-$HOME/Library/Application Support/YTStreamer-JXL-Experiment}"
export JXL_FFMPEG_PATH="${JXL_FFMPEG_PATH:-$ROOT/ffmpeg/bin/ffmpeg}"
if [[ ! -x "$JXL_FFMPEG_PATH" ]]; then
  echo "ERROR: Isolated JXL FFmpeg not found/executable: $JXL_FFMPEG_PATH" >&2
  exit 1
fi
echo "JXL experimental executable: $JXL_FFMPEG_PATH"
"$JXL_FFMPEG_PATH" -hide_banner -encoders 2>/dev/null | grep -E '[[:space:]]libjxl[[:space:]]' || { echo "No libjxl encoder" >&2; exit 1; }
"/opt/homebrew/bin/ffmpeg" -hide_banner -version | sed -n '1p'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
node scripts/jxl-real-smoke.mjs
echo "JXL real FFmpeg / browser smoke PASS; production untouched."
