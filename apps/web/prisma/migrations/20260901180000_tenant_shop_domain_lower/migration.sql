-- Tenant.shopifyStoreUrl en minúsculas + índice único parcial (D18).
--
-- 🔴 NO APLICADA (D9). Este repo no usa `prisma migrate` (no había carpeta
-- prisma/migrations antes de este archivo; el schema se lleva con
-- `prisma db push`), así que esto se corre A MANO, en otro turno, con OK
-- explícito, sobre DIRECT_URL (5432, no pgbouncer). El schema.prisma NO
-- declara @unique sobre shopifyStoreUrl a propósito: el índice es parcial
-- (WHERE NOT NULL) y Prisma no sabe expresarlo; agregarlo al schema haría
-- que el próximo `db push` intente crear un índice completo distinto.
--
-- ANTES de correr nada, chequear duplicados por lower(): si esta consulta
-- devuelve filas, el CREATE UNIQUE INDEX va a fallar y hay que decidir a
-- mano qué tenant se queda con la tienda (los otros → shopifyStoreUrl NULL).
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
-- Y para ver cuántas filas toca el UPDATE (sólo lectura):
--
--   SELECT id, slug, "shopifyStoreUrl"
--   FROM "Tenant"
--   WHERE "shopifyStoreUrl" <> lower("shopifyStoreUrl");

-- 1. Normalizar lo que el camino manual guardó con mayúsculas. Shopify manda
--    el dominio siempre en minúsculas; el código ya busca insensible a
--    mayúsculas, esto deja la base coherente con lo que se escribe de ahora
--    en más (los dos zod hacen toLowerCase).
UPDATE "Tenant"
SET "shopifyStoreUrl" = lower("shopifyStoreUrl")
WHERE "shopifyStoreUrl" <> lower("shopifyStoreUrl");

-- 2. Un dominio de Shopify pertenece a UN tenant. Parcial: los tenants sin
--    tienda (NULL) no compiten entre sí. Con esto, el P2002 que /claim,
--    /callback y provisionFromShopify ya traducen a 'already_linked' /
--    'conflict' pasa a saltar también por el dominio, no sólo por el slug.
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_shopifyStoreUrl_key"
  ON "Tenant" ("shopifyStoreUrl")
  WHERE "shopifyStoreUrl" IS NOT NULL;
