-- pedido-interno-email.sql — columna PedidoInterno.email (mail del destinatario)
--
-- Fecha: 2026-09-16
-- Estado: 🔴 NO APLICADO. Lo corre Adrian a mano, ANTES del push a main.
--
-- Por qué: la carga propia (formulario /pedidos e importador de Excel) no
-- guardaba el mail del destinatario. `apps/worker/src/fuentes/interna.ts`
-- armaba la dirección sin `email`, y `correo/validate.ts:211-216` rechaza sin
-- excepción un mail vacío («Email inválido o vacío»): AHIVA lo exige para
-- avisar la llegada del paquete. Resultado: en una tienda con Correo Uruguayo,
-- TODO pedido cargado a mano o por Excel iba a NEEDS_REVIEW en cada corrida y
-- Correo era imposible desde esa fuente. Shopify (`order.email`) y DEPO
-- (`address.email`, migración 026) sí lo traen; esta era la única sin él.
--
-- 🔴🔴 ORDEN OBLIGATORIO: este SQL PRIMERO, después el push. La web deploya
-- sola en Vercel al push a main y el cliente Prisma nuevo pide la columna en
-- cada SELECT de PedidoInterno (GET /api/v1/pedidos, y `traer` de la fuente
-- interna en el worker): sin la columna, Postgres rechaza la consulta y la
-- pantalla Pedidos se cae para las tiendas con carga propia. Al revés no pasa
-- nada: el código viejo no conoce la columna y no la pide.
--
-- 🔴 NUNCA con `prisma db push` ni con el diff automático: prod tiene la tabla
-- `client_portal_tokens`, que no está en schema.prisma, y un push la borra con
-- todos los portales (precedente en correo-uruguayo.sql y en el runbook §6).
--
-- POR QUÉ ES SEGURO EN CALIENTE: una columna nullable, sin default y sin
-- backfill → cambio de catálogo puro en Postgres ≥ 11 (no reescribe ni bloquea
-- la tabla). Las filas existentes quedan en NULL, que es lo que significan:
-- nunca se cargó el mail. IF NOT EXISTS lo hace idempotente.
--
-- CÓMO APLICARLO:
--   cd /Users/Work/Desktop/labelflow/apps/web
--   set -a && source .env.production.local && set +a
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f ../../scripts/sql/pedido-interno-email.sql
--   (DIRECT_URL = puerto 5432, sin pgbouncer — el DDL no va por el pooler)

BEGIN;

ALTER TABLE "PedidoInterno" ADD COLUMN IF NOT EXISTS "email" TEXT;

COMMENT ON COLUMN "PedidoInterno"."email" IS
  'Mail del destinatario. Opcional para DAC; Correo Uruguayo (AHIVA) lo exige y avisa la llegada por ahí. NULL = no se cargó.';

COMMIT;

-- ── Verificación (correr después, aparte) ─────────────────────────────────
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'PedidoInterno' AND column_name = 'email';
--   -- esperado: 1 fila · text · YES
--
--   SELECT count(*) AS total, count("email") AS con_email FROM "PedidoInterno";
--   -- esperado justo después de aplicar: con_email = 0
--
--   -- Y la comprobación que importa de verdad: que el portal siga vivo.
--   SELECT count(*) FROM client_portal_tokens;
--   -- si esto falla, algo corrió un db push y hay que restaurar.
--
-- ── ROLLBACK (sólo si se abandona la feature) ─────────────────────────────
--   Primero volver el código a un commit sin la columna (el cliente Prisma
--   nuevo la pide en cada SELECT); recién después:
--   ALTER TABLE "PedidoInterno" DROP COLUMN IF EXISTS "email";
