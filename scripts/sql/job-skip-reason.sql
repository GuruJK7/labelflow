-- Job.skipReason — por qué quedaron pedidos sin despachar (05-09-2026).
--
-- Aditivo y seguro: columna nullable, sin default, sin backfill, sin índice.
-- El código desplegado HOY no la selecciona, así que se puede aplicar antes
-- del deploy sin ninguna ventana de incompatibilidad.
--
-- Motivo: `Job.skippedCount` era un número pelado. El comerciante veía
-- "180 omitidos" y no tenía forma de saber si fue el tope de la corrida, el
-- saldo, un filtro de producto o pedidos ya despachados. Con una corrida
-- "Todos" eso es una promesa incumplida y muda.

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "skipReason" TEXT;

-- Verificación:
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_name = 'Job' and column_name = 'skipReason';
--
-- Rollback (no hace falta: una columna en null no cambia ningún comportamiento):
--   ALTER TABLE "Job" DROP COLUMN IF EXISTS "skipReason";
--   🔴 Revertir la web ANTES de dropear: la web nueva la selecciona.
