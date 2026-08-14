#!/bin/bash
# Installs claude-micro from this checkout:
#
#   1. copies the daemon, game, and tools into ~/.claude/micro
#   2. copies the companion skills (/btw, /research, /ship) into ~/.claude/skills
#   3. extracts the Work Louder device SDK from your installed ChatGPT.app
#      (the SDK is proprietary and never ships in this repo)
#   4. wires the Claude Code hooks into ~/.claude/settings.json (additive,
#      idempotent, backed up first)
#   5. builds ClaudeMicro.app -- the identity you grant Input Monitoring to
#   6. writes and loads the LaunchAgent that keeps the daemon running
#
# Safe to re-run: it is also how you recover after a ChatGPT.app update (SDK
# re-extract) or a Node upgrade (the plist pins an absolute node path).
# Your existing ~/.claude/micro/config.json is never overwritten.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/micro"
SKILLS="$HOME/.claude/skills"
LABEL="com.claude-micro"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
PY_BIN="/usr/bin/python3"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH" >&2; exit 1; fi
if ! command -v tmux >/dev/null; then echo "tmux not found on PATH" >&2; exit 1; fi
if [ ! -d "/Applications/ChatGPT.app" ]; then
  echo "ChatGPT.app not found in /Applications -- it provides the device SDK" >&2; exit 1
fi

echo "==> copying files into $DEST"
mkdir -p "$DEST/bin" "$DEST/game" "$DEST/actions"
cp "$SRC/daemon.js" "$SRC/cli.js" "$SRC/hook.py" "$SRC/extract-sdk.js" "$SRC/make-app.sh" "$SRC/patch-settings.py" "$DEST/"
cp "$SRC/bin/review.sh" "$DEST/bin/"
cp "$SRC/game/drift.js" "$SRC/game/index.html" "$DEST/game/"
cp "$SRC/README.md" "$DEST/"
if [ ! -f "$DEST/config.json" ]; then
  cp "$SRC/config.example.json" "$DEST/config.json"
  echo "==> wrote default config.json (edit key/knob assignments there)"
fi

echo "==> installing the configurator (claude-micro on your PATH)"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude-micro" <<SHIM
#!/bin/bash
exec "$NODE_BIN" "$DEST/cli.js" "\$@"
SHIM
chmod +x "$HOME/.local/bin/claude-micro"

echo "==> installing skills into $SKILLS"
for skill in btw research ship; do
  mkdir -p "$SKILLS/$skill"
  cp "$SRC/skills/$skill/SKILL.md" "$SKILLS/$skill/"
done

echo "==> extracting device SDK from ChatGPT.app"
"$NODE_BIN" "$DEST/extract-sdk.js"

echo "==> wiring Claude Code hooks into ~/.claude/settings.json"
"$PY_BIN" "$DEST/patch-settings.py"

echo "==> building ClaudeMicro.app (Input Monitoring identity)"
bash "$DEST/make-app.sh" "$NODE_BIN"
APP_EXEC="$DEST/ClaudeMicro.app/Contents/MacOS/claude-micro"

echo "==> writing LaunchAgent ($APP_EXEC)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_EXEC</string>
    <string>$DEST/daemon.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DEST/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DEST/launchd.err.log</string>
  <key>WorkingDirectory</key><string>$DEST</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
sleep 1
launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 \
  && echo "==> daemon loaded" \
  || echo "==> WARNING: daemon did not load; check $DEST/launchd.err.log"

cat <<DONE

Installed. Two manual steps remain -- macOS will not let a script do them:

1. Grant Input Monitoring (HID access is blocked without it, and a launchd
   process cannot ask):

     System Settings -> Privacy & Security -> Input Monitoring -> +
     add:  $DEST/ClaudeMicro.app

   Then:  launchctl kickstart -k gui/\$UID/$LABEL

2. In the ChatGPT app: Settings -> Codex Micro -> leave every key this daemon
   owns UNASSIGNED. The app repaints keys it thinks it owns and will fight
   the daemon for them; unassigned keys are painted off and left alone.

Then run \`claude-micro\` to assign keys and tune colors interactively,
and read $DEST/README.md -- key map, knob, joystick, and the game.
DONE
