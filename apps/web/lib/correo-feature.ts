/**
 * Interruptor global del transportista Correo Uruguayo en la UI. [03-sep-2026]
 *
 * Mismo patrón y mismo motivo que `cod-feature.ts`: el toggle de Configuración
 * promete "todos tus envíos salen por Correo Uruguayo", y eso sólo es cierto si
 * el worker desplegado en Render tiene el código que lo honra. El worker tiene
 * autoDeploy APAGADO y desde la web no hay forma de saber qué commit corre, así
 * que la promesa queda detrás de `CORREO_FEATURE_ENABLED` (no es secreto;
 * `true`/`1`). Apagada por defecto — fail-closed:
 *   - `GET /api/v1/settings` devuelve `correoAvailable: false`,
 *   - `PUT /api/v1/settings` rechaza `correoEnabled: true` con 422 (apagarlo
 *     siempre se puede),
 *   - el bloque de Configuración se muestra como "Próximamente".
 *
 * 🔴 Sin este flag, la secuencia normal de deploy —la web sale sola al push, el
 * worker hay que dispararlo a mano— deja una ventana en la que el comerciante
 * puede prender Correo, la web se lo guarda, y el worker viejo sigue despachando
 * todo por DAC sin decir nada.
 */
export function correoFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CORREO_FEATURE_ENABLED ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}
