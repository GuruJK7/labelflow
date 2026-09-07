-- JobType.RECOVER_PDFS — el job que re-baja de DAC los PDFs faltantes.
-- [06-09-2026]
--
-- Aditivo y seguro: agregar un valor a un enum no toca ninguna fila existente
-- y el código desplegado que no lo conoce simplemente nunca lo produce.
--
-- 🔴 `ALTER TYPE ... ADD VALUE` no corre dentro de una transacción en Postgres
-- < 12; en 12+ sí, pero el valor nuevo no se puede usar en la MISMA
-- transacción que lo crea. Por eso va suelto.
--
-- Motivo: la recuperación necesita loguearse en DAC, que exige resolver un
-- reCAPTCHA con `CAPTCHA_API_KEY` — una variable que sólo existe en el worker
-- de Render. Como job, corre ahí con todas sus variables y ninguna clave tiene
-- que salir del servicio.

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'RECOVER_PDFS';

-- Verificación:
--   select unnest(enum_range(NULL::"JobType"));
--
-- Encolar una corrida (ejemplo: últimos 3 días):
--   INSERT INTO "Job" (id, "tenantId", type, status, trigger, "createdAt")
--   VALUES (gen_random_uuid()::text, '<tenantId>', 'RECOVER_PDFS', 'PENDING', 'MANUAL', NOW());
--   INSERT INTO "RunLog" (id, "jobId", "tenantId", level, message, meta, "createdAt")
--   VALUES (gen_random_uuid()::text, '<jobId>', '<tenantId>', 'INFO',
--           'recoverPdfsOpts', '{"dias":3}'::jsonb, NOW());
