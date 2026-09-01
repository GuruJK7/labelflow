-- Wallet unificado — ledger por envío (fase 1, modo sombra). 2026-09-01.
--
-- 🔴 ESCRITA A MANO Y NO APLICADA. Por decisión D9 (docs/DECISIONES.md) las
-- migraciones se escriben en el repo y se aplican a prod en un paso aparte,
-- revisado y con dry-run. Este repo NO usa `prisma migrate` (el flujo vigente
-- es `prisma db push` sobre DIRECT_URL); este archivo existe para que el DDL
-- exacto quede versionado y revisable, no para que lo corra una herramienta.
--
-- Todo es ADITIVO: dos tablas nuevas, cero cambios a columnas existentes.
-- Idempotente (IF NOT EXISTS) para poder re-correrla sin daño.
--
-- Cómo aplicar cuando llegue el momento (NO ahora):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f apps/web/prisma/migrations/20260901180000_wallet_ledger/migration.sql
-- y después `npm run db:generate` en el deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS "Wallet" (
  "id"            TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "balanceMilli"  BIGINT       NOT NULL DEFAULT 0,
  "paidInMilli"   BIGINT       NOT NULL DEFAULT 0,
  "smmSpentMilli" BIGINT       NOT NULL DEFAULT 0,
  "authoritative" BOOLEAN      NOT NULL DEFAULT false,
  "cutoverAt"     TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Wallet_userId_key" ON "Wallet"("userId");

ALTER TABLE "Wallet"
  DROP CONSTRAINT IF EXISTS "Wallet_userId_fkey";
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "WalletEntry" (
  "id"             TEXT         NOT NULL,
  "walletId"       TEXT         NOT NULL,
  "tenantId"       TEXT,
  "deltaMilli"     BIGINT       NOT NULL,
  "reason"         TEXT         NOT NULL,
  "idemKey"        TEXT         NOT NULL,
  "dacGuia"        TEXT,
  "labelId"        TEXT,
  "jobId"          TEXT,
  "periodYm"       TEXT,
  "unitPriceMilli" BIGINT,
  "shadow"         BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- Idempotencia principal: una clave por hecho (ship:v1:…, refund:v1:…, settle:v1:…).
CREATE UNIQUE INDEX IF NOT EXISTS "WalletEntry_idemKey_key" ON "WalletEntry"("idemKey");

CREATE INDEX IF NOT EXISTS "WalletEntry_walletId_periodYm_idx"  ON "WalletEntry"("walletId", "periodYm");
CREATE INDEX IF NOT EXISTS "WalletEntry_walletId_createdAt_idx" ON "WalletEntry"("walletId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "WalletEntry_tenantId_dacGuia_idx"   ON "WalletEntry"("tenantId", "dacGuia");

-- UNIQUE PARCIAL: una guía se factura UNA vez por tenant. Prisma no sabe
-- expresar índices parciales, por eso vive sólo acá (documentado en el
-- schema junto al modelo). Lleva tenantId porque Label.dacGuia es @unique
-- global pero cada cliente usa su propia cuenta DAC: la misma guía puede
-- existir legítimamente en dos tenants distintos.
CREATE UNIQUE INDEX IF NOT EXISTS "WalletEntry_shipment_tenant_guia_key"
  ON "WalletEntry"("tenantId", "dacGuia")
  WHERE "reason" = 'shipment';

-- Lo mismo para reintegros: un reintegro por guía y tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "WalletEntry_refund_tenant_guia_key"
  ON "WalletEntry"("tenantId", "dacGuia")
  WHERE "reason" = 'refund';

-- Motivos cerrados: un typo en `reason` no puede colarse al libro.
ALTER TABLE "WalletEntry"
  DROP CONSTRAINT IF EXISTS "WalletEntry_reason_check";
ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "WalletEntry_reason_check"
  CHECK ("reason" IN ('shipment','settlement','purchase','refund','chargeback','grant','smm','adjust'));

ALTER TABLE "WalletEntry"
  DROP CONSTRAINT IF EXISTS "WalletEntry_walletId_fkey";
ALTER TABLE "WalletEntry"
  ADD CONSTRAINT "WalletEntry_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
