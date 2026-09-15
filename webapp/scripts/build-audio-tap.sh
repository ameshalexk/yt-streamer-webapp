#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/audio-tap/main.m"
APP="$ROOT/native/build/YTStreamerAudioTap.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
mkdir -p "$MACOS"
clang -fobjc-arc -fmodules -framework Foundation -framework CoreAudio "$SRC" -o "$MACOS/YTStreamerAudioTap"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.ameshalex.ytstreamer.audiotap</string>
  <key>CFBundleName</key>
  <string>YT Streamer Audio Tap</string>
  <key>CFBundleDisplayName</key>
  <string>YT Streamer Audio Tap</string>
  <key>CFBundleExecutable</key>
  <string>YTStreamerAudioTap</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAudioCaptureUsageDescription</key>
  <string>YT Streamer captures audio from its dedicated Chrome session so it can send that audio to your remote browser.</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null
echo "$MACOS/YTStreamerAudioTap"
