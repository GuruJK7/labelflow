#!/bin/bash
# Idempotent installer — run on the Mac Mini.
#
# Copies bridge files into ~/labelflow-bridge, patches the plist with the
# real $HOME, loads the LaunchAgent, and verifies the bridge answers /health.
#
# Usage:
#   cd ~/labelflow-bridge-src   # wherever you extracted the files
#   ./install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/labelflow-bridge"
PLIST_DEST="$HOME/Library/LaunchAgents/com.labelflow.claude-bridge.plist"
LABEL="com.labelflow.claude-bridge"

echo "==> Source: $SRC"
echo "==> Install dir: $DEST"

# 1. Sanity checks ──────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || {
  echo "ERROR: node not found in PATH. Install Node 20+ first (brew install node)." >&2
  exit 1
}

if ! [ -x "$HOME/.local/bin/claude" ] && ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude CLI not found at $HOME/.local/bin/claude nor in PATH." >&2
  echo "       Install Claude Code and run 'claude /login' first." >&2
  exit 1
fi

# 2. Copy files ─────────────────────────────────────────────────────────────
mkdir -p "$DEST"
cp "$SRC/bridge-server.mjs" "$DEST/bridge-server.mjs"
cp "$SRC/run.sh" "$DEST/run.sh"
chmod 755 "$DEST/run.sh"
chmod 644 "$DEST/bridge-server.mjs"

# 3. bridge.env — create from example if missing, never overwrite ───────────
if [ ! -f "$DEST/bridge.env" ]; then
  cp "$SRC/bridge.env.example" "$DEST/bridge.env"
  chmod 600 "$DEST/bridge.env"
  SECRET=$(openssl rand -hex 32)
  # macOS sed requires '' after -i
  sed -i '' "s|REPLACE_WITH_32_BYTE_HEX|$SECRET|" "$DEST/bridge.env"
  echo "==> Generated new secret in $DEST/bridge.env (chmod 600)"
  echo "==> SECRET (copy this into Render worker env as LABELFLOW_BRIDGE_SECRET):"
  echo
  echo "    $SECRET"
  echo
else
  chmod 600 "$DEST/bridge.env"
  echo "==> Keeping existing $DEST/bridge.env"
fi

# 4. Patch + install plist ──────────────────────────────────────────────────
mkdir -p "$HOME/Library/LaunchAgents"
# Patch HOME_PATH placeholder. Use | as sed delimiter because $HOME has /.
sed "s|HOME_PATH|$HOME|g" "$SRC/com.labelflow.claude-bridge.plist" > "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

# 5. Reload LaunchAgent ─────────────────────────────────────────────────────
# bootout may fail if not loaded; that's fine.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "==> LaunchAgent loaded. Waiting 3s for startup..."
sleep 3

# 6. Health check ──────────────────────────────────────────────────────────
PORT=$(grep '^BRIDGE_PORT=' "$DEST/bridge.env" | cut -d= -f2 | tr -d '[:space:]')
PORT=${PORT:-7777}

if curl -sS --max-time 5 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
  echo "==> OK: bridge responded on http://127.0.0.1:$PORT/health"
else
  echo "!! Bridge did NOT respond. Check:"
  echo "   tail -50 $DEST/bridge.log"
  echo "   tail -50 $DEST/bridge.err"
  echo "   launchctl print gui/$(id -u)/$LABEL"
  exit 1
fi

# 7. Tailscale hint ─────────────────────────────────────────────────────────
if command -v tailscale >/dev/null 2>&1; then
  TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
  if [ -n "$TS_IP" ]; then
    echo "==> Tailscale IP: $TS_IP"
    echo "    Set on Render: LABELFLOW_BRIDGE_URL=http://$TS_IP:$PORT"
  else
    echo "==> Tailscale installed but not logged in. Run: sudo tailscale up"
  fi
else
  echo "==> Tailscale NOT installed. Install: brew install tailscale"
fi

echo
echo "==> Install complete."
