-- wms-deploy.sql — TODO el cambio de base de la feature WMS export, en UNA
-- transacción.
--
-- Fecha: 2026-09-01
--
-- ⚠️ NO APLICADO. Lo corre Adrian, y normalmente NO a mano: el que lo invoca es
-- `scripts/deploy-wms.sh`, que genera el token del portal, lo pasa como
-- variable de psql y después imprime el link. Correr este archivo suelto
-- requiere pasarle el token:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -v portal_token="$(openssl rand -hex 32)" \
--     -f scripts/sql/wms-deploy.sql
--
-- Es la concatenación de:
--   1. scripts/sql/labelitem.sql   — CREATE TABLE "LabelItem" (+ índice + FK)
--   2. scripts/sql/packseq.sql     — ALTER TABLE "Label" ADD COLUMN "packSeq"
--   3. la fila de client_portal_tokens que le da portal a Kinevia
-- Esos dos archivos quedan como la referencia individual de cada paso (con su
-- rollback documentado); acá van juntos y en UNA sola transacción para que un
-- fallo a mitad de camino no deje la base a medio migrar.
--
-- TODO es ADITIVO: una tabla nueva, una columna nullable nueva y una fila
-- nueva. No borra, no cambia tipos, no reescribe tablas. Se puede aplicar con
-- tráfico vivo.
--
-- 🔴 NUNCA usar `prisma db push` para esto: `client_portal_tokens` NO está en
-- el schema de Prisma (vive sólo en prod), así que un db push la BORRARÍA junto
-- con todos los portales de los clientes.
--
-- DESPUÉS de aplicarlo: `prisma generate`, y recién ahí desplegar web y worker.
-- Al revés (deploy antes que la tabla) el worker escribe contra una tabla
-- inexistente: la captura de ítems está en try/catch y sólo loguea un warn,
-- pero se pierden los ítems de todos los envíos de esa ventana.

\set ON_ERROR_STOP on

BEGIN;

-- ─────────────────────────────────────────── 1. LabelItem (labelitem.sql)

CREATE TABLE "LabelItem" (
    "id" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LabelItem_labelId_idx" ON "LabelItem"("labelId");

ALTER TABLE "LabelItem" ADD CONSTRAINT "LabelItem_labelId_fkey"
    FOREIGN KEY ("labelId") REFERENCES "Label"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────── 2. Label.packSeq (packseq.sql)

ALTER TABLE "Label" ADD COLUMN     "packSeq" INTEGER;

-- ─────────────────────────────────────────── 3. Portal de Kinevia
--
-- Kinevia no tiene fila en `client_portal_tokens` (al 2026-09-01 hay 4:
-- Curvadivina, Onix, Vastora y Aura), así que hoy no tiene link de portal — y
-- sin portal no hay impresión bulk, sin impresión bulk no hay packSeq, y sin
-- packSeq el export sale ordenado por hora de creación en vez de por la pila.
--
-- El token en claro NO se guarda: la tabla guarda su sha256 en hex, que es
-- exactamente lo que compara `resolveClientToken()`
-- (apps/web/lib/client-view.ts:160 — `createHash('sha256').update(candidate)
-- .digest('hex')`). `sha256()` es built-in de Postgres desde la 11, no hace
-- falta pgcrypto. El claro lo imprime UNA vez deploy-wms.sh en la terminal.
--
-- El tenant se resuelve por NOMBRE EXACTO acá adentro en vez de pegar un id a
-- mano: un id copiado mal crea un portal que no muestra nada y nadie se entera
-- hasta que el cliente reclama. El HAVING count(*) = 1 aborta la transacción
-- entera si hay 0 o 2+ tenants llamados "Kinevia" (ver el chequeo al final).
--
-- Idempotente: si Kinevia YA tiene un portal, no se inserta nada y el token
-- generado se descarta. Reinsertar crearía un SEGUNDO link válido para el
-- mismo cliente, que es un secreto de más dando vueltas sin que nadie lo pida.

INSERT INTO client_portal_tokens (token_hash, tenant_ids)
SELECT
  encode(sha256(convert_to(:'portal_token', 'utf8')), 'hex'),
  max(t.id)
FROM "Tenant" t
WHERE t.name = 'Kinevia'
  AND NOT EXISTS (
    SELECT 1 FROM client_portal_tokens cpt
    WHERE cpt.tenant_ids = t.id
  )
HAVING count(*) = 1;

-- Red de seguridad: si el tenant "Kinevia" no existe o está duplicado, el
-- INSERT de arriba no escribe nada y esto revienta la transacción con un
-- mensaje legible en vez de dejar el deploy "ok" y el portal inexistente.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "Tenant" WHERE name = 'Kinevia';
  IF n <> 1 THEN
    RAISE EXCEPTION 'Se esperaba EXACTAMENTE 1 tenant llamado "Kinevia" y hay %. Revisar el nombre antes de seguir.', n;
  END IF;
END $$;

COMMIT;

-- ─────────────────────────────────────────── Verificación (fuera de la tx)

\echo ''
\echo '── Verificación ──'

SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name = 'LabelItem')                         AS tabla_labelitem,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'Label' AND column_name = 'packSeq') AS columna_packseq,
  (SELECT count(*) FROM "LabelItem")                        AS filas_labelitem,
  (SELECT count(*) FROM client_portal_tokens)               AS portales_totales,
  (SELECT count(*) FROM client_portal_tokens cpt
     JOIN "Tenant" t ON t.id = cpt.tenant_ids
    WHERE t.name = 'Kinevia')                               AS portales_kinevia;

-- Esperado: tabla_labelitem=1 · columna_packseq=1 · filas_labelitem=0 (el
-- worker todavía no corrió) · portales_totales=5 · portales_kinevia=1.

-- ── ROLLBACK (si hiciera falta deshacerlo) ───────────────────────────────────
-- Los tres pasos son independientes; el orden no importa. Borrar el portal
-- invalida el link que se le pasó al cliente.
--
-- BEGIN;
-- DELETE FROM client_portal_tokens
--   WHERE tenant_ids = (SELECT id FROM "Tenant" WHERE name = 'Kinevia');
-- ALTER TABLE "Label" DROP COLUMN "packSeq";
-- DROP TABLE "LabelItem";
-- COMMIT;
