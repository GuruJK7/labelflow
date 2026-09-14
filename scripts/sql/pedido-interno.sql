-- Fuente INTERNA de pedidos — tabla PedidoInterno + flag del Tenant + JobType.
-- [14-09-2026]
--
-- Por qué: el paso 2 del onboarding ofrecía dos caminos y los dos dependen de
-- algo externo (la tienda de Shopify, o una URL + token de otro dashboard).
-- Quien no tiene ninguno de los dos no podía completar el onboarding: medido
-- contra producción el 14-09, NINGUNA cuenta orgánica llegó nunca a
-- onboardingComplete. Esta fuente guarda los pedidos en la propia base.
--
-- Aditivo y seguro: crea una tabla nueva, agrega una columna con DEFAULT y un
-- valor de enum. No toca ninguna fila existente, no borra nada, y el código
-- desplegado que todavía no lo conoce simplemente no lo usa.
--
-- 🔴 Se aplica ANTES del deploy. Si el código sale primero, el worker levanta
-- un tipo de job que el enum todavía no tiene y falla al encolar.

-- ── 1. El valor del enum, SUELTO y PRIMERO ───────────────────────────────
-- 🔴 `ALTER TYPE ... ADD VALUE` no puede usarse en la MISMA transacción que lo
-- crea (Postgres 12+). Por eso va solo, fuera del BEGIN de abajo, y antes.
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROCESS_INTERNAL_ORDERS';

-- ── 2. El resto, en una transacción ──────────────────────────────────────
BEGIN;

-- El interruptor de la fuente. NOT NULL con DEFAULT false: las 39 tiendas que
-- ya existen quedan exactamente como estaban.
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "internalSourceEnabled" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE "EstadoPedidoInterno" AS ENUM ('PENDIENTE', 'DESPACHADO', 'CANCELADO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PedidoInterno" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "estado"        "EstadoPedidoInterno" NOT NULL DEFAULT 'PENDIENTE',

  -- Destinatario, en crudo como lo tipearon o lo trajo el Excel.
  "nombre"        TEXT NOT NULL,
  "telefono"      TEXT NOT NULL,
  "documento"     TEXT,
  "departamento"  TEXT NOT NULL,
  "localidad"     TEXT,
  "direccion"     TEXT,
  "agencia"       TEXT,
  "referencia"    TEXT,

  -- [{ nombre, cantidad, precio }] — precio EN PESOS, no en centavos.
  "items"         JSONB NOT NULL,
  "totalUyu"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "contraEntrega" BOOLEAN NOT NULL DEFAULT false,
  "fechaVenta"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observaciones" TEXT,

  -- Vínculo explícito con la etiqueta. La fuente externa no lo tiene: ata por
  -- un hash de una sola vía y desde la etiqueta no se puede volver al pedido.
  "labelId"       TEXT,
  "dacGuia"       TEXT,
  "errorMessage"  TEXT,

  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "despachadoAt"  TIMESTAMP(3),

  CONSTRAINT "PedidoInterno_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PedidoInterno_tenantId_estado_idx"
  ON "PedidoInterno" ("tenantId", "estado");
CREATE INDEX IF NOT EXISTS "PedidoInterno_tenantId_createdAt_idx"
  ON "PedidoInterno" ("tenantId", "createdAt" DESC);

COMMIT;

-- ── Verificación ─────────────────────────────────────────────────────────
--   select unnest(enum_range(NULL::"JobType"));
--   select count(*) from "PedidoInterno";
--   select "internalSourceEnabled", count(*) from "Tenant" group by 1;
--
-- Para revertir (sólo si NO se cargó ningún pedido — mirá el count de arriba):
--   DROP TABLE "PedidoInterno"; DROP TYPE "EstadoPedidoInterno";
--   ALTER TABLE "Tenant" DROP COLUMN "internalSourceEnabled";
-- El valor del enum JobType NO se puede quitar en Postgres: queda, inofensivo.
