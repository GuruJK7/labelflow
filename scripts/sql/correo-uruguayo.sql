-- correo-uruguayo.sql — Correo Uruguayo (plataforma AHIVA) como segundo transportista.
--
-- Fecha: 2026-09-03
-- Estado: 🔴 NO APLICADO TODAVÍA — Y ES BLOQUEANTE.
--
-- 🔴🔴 ORDEN OBLIGATORIO. La web deploya SOLA en Vercel al push a main. Si el
-- código llega antes que este SQL, Postgres rechaza toda consulta que pida una
-- columna inexistente y se caen, para las 33 tiendas y no sólo para Correo:
--     · /orders            (apps/web/app/api/v1/orders/route.ts, select carrier)
--     · /settings          (apps/web/app/api/v1/settings/route.ts, select correo*)
--     · Reintentar fulfill (apps/web/app/api/v1/fulfill-retry/route.ts)
--     · el contador de envíos trabados (apps/web/lib/stuck-labels.ts)
-- y en el worker, el tick del scheduler tira excepción entera y NINGÚN tenant se
-- encola. O sea: primero este SQL, después el push. No al revés.
--
-- Lo corre Adrian, a mano:
--
--   cd apps/web && set -a && source .env.production.local && set +a
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f ../../scripts/sql/correo-uruguayo.sql
--
-- 🔴 NUNCA con `npm run db:push` NI con el script que genera `prisma migrate diff`.
-- Verificado el 2026-09-03 contra esta misma base: el diff automático incluye
--   DROP TABLE "client_portal_tokens";
-- que es la tabla donde viven los links de portal de los clientes y que no está
-- en schema.prisma. Un push se la lleva puesta. Es el mismo precedente que ya
-- documenta cod-contrarreembolso.sql:10-14. Usar el DIRECT_URL (puerto 5432,
-- sin pgbouncer), no el pooler.
--
-- POR QUÉ ES SEGURO CORRERLO EN CALIENTE:
--   * Es puramente ADITIVO: nueve columnas nuevas, ni un DROP, ni un ALTER TYPE.
--   * Las columnas nullable se agregan con un cambio sólo de catálogo: Postgres
--     no reescribe la tabla ni la bloquea. "Label" tiene ~11.600 filas y no se
--     toca ninguna.
--   * Las tres columnas NOT NULL llevan un DEFAULT no volátil, que desde
--     Postgres 11 tampoco reescribe la tabla.
--   * Los defaults están elegidos para que el sistema se comporte EXACTAMENTE
--     como antes: correoEnabled=false (ninguna tienda cambia de transportista),
--     correoAmbiente='test' (una tienda mal configurada no despacha contra
--     producción por accidente), Label.carrier=NULL (toda etiqueta histórica
--     sigue leyéndose como DAC).
--   * IF NOT EXISTS lo hace idempotente: correrlo dos veces no falla.
--
-- POR QUÉ Label.carrier ES NULLABLE Y NO 'DAC' NOT NULL: un backfill de 11.621
-- filas es innecesario. La regla en el código es `carrier IS NULL OR carrier =
-- 'DAC'` ⇒ es DAC, así que cada consulta existente sigue devolviendo lo mismo
-- sin tocar una sola fila vieja.
--
-- POR QUÉ NO SE AGREGÓ NINGÚN VALOR A UN ENUM: `ADD VALUE` no se puede usar en
-- la misma transacción que lo referencia, y el worker no tiene autoDeploy, así
-- que un cliente Prisma viejo leyendo un enum nuevo revienta AL LEER. El
-- transportista viaja como TEXT libre, igual que paymentStatus.
--
-- Para revertir (no hace falta salvo que se abandone la feature):
--   ALTER TABLE "Label"  DROP COLUMN IF EXISTS "carrier";
--   ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "correoEnabled", ... ;

BEGIN;

-- ---------------------------------------------------------------------------
-- Label: de quién es cada envío
-- ---------------------------------------------------------------------------

ALTER TABLE "Label" ADD COLUMN IF NOT EXISTS "carrier" TEXT;

COMMENT ON COLUMN "Label"."carrier" IS
  'Transportista que emitió la etiqueta: NULL o ''DAC'' = DAC, ''CORREO'' = Correo Uruguayo (AHIVA), ''PROPIO'' = reparto propio. NULL a propósito para no reescribir las filas históricas.';

-- Índice COMPLETO, no parcial. Un parcial sería más chico, pero Prisma no sabe
-- expresarlo en schema.prisma: quedaría un índice en la base que el schema no
-- declara, o sea la misma deriva que ya rompió el build del worker en Render dos
-- veces. Se prefiere el índice que los dos lados pueden describir igual.
CREATE INDEX IF NOT EXISTS "Label_carrier_idx" ON "Label" ("carrier");

-- ---------------------------------------------------------------------------
-- Tenant: configuración de Correo Uruguayo por tienda
-- ---------------------------------------------------------------------------

-- El interruptor. FALSE por default: sin esto, desplegar el código cambiaría el
-- transportista de las 29 tiendas a la vez.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Credenciales de AHIVA. Se guardan cifradas (AES-256-GCM, el mismo helper que
-- dacPassword). `cuenta`/`subcuenta` son EXCLUSIVAS de cuentas crédito: una
-- cuenta contado las deja en NULL.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoUser"      TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoPassword"  TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoCuenta"    TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoSubcuenta" TEXT;

-- 'test' | 'prod'. No es cosmético: el catálogo de oficinas DIFIERE entre
-- ambientes (196 registros en prod contra 182 en test, verificado 03-09-2026),
-- así que validar una sucursal contra el ambiente equivocado acepta oficinas
-- que en producción no existen.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoAmbiente" TEXT NOT NULL DEFAULT 'test';

-- Oficina a la que Correo devuelve el paquete si no se puede entregar. Es el
-- `nombre` textual del catálogo de obtenerLocalidadesCorreo().
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "correoOficinaDevolucion" TEXT;

-- Peso por defecto en kg. Correo EXIGE peso (> 0 y < 30) y DAC nunca lo pidió,
-- así que ninguna tienda conectada hoy lo tiene cargado en Shopify. Sin este
-- default, todo pedido sin peso propio va a revisión.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "pesoDefaultKg" DOUBLE PRECISION;

COMMENT ON COLUMN "Tenant"."correoEnabled" IS
  'Interruptor por tienda del transportista Correo Uruguayo. false = despacha por DAC, como siempre. Apagarlo es un UPDATE, sin redeploy.';
COMMENT ON COLUMN "Tenant"."correoAmbiente" IS
  '"test" | "prod". El catálogo de oficinas difiere entre ambientes: validar contra el equivocado acepta sucursales inexistentes.';
COMMENT ON COLUMN "Tenant"."pesoDefaultKg" IS
  'Peso por defecto en kg para los envíos que no traen peso propio. Correo lo exige (>0 y <30); DAC nunca lo pidió.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Verificación (correr después, aparte)
-- ---------------------------------------------------------------------------
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'Tenant'
--      AND (column_name LIKE 'correo%' OR column_name = 'pesoDefaultKg')
--    ORDER BY column_name;
--   -- esperado: 8 filas (correoAmbiente, correoCuenta, correoEnabled,
--   -- correoOficinaDevolucion, correoPassword, correoSubcuenta, correoUser,
--   -- pesoDefaultKg). correoEnabled boolean NOT NULL false; correoAmbiente text
--   -- NOT NULL 'test'.
--   -- Los paréntesis del AND/OR importan: sin ellos el OR se evalúa sobre TODAS
--   -- las tablas de la base y la consulta devuelve columnas de otras tablas.
--
--   SELECT count(*) AS total, count("carrier") AS con_carrier FROM "Label";
--   -- esperado justo después de aplicar: con_carrier = 0
--
--   SELECT count(*) AS tiendas, count(*) FILTER (WHERE "correoEnabled") AS con_correo
--     FROM "Tenant";
--   -- esperado justo después de aplicar: con_correo = 0
--
--   -- Y la comprobación que importa de verdad: que el portal siga vivo.
--   SELECT count(*) FROM client_portal_tokens;
--   -- si esto falla, algo corrió un db push y hay que restaurar.
