-- indices-borrado-tienda.sql — 05-09-2026
--
-- POR QUÉ. Eliminar una tienda desde /control moría SIEMPRE con
-- «Vercel Runtime Timeout Error: Task timed out after 60 seconds», sin importar
-- cuán chica fuera la tienda. Evidencia del log de producción:
--
--   03:06:32  DELETE /api/v1/tenants/cmsht1ls90003gqtdq3a2dmag  504
--             Vercel Runtime Timeout Error: Task timed out after 60 seconds
--
-- LA CAUSA. `RunLog.jobId` y `Label.jobId` son FK a Job y NO tenían índice.
-- Postgres valida esas FK por CADA fila de Job borrada, y sin índice cada
-- validación es un Seq Scan de la tabla entera. Medido:
--
--   explain analyze select 1 from "RunLog" where "jobId" = 'no-existe' limit 1;
--     Seq Scan ... Rows Removed by Filter: 1559508
--     Execution Time: 13268.622 ms      <-- UNA búsqueda
--
-- Una tienda con 2.590 jobs implicaba ~2.590 de esos escaneos. Imposible en 60 s.
--
-- DESPUÉS DEL ÍNDICE: la misma búsqueda tarda 0,669 ms, y el teardown completo
-- (RunLog + Label + Job de esa tienda) corre en ~1 s.
--
-- CONCURRENTLY porque RunLog tiene 1,5M filas y no se puede bloquear la tabla en
-- producción. Por eso NO va dentro de una transacción: Postgres lo prohíbe.
-- Es puramente aditivo — crea índices, no toca ni una fila.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RunLog_jobId_idx" ON "RunLog" ("jobId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Label_jobId_idx"  ON "Label"  ("jobId");

-- Comprobación:
--   select indexname from pg_indexes
--   where tablename in ('RunLog','Label') and indexname like '%jobId%';
--   -- esperado: RunLog_jobId_idx, Label_jobId_idx
