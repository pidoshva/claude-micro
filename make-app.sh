#!/bin/bash
# Builds ClaudeMicro.app -- a minimal wrapper whose only job is to give the
# daemon a stable identity for macOS Input Monitoring.
#
# Opening a HID keyboard interface requires Input Monitoring. A process spawned
# by launchd has no grant and cannot prompt for one, so it must be granted
# ahead of time -- and a grant needs something specific to attach to. Pointing
# the LaunchAgent at a bare `node` would mean granting keystroke access to
# every script node ever runs, and the path would break on the next nvm
# upgrade. So: a private hard link to the current node binary, inside a bundle.
#
# Hard link, not a copy: same inode, no extra disk, and it survives nvm
# replacing its own node (which is also what keeps the grant valid).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/ClaudeMicro.app"
EXEC_NAME="claude-micro"
NODE_BIN="${1:-$(command -v node)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found (pass a path as \$1)" >&2; exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ClaudeMicro</string>
  <key>CFBundleDisplayName</key><string>Claude Micro</string>
  <key>CFBundleIdentifier</key><string>com.claude-micro</string>
  <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

if ! ln "$NODE_BIN" "$APP/Contents/MacOS/$EXEC_NAME" 2>/dev/null; then
  echo "(hard link failed -- different volume? falling back to a copy)"
  cp "$NODE_BIN" "$APP/Contents/MacOS/$EXEC_NAME"
fi
chmod +x "$APP/Contents/MacOS/$EXEC_NAME"

echo "built $APP (node: $NODE_BIN)"
