-- packseq.sql — columna Label.packSeq (orden de la pila física impresa)
--
-- Fecha: 2026-09-01
-- Para: export de la tanda del día a DEPO (WMS) — picking & packing.
--
-- ⚠️ NO APLICADO. Existe para que Adrian lo corra a mano contra prod cuando
-- decida desplegar la feature. Nadie lo ejecutó todavía.
--
-- Es 100% ADITIVO: agrega UNA columna nullable a Label. Sin default, sin
-- backfill, sin NOT NULL → en Postgres ≥11 es un cambio de catálogo puro
-- (no reescribe la tabla) y se puede aplicar con tráfico vivo. Las filas
-- existentes quedan en NULL, que es exactamente lo que significan: nunca se
-- imprimieron con la pila registrada.
--
-- QUÉ HACE EL VALOR: markClientViewLabelsPrinted() lo estampa con el índice
-- (1-based) del array de ids que el portal mandó a mergear en el PDF bulk. El
-- PDF sale en ese orden, así que packSeq describe la pila que el operador
-- levanta de la impresora. Reimprimir pisa el valor. El export ordena
-- `packSeq asc nulls last, createdAt asc`.
--
-- CÓMO SE GENERÓ (no está escrito a mano):
--   ./node_modules/.bin/prisma migrate diff \
--     --from-schema-datamodel <schema del commit anterior> \
--     --to-schema-datamodel apps/web/prisma/schema.prisma --script
--
-- CÓMO APLICARLO (después de revisar):
--   cd apps/web && set -a && source .env.production.local && set +a
--   psql "$DIRECT_URL" -f ../../scripts/sql/packseq.sql
--   (DIRECT_URL = puerto 5432, sin pgbouncer — DDL no va por el pooler)
--
-- Normalmente NO se corre suelto: va adentro de scripts/sql/wms-deploy.sql,
-- que es el script único de deploy (LabelItem + packSeq + token del portal).

BEGIN;

-- AlterTable
ALTER TABLE "Label" ADD COLUMN     "packSeq" INTEGER;

COMMIT;

-- ── ROLLBACK (si hiciera falta deshacerlo) ───────────────────────────────────
-- Nada más depende de la columna: el portal deja de estampar y el export cae
-- al orden por createdAt.
--
-- BEGIN;
-- ALTER TABLE "Label" DROP COLUMN "packSeq";
-- COMMIT;
