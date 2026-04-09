#!/bin/bash
# =============================================================================
# LabelFlow — Setup script for new Mac
# Run: curl -sL <gist-url> | bash   OR   bash setup-mac.sh
# =============================================================================

set -e

echo "========================================="
echo "  LabelFlow — Setup for new Mac"
echo "========================================="

# 1. Check prerequisites
echo ""
echo "[1/6] Checking prerequisites..."

if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found. Install it first:"
  echo "  brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required. You have $(node -v)"
  echo "  brew install node"
  exit 1
fi
echo "  Node.js $(node -v) OK"

if ! command -v git &> /dev/null; then
  echo "ERROR: git not found. Install it first:"
  echo "  brew install git"
  exit 1
fi
echo "  git OK"

# 2. Clone repo
echo ""
echo "[2/6] Cloning repository..."

INSTALL_DIR="$HOME/Documents/labelflow"

if [ -d "$INSTALL_DIR" ]; then
  echo "  Directory exists, pulling latest..."
  cd "$INSTALL_DIR"
  git pull origin main
else
  git clone https://github.com/GuruJK7/labelflow.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
echo "  Latest commit: $(git log --oneline -1)"

# 3. Install dependencies
echo ""
echo "[3/6] Installing dependencies..."
npm install --silent 2>&1 | tail -1

# 4. Create worker .env
echo ""
echo "[4/6] Creating worker .env..."

WORKER_ENV="$INSTALL_DIR/apps/worker/.env"
cat > "$WORKER_ENV" << 'ENVEOF'
DATABASE_URL="postgresql://postgres.ysqnrzqcklkywauzkylg:3EOwhYgxfYMWfZRs@aws-1-us-east-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
ENCRYPTION_KEY="6a87f508118f33543faa7bf24f730a029e025fa5339a633d7b0a27f8bdfbf975"
ENVEOF
echo "  Created $WORKER_ENV"

# 5. Generate Prisma client
echo ""
echo "[5/6] Generating Prisma client..."
cd "$INSTALL_DIR/apps/worker"
npx prisma generate --silent 2>/dev/null || npx prisma generate
echo "  Prisma client ready"

# 6. Run tests
echo ""
echo "[6/6] Running test suite..."
echo ""

npx vitest run 2>&1 | grep -E "(Test Files|Tests|Duration|passed|failed)"

# 7. Quick DB health check
echo ""
echo "========================================="
echo "  DB Health Check"
echo "========================================="

node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const labels = await p.label.count();
  const completed = await p.label.count({ where: { status: 'COMPLETED' } });
  const failed = await p.label.count({ where: { status: 'FAILED' } });
  const tenants = await p.tenant.count({ where: { isActive: true } });
  console.log('  Labels total:', labels);
  console.log('  Completed:', completed);
  console.log('  Failed:', failed);
  console.log('  Active tenants:', tenants);
  await p.\$disconnect();
})();
" 2>/dev/null

echo ""
echo "========================================="
echo "  Setup complete!"
echo "========================================="
echo ""
echo "Project location: $INSTALL_DIR"
echo ""
echo "Useful commands:"
echo "  cd $INSTALL_DIR/apps/worker"
echo "  npx vitest run                    # Run all tests"
echo "  npx vitest run --watch            # Watch mode"
echo "  npx tsx src/index.ts              # Start worker locally"
echo ""
echo "For Claude Code, just open the project:"
echo "  cd $INSTALL_DIR && claude"
echo ""
