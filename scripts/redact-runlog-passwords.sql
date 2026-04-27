-- One-shot remediation script — Audit 2026-04-27 H-04
--
-- Purga `dacPassword` y otros campos sensibles del JSON `RunLog.meta` que
-- quedaron persistidos en plaintext por el endpoint /api/v1/jobs/test-dac
-- antes del fix. El handler ahora escribe `dacPasswordSet: true` (booleano)
-- en lugar del valor; este script limpia las filas históricas.
--
-- Idempotente: usar `meta - 'key'` no falla si la clave no existe.
-- Solo afecta filas que TENGAN la clave (cláusula `?`).
--
-- Ejecutar UNA SOLA VEZ contra production:
--   psql "$DATABASE_URL" -f scripts/redact-runlog-passwords.sql
--
-- Verificación post-ejecución (debe devolver 0):
--   SELECT COUNT(*) FROM "RunLog" WHERE meta ? 'dacPassword';

BEGIN;

-- Mostrar cuántas filas tienen el campo antes de purgarlas (para el log).
SELECT COUNT(*) AS rows_with_dac_password FROM "RunLog" WHERE meta ? 'dacPassword';

-- Purga el campo `dacPassword` (operador `-` de jsonb borra una clave).
UPDATE "RunLog"
SET meta = meta - 'dacPassword'
WHERE meta ? 'dacPassword';

-- Igual para otras claves sensibles que pudieran haberse colado en logs
-- históricos (defensa en profundidad — el sanitizer de /api/v1/logs ya las
-- redacta al servir, esto las saca también del at-rest).
UPDATE "RunLog"
SET meta = meta - 'password'
WHERE meta ? 'password';

UPDATE "RunLog"
SET meta = meta - 'secret'
WHERE meta ? 'secret';

UPDATE "RunLog"
SET meta = meta - 'token'
WHERE meta ? 'token';

UPDATE "RunLog"
SET meta = meta - 'apiKey'
WHERE meta ? 'apiKey';

UPDATE "RunLog"
SET meta = meta - 'cvc'
WHERE meta ? 'cvc';

-- Verificación: estas tres queries deben devolver 0 después del COMMIT.
SELECT COUNT(*) AS remaining_dac_password FROM "RunLog" WHERE meta ? 'dacPassword';
SELECT COUNT(*) AS remaining_password FROM "RunLog" WHERE meta ? 'password';
SELECT COUNT(*) AS remaining_token FROM "RunLog" WHERE meta ? 'token';

COMMIT;
