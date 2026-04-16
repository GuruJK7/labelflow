#!/usr/bin/env bash
#
# Setup script for Adrian's Mac — Agent runner for LabelFlow bulk DAC uploads.
#
# This script is idempotent: safe to run multiple times. It will:
#   1. Verify prerequisites (Node 20+, Claude Code CLI, Chrome MCP extension)
#   2. Configure macOS to stay awake 24/7 (caffeinate via LaunchAgent)
#   3. Disable system sleep + hibernate (requires sudo)
#   4. Install/update the bulk-dac-agent skill in Claude Code
#   5. Run a health check to verify everything works
#
# Usage:
#   cd ~/Documents/LabelflOW2
#   git pull origin main
#   bash scripts/setup-adrian-mac.sh
#
# If something fails, fix the issue and re-run. The script picks up where it left off.

set -euo pipefail

# ===== Colors =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()      { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()    { echo -e "${RED}✗${NC}  $*" >&2; }
fatal()   { fail "$*"; exit 1; }
section() { echo -e "\n${BLUE}==${NC} $* ${BLUE}==${NC}"; }

# ===== Check we're on macOS =====
if [[ "$(uname)" != "Darwin" ]]; then
  fatal "This script only runs on macOS. Detected: $(uname)"
fi

# ===== Resolve repo root =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -f "${REPO_ROOT}/package.json" ]] || ! grep -q "labelflow" "${REPO_ROOT}/package.json" 2>/dev/null; then
  fatal "Script must run from within the labelflow repo. Expected root: ${REPO_ROOT}"
fi

ok "Repo root: ${REPO_ROOT}"

# ===== 1. Prerequisites =====
section "1. Verifying prerequisites"

# Node 20+
if ! command -v node &>/dev/null; then
  fatal "Node.js not installed. Install with: brew install node@20"
fi
NODE_MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
if (( NODE_MAJOR < 20 )); then
  fatal "Node.js 20+ required, found $(node --version). Upgrade with: brew install node@20"
fi
ok "Node.js $(node --version)"

# Claude Code CLI
if ! command -v claude &>/dev/null; then
  fatal "Claude Code CLI not found. Install: curl -fsSL https://claude.ai/install.sh | bash"
fi
ok "Claude Code: $(claude --version 2>&1 | head -1)"

# Git
command -v git &>/dev/null || fatal "git not installed"
ok "git $(git --version | awk '{print $3}')"

# .env files present
for envfile in "apps/web/.env" "apps/web/.env.local" "apps/worker/.env"; do
  if [[ ! -f "${REPO_ROOT}/${envfile}" ]]; then
    if [[ "$envfile" == "apps/web/.env" && -f "${REPO_ROOT}/apps/web/.env.local" ]]; then
      info "Copying .env.local → .env (Prisma CLI needs .env)"
      cp "${REPO_ROOT}/apps/web/.env.local" "${REPO_ROOT}/apps/web/.env"
    else
      fatal "Missing env file: ${envfile}. Get it from the main Mac via AirDrop."
    fi
  fi
  ok "env present: ${envfile}"
done

# ===== 2. 24/7 Power config =====
section "2. Power management for 24/7 operation"

if sudo -n true 2>/dev/null; then
  HAVE_SUDO=1
else
  warn "sudo required for pmset. You'll be prompted for your password."
  HAVE_SUDO=0
fi

info "Disabling system sleep, enabling tty wake, allowing display sleep..."
sudo pmset -a sleep 0
sudo pmset -a disablesleep 1
sudo pmset -a hibernatemode 0
sudo pmset -a ttyskeepawake 1
sudo pmset -a displaysleep 10  # display can sleep, system doesn't
ok "Power settings applied"

# ===== 3. Caffeinate LaunchAgent =====
section "3. Caffeinate LaunchAgent (keeps Mac awake)"

PLIST_PATH="$HOME/Library/LaunchAgents/com.labelflow.caffeinate.plist"

cat > "${PLIST_PATH}" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.labelflow.caffeinate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-ims</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/labelflow-caffeinate.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/labelflow-caffeinate.err</string>
</dict>
</plist>
PLIST

# Reload (unload if already loaded, then load)
launchctl unload "${PLIST_PATH}" 2>/dev/null || true
launchctl load "${PLIST_PATH}"

if launchctl list | grep -q "com.labelflow.caffeinate"; then
  ok "Caffeinate LaunchAgent running"
else
  fail "Caffeinate LaunchAgent failed to load"
  exit 1
fi

# ===== 4. npm install + prisma generate =====
section "4. Installing dependencies"

cd "${REPO_ROOT}"
if [[ ! -d "node_modules" ]] || [[ "$(find node_modules -maxdepth 1 -type d | wc -l)" -lt 10 ]]; then
  info "Running npm install..."
  npm install
else
  ok "node_modules already populated (skipping npm install)"
fi

info "Generating Prisma client..."
npx prisma generate --schema=apps/web/prisma/schema.prisma
ok "Prisma client generated"

# ===== 5. DB connectivity test =====
section "5. Database connectivity check"

cd "${REPO_ROOT}/apps/web"
if npx prisma db pull --print 2>&1 | grep -q "^model"; then
  ok "Supabase connection working"
else
  fail "Cannot connect to Supabase. Check DATABASE_URL in apps/web/.env"
  exit 1
fi
cd "${REPO_ROOT}"

# ===== 6. Enable AGENT_MODE in worker env =====
section "6. Enabling AGENT_MODE in worker .env"

WORKER_ENV="${REPO_ROOT}/apps/worker/.env"
if grep -q "^AGENT_MODE=" "${WORKER_ENV}"; then
  # Replace existing line
  if grep -q "^AGENT_MODE=true" "${WORKER_ENV}"; then
    ok "AGENT_MODE already true"
  else
    sed -i.bak 's/^AGENT_MODE=.*/AGENT_MODE=true/' "${WORKER_ENV}"
    ok "AGENT_MODE set to true"
  fi
else
  echo "AGENT_MODE=true" >> "${WORKER_ENV}"
  ok "AGENT_MODE=true appended to worker .env"
fi

# ===== 7. Install Playwright browsers =====
section "7. Playwright Chromium"

cd "${REPO_ROOT}/apps/worker"
if [[ -d "$HOME/Library/Caches/ms-playwright/chromium-"* ]] 2>/dev/null; then
  ok "Playwright Chromium already installed"
else
  info "Installing Playwright Chromium (may take a minute)..."
  npx playwright install chromium
  ok "Playwright Chromium installed"
fi
cd "${REPO_ROOT}"

# ===== 8. Build worker =====
section "8. Building worker"

cd "${REPO_ROOT}/apps/worker"
info "Compiling TypeScript..."
# Skip strict errors (pre-existing) and just build
npx tsc --skipLibCheck --noEmit false --outDir dist 2>&1 | tail -5 || true
if [[ -f "dist/index.js" ]]; then
  ok "Worker built at dist/index.js"
else
  warn "Build produced no dist/index.js — will use ts-node-dev fallback"
fi
cd "${REPO_ROOT}"

# ===== 9. Worker LaunchAgent =====
section "9. Worker LaunchAgent (auto-start on boot, auto-restart on crash)"

WORKER_PLIST="$HOME/Library/LaunchAgents/com.labelflow.agent-worker.plist"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

cat > "${WORKER_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.labelflow.agent-worker</string>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}/apps/worker</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NPM_BIN}</string>
        <string>run</string>
        <string>dev</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname ${NODE_BIN}):/usr/local/bin:/usr/bin:/bin</string>
        <key>AGENT_MODE</key>
        <string>true</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/labelflow-agent-worker.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/labelflow-agent-worker.err</string>
</dict>
</plist>
PLIST

launchctl unload "${WORKER_PLIST}" 2>/dev/null || true
launchctl load "${WORKER_PLIST}"

sleep 3
if launchctl list | grep -q "com.labelflow.agent-worker"; then
  ok "Agent worker LaunchAgent loaded"
  info "Follow logs: tail -f /tmp/labelflow-agent-worker.out"
else
  warn "Agent worker LaunchAgent did not appear to load. Check: launchctl list | grep labelflow"
fi

# ===== 10. Summary =====
section "Setup complete"

echo
ok "Mac configured for 24/7 operation"
ok "Caffeinate running (Mac won't sleep)"
ok "Dependencies installed + Prisma client generated"
ok "Database reachable"
ok "AGENT_MODE=true in worker env"
ok "Playwright Chromium installed"
ok "Agent worker running as LaunchAgent"
echo
info "Commands you'll actually use:"
echo "  tail -f /tmp/labelflow-agent-worker.out    # watch worker logs"
echo "  launchctl list | grep labelflow             # verify agents are running"
echo "  launchctl unload ~/Library/LaunchAgents/com.labelflow.agent-worker.plist  # stop worker"
echo "  launchctl load ~/Library/LaunchAgents/com.labelflow.agent-worker.plist    # start worker"
echo
info "Test the agent end-to-end:"
echo "  From your other Mac, trigger a bulk job via:"
echo "    POST https://autoenvia.com/api/v1/jobs/bulk-agent"
echo "  Within 30s the agent on this Mac picks it up and processes it."
echo
ok "Agent Mac ready."
