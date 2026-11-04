#!/bin/sh
# Runs the orchestrator as a macOS launchd agent: starts at login, restarts if it crashes.
#   scripts/launchd.sh install     build, write the plist, load it
#   scripts/launchd.sh uninstall   unload and remove it
#   scripts/launchd.sh print       print the plist without installing it
# launchd stops the agent with SIGTERM, which the server handles like Ctrl+C:
# it stops live Claude sessions and closes the database before exiting.
set -eu

LABEL=com.ai-orchestrator
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)

plist() {
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/apps/server/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- The Agent SDK starts Claude Code with node, so node must be on PATH. -->
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <!-- App logs go to logs/orchestrator.*.log; this only catches crashes before the logger starts. -->
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd-stderr.log</string>
</dict>
</plist>
XML
}

case "${1:-}" in
  print) plist ;;
  install)
    (cd "$ROOT" && pnpm build)
    mkdir -p "$ROOT/logs" "$(dirname "$PLIST")"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    plist > "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed. Check with: launchctl print gui/$(id -u)/$LABEL | grep state"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed."
    ;;
  *) echo "usage: $0 install|uninstall|print" >&2; exit 2 ;;
esac
