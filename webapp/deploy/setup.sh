#!/usr/bin/env bash
# One-shot local setup for macOS. Installs deps, app packages, and checks tools.
set -e
cd "$(dirname "$0")/.."

echo "==> Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install from https://brew.sh first." ; exit 1
fi

echo "==> Installing ffmpeg, yt-dlp, node, cloudflared (if missing)"
brew list ffmpeg >/dev/null 2>&1   || brew install ffmpeg
brew list yt-dlp >/dev/null 2>&1   || brew install yt-dlp
brew list node >/dev/null 2>&1     || brew install node
brew list cloudflared >/dev/null 2>&1 || brew install cloudflared

echo "==> Installing npm packages"
npm install

echo "==> Verifying media tools"
npm run setup

echo
echo "Done. Next:"
echo "  1) npm start                 # run the app on http://127.0.0.1:8099"
echo "  2) See README.md 'Cloudflare Tunnel' to expose it on your domain."
