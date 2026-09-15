#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${YT_STREAMER_RUNTIME:-$HOME/Library/Application Support/YTStreamerWebapp}"

mkdir -p "$RUNTIME"

# Runtime state is intentionally never mirrored or deleted here.
# The source repo may expose data as a symlink to the live runtime.
rsync -a \
  --exclude='.git/' \
  --exclude='data' \
  --exclude='native/build/' \
  "$ROOT/" "$RUNTIME/"

cd "$RUNTIME"
node --check src/server.js
node --check src/lib/browser-audio-capture.js

HELPER_SOURCE="$RUNTIME/native/audio-tap/main.m"
HELPER_BUILD_SCRIPT="$RUNTIME/scripts/build-audio-tap.sh"
HELPER_BIN="$RUNTIME/native/build/YTStreamerAudioTap.app/Contents/MacOS/YTStreamerAudioTap"
if [[ ! -x "$HELPER_BIN" || "$HELPER_SOURCE" -nt "$HELPER_BIN" || "$HELPER_BUILD_SCRIPT" -nt "$HELPER_BIN" ]]; then
  scripts/build-audio-tap.sh >/dev/null
  echo "YT Streamer Audio Tap rebuilt because its native source changed."
else
  echo "YT Streamer Audio Tap binary preserved (privacy identity unchanged)."
fi

echo "YT Streamer runtime updated safely at: $RUNTIME"
echo "Runtime data was left untouched."
