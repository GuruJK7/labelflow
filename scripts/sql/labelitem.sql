-- labelitem.sql — tabla LabelItem (snapshot de ítems del pedido por etiqueta)
--
-- Fecha: 2026-09-01
-- Para: export de la tanda del día a DEPO (WMS) — picking & packing.
--
-- ⚠️ NO APLICADO. Este archivo existe para que Adrian lo corra a mano contra
-- prod cuando decida desplegar la feature. Nadie lo ejecutó todavía.
--
-- Es 100% ADITIVO: crea una tabla nueva, un índice nuevo y una FK nueva. No
-- toca ninguna tabla existente, no borra nada, no cambia tipos. Se puede
-- aplicar con tráfico vivo (Label queda intacta; la FK apunta HACIA Label, así
-- que sólo bloquea brevemente para tomar el lock de validación de la FK).
--
-- CÓMO SE GENERÓ (no está escrito a mano):
--   ./node_modules/.bin/prisma migrate diff \
--     --from-schema-datamodel <schema en el commit anterior> \
--     --to-schema-datamodel apps/web/prisma/schema.prisma --script
--
-- CÓMO APLICARLO (después de revisar):
--   cd apps/web && set -a && source .env.production.local && set +a
--   psql "$DIRECT_URL" -f ../../scripts/sql/labelitem.sql
--   (DIRECT_URL = puerto 5432, sin pgbouncer — DDL no va por el pooler)
--
--   Alternativa equivalente, ver runbook §6:
--   prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script
--   (debería imprimir exactamente este mismo bloque; si imprime algo más,
--    PARAR: el schema local drifteó respecto de prod por otra cosa)
--
-- DESPUÉS de aplicarlo hay que correr `prisma generate` y recién ahí desplegar
-- worker + web. Al revés (deploy antes que la tabla) el worker escribe contra
-- una tabla inexistente: la captura está envuelta en try/catch y sólo loguea
-- un warn, pero se pierden los ítems de todos los envíos de esa ventana.

BEGIN;

-- CreateTable
CREATE TABLE "LabelItem" (
    "id" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabelItem_labelId_idx" ON "LabelItem"("labelId");

-- AddForeignKey
ALTER TABLE "LabelItem" ADD CONSTRAINT "LabelItem_labelId_fkey"
    FOREIGN KEY ("labelId") REFERENCES "Label"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;

-- ── ROLLBACK (si hiciera falta deshacerlo) ───────────────────────────────────
-- Borra los snapshots capturados hasta ese momento; el resto del sistema no
-- depende de esta tabla (la captura es best-effort y el export devuelve los
-- labels sin ítems en "sin_items").
--
-- BEGIN;
-- DROP TABLE "LabelItem";
-- COMMIT;
