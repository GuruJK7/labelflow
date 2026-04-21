#!/bin/bash
# LaunchAgent wrapper for bridge-server.mjs.
# Sources bridge.env (keeps secrets out of the plist) and execs node.
# Exits non-zero on any problem so launchd restarts us.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/bridge.env"
SERVER="$HERE/bridge-server.mjs"

if [ ! -f "$ENV_FILE" ]; then
  echo "[run.sh] FATAL: $ENV_FILE not found" >&2
  exit 1
fi

if [ ! -f "$SERVER" ]; then
  echo "[run.sh] FATAL: $SERVER not found" >&2
  exit 1
fi

# Require the env file to be owner-only (0600). LaunchAgents run as the user
# so group/other bits being open would be a smell — bail rather than expose.
PERMS=$(stat -f '%A' "$ENV_FILE")
if [ "$PERMS" != "600" ]; then
  echo "[run.sh] FATAL: $ENV_FILE must be chmod 600 (is $PERMS)" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

# Locate node. Prefer common install locations, then PATH.
for CAND in \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.nvm/versions/node/current/bin/node" \
  "$(command -v node || true)"; do
  if [ -x "$CAND" ]; then
    NODE_BIN="$CAND"
    break
  fi
done

if [ -z "${NODE_BIN:-}" ]; then
  echo "[run.sh] FATAL: node not found" >&2
  exit 1
fi

exec "$NODE_BIN" "$SERVER"
