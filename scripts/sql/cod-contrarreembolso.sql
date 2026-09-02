-- cod-contrarreembolso.sql — el único cambio de base del contrareembolso de DAC.
--
-- Fecha: 2026-09-01
--
-- ✅ APLICADO EN PROD — verificado 2026-09-02 (lectura de information_schema
-- sobre DIRECT_URL): Label.codAmount integer nullable y Tenant.codEnabled
-- boolean NOT NULL DEFAULT false existen. Se deja el archivo por si hay que
-- reproducir la base (es idempotente). Lo corrió/corre Adrian:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/sql/cod-contrarreembolso.sql
--
-- 🔴 NUNCA con `npm run db:push`. Precedente documentado en wms-deploy.sql:34-36:
-- un push borra en silencio cualquier objeto que haya drifteado entre
-- schema.prisma y producción (ahí casi se lleva puesta client_portal_tokens).
-- Usar el DIRECT_URL (puerto 5432, sin pgbouncer), no el pooler.
--
-- POR QUÉ ES SEGURO CORRERLO EN CALIENTE:
--   * Es puramente ADITIVO: una columna nullable, sin DEFAULT y sin NOT NULL.
--     Postgres la agrega con un cambio sólo de catálogo — no reescribe la tabla
--     ni la bloquea, así que no hay ventana de downtime sobre "Label".
--   * Todas las filas existentes quedan en NULL, que es exactamente
--     "este envío no es contrareembolso". El comportamiento previo no cambia.
--   * NO hay ALTER TYPE. Se decidió deliberadamente NO agregar un tercer valor a
--     enum "PaymentType": además de que ADD VALUE no puede usarse en la misma
--     transacción que lo referencia, hay tres lugares en el código que tratan
--     cualquier valor distinto de 'REMITENTE' como si fuera 'DESTINATARIO', y uno
--     de ellos decide cómo se reconcilia un envío trabado.
--   * IF NOT EXISTS lo hace idempotente: correrlo dos veces no falla.
--
-- Para revertir (no hace falta salvo que se abandone la feature):
--   ALTER TABLE "Label" DROP COLUMN IF EXISTS "codAmount";

BEGIN;

ALTER TABLE "Label" ADD COLUMN IF NOT EXISTS "codAmount" INTEGER;

-- Interruptor por tienda. FALSE por default: sin esto, tomar el monto del total de
-- Shopify convertiria TODOS los envios de TODOS los clientes en contrareembolso.
-- Con NOT NULL DEFAULT false Postgres no reescribe la tabla (>= v11).
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "codEnabled" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "Label"."codAmount" IS
  'Contrareembolso (DAC TipoGuia=6): monto en pesos que DAC le cobra al destinatario y le gira al remitente. NULL = no es contrareembolso.';

COMMIT;

-- Verificación (correr después, aparte):
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'Label' AND column_name = 'codAmount';
--   -- esperado: codAmount | integer | YES
--
--   SELECT count(*) AS total, count("codAmount") AS con_cod FROM "Label";
--   -- esperado justo después de aplicar: con_cod = 0
--
--   SELECT count(*) AS tiendas, count(*) FILTER (WHERE "codEnabled") AS con_cod_prendido
--     FROM "Tenant";
--   -- esperado justo después de aplicar: con_cod_prendido = 0
