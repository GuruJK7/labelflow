/**
 * Contrareembolso (COD) — lado web.  [01-sep-2026]
 *
 * ⚠️ COPIA DELIBERADA de apps/worker/src/dac/contrarreembolso.ts.
 * Mismo motivo que DEPARTAMENTOS_REPARTO_PROPIO / esRepartoPropio, duplicado en
 * apps/worker/src/self-delivery/zone.ts: apps/web y apps/worker se compilan y se
 * empaquetan por separado (el Dockerfile del worker no incluye packages/), así que
 * un import cruzado entre apps typechequea pero explota al resolver módulos.
 *
 * 🔴 SI TOCÁS UNO, TOCÁ EL OTRO. La fuente de verdad de los valores del formulario
 * de DAC (TipoGuia=6, CostoMercaderia) es la versión del worker; acá vive sólo lo
 * que la web necesita para MOSTRAR y FILTRAR, nunca para llenar el formulario.
 */

/** Tope de cordura. Igual que en el worker. */
export const COD_MONTO_MAX = 500_000;

/**
 * ¿Esta guía es contrareembolso? Mismo criterio que planDeCod() del worker:
 * todo lo dudoso (null, 0, negativo, NaN, fuera de tope) es NO.
 */
export function esContrareembolso(codAmount?: number | null): boolean {
  if (codAmount === null || codAmount === undefined) return false;
  if (typeof codAmount !== 'number' || !Number.isFinite(codAmount)) return false;
  const entero = Math.round(codAmount);
  return entero > 0 && entero <= COD_MONTO_MAX;
}

/** Etiqueta para la UI. Reemplaza al ternario binario que mostraba cualquier
 *  cosa distinta de REMITENTE como "Destinatario". */
export function etiquetaDePago(paymentType: string | null | undefined, codAmount?: number | null): string {
  if (esContrareembolso(codAmount)) return 'Contrareembolso';
  return paymentType === 'REMITENTE' ? 'Remitente' : 'Destinatario';
}
