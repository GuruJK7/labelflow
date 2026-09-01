-- Tenant.shopifyStoreUrl en minúsculas (D18). SÓLO el UPDATE.
--
-- El índice único parcial que antes vivía en este mismo archivo se movió a
-- 20260901180100_tenant_shop_domain_unique: ese es una DECISIÓN pendiente de
-- Adrian (D22, retira el diseño de "dos tenants pueden compartir tienda");
-- este no. Se aplican por separado y en este orden.
--
-- 🔴 NO APLICADA (D9). Este repo no usa `prisma migrate` (no había carpeta
-- prisma/migrations antes de este archivo; el schema se lleva con
-- `prisma db push`), así que esto se corre A MANO, en otro turno, con OK
-- explícito, sobre DIRECT_URL (5432, no pgbouncer). schema.prisma no cambia.
--
-- POR QUÉ HACE FALTA aunque apps/web ya compare insensible a mayúsculas:
-- el worker (apps/worker/src/jobs/process-orders.job.ts, `sharedTenantIds`)
-- compara `shopifyStoreUrl` EXACTO para saltear los pedidos que otro tenant
-- de la misma tienda ya despachó (94a6282, incidente Aura 2026-05-08). Un
-- tenant con `MiTienda…` y otro con `mitienda…` no se ven entre sí, y hasta
-- que esto se aplique pueden despachar (y facturar en DAC) el mismo pedido
-- dos veces. Shopify manda el dominio siempre en minúsculas; los dos zod del
-- camino manual bajan a minúsculas desde D18, así que después de esto la
-- base queda coherente con todo lo que se escribe.
--
-- CHEQUEO PREVIO (sólo lectura), duplicados por lower(). Este UPDATE se
-- puede aplicar aunque devuelva filas (no hay índice que choque), pero esas
-- filas son las que después bloquean el índice de …_unique: anotarlas.
--
--   SELECT lower("shopifyStoreUrl") AS dominio,
--          count(*)                  AS tenants,
--          array_agg(id ORDER BY "createdAt") AS ids,
--          array_agg(slug ORDER BY "createdAt") AS slugs
--   FROM "Tenant"
--   WHERE "shopifyStoreUrl" IS NOT NULL
--   GROUP BY lower("shopifyStoreUrl")
--   HAVING count(*) > 1;
--
-- Y para ver exactamente qué filas toca el UPDATE (sólo lectura):
--
--   SELECT id, slug, "shopifyStoreUrl"
--   FROM "Tenant"
--   WHERE "shopifyStoreUrl" <> lower("shopifyStoreUrl");

BEGIN;

UPDATE "Tenant"
SET "shopifyStoreUrl" = lower("shopifyStoreUrl")
WHERE "shopifyStoreUrl" <> lower("shopifyStoreUrl");

COMMIT;
