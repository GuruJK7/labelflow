#!/usr/bin/env bash
# check-schemas.sh
#
# Fails if apps/web/prisma/schema.prisma and apps/worker/prisma/schema.prisma
# have drifted. They must be byte-identical — both apps share the same
# Supabase database, and their Prisma Client types must match the runtime
# schema.
#
# Why this exists: drift between these two files has broken the Render
# worker build TWICE (2026-04-19 ShippingRule; 2026-04-22 Fase 3+4 hardening).
# Local `npm run build` was a false-PASS both times because the monorepo
# root `node_modules/.prisma/client` was regenerated against the web schema
# and hoisted via workspace deps. Render builds the worker in a clean Docker
# context with only the worker schema, which is when the drift surfaces.
#
# Usage:
#   bash scripts/check-schemas.sh         # exits 0 if synced, 1 if drifted
#   npm run check-schemas                 # same, via root package.json
#   npm run sync-schemas                  # fix drift: copies web → worker
#
# This is wired into the root `build` script so any `npm run build` from
# the repo root catches drift before it hits CI/Render.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_SCHEMA="$ROOT/apps/web/prisma/schema.prisma"
WORKER_SCHEMA="$ROOT/apps/worker/prisma/schema.prisma"

if [[ ! -f "$WEB_SCHEMA" ]]; then
  echo "[check-schemas] FATAL: $WEB_SCHEMA not found" >&2
  exit 2
fi
if [[ ! -f "$WORKER_SCHEMA" ]]; then
  echo "[check-schemas] FATAL: $WORKER_SCHEMA not found" >&2
  exit 2
fi

if cmp -s "$WEB_SCHEMA" "$WORKER_SCHEMA"; then
  echo "[check-schemas] OK — web and worker schemas are in sync"
  exit 0
fi

echo "[check-schemas] FAIL — schemas have drifted:" >&2
echo "                web: $WEB_SCHEMA" >&2
echo "             worker: $WORKER_SCHEMA" >&2
echo "" >&2
echo "  Summary diff (first 40 lines):" >&2
diff "$WEB_SCHEMA" "$WORKER_SCHEMA" | head -40 >&2 || true
echo "" >&2
echo "  To fix: run 'npm run sync-schemas' from repo root" >&2
echo "  (this copies web → worker; the web schema is the source of truth)" >&2
exit 1
