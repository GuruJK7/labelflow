/**
 * Interruptor global del contrareembolso en la UI (revisión 2026-09-02).
 *
 * El toggle "Contrareembolso" promete "todas las guías salen como
 * contrareembolso", y eso sólo es cierto si el worker desplegado en Render
 * tiene el código de main que lee `tenant.codEnabled`
 * (`apps/worker/src/jobs/process-orders.job.ts`, commit df13204). El worker
 * tiene autoDeploy apagado y desde la web no se puede comprobar qué commit
 * corre, así que la promesa queda detrás de `COD_FEATURE_ENABLED` (no es
 * secreto; `true`/`1`). Apagada por defecto (fail-closed):
 *   - `GET /api/v1/settings` devuelve `codAvailable: false`,
 *   - `PUT /api/v1/settings` rechaza `codEnabled: true` con 422 (apagarlo
 *     siempre se puede),
 *   - el bloque del wizard / Configuración se muestra como "Próximamente".
 * Las columnas `Tenant.codEnabled` y `Label.codAmount` SÍ están en prod
 * (verificado 2026-09-02 por information_schema): este flag no cubre eso,
 * cubre al worker.
 */
export function codFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.COD_FEATURE_ENABLED ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}
