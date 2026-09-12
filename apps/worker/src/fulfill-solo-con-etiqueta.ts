/**
 * "Preparado" en Shopify tiene que significar que la etiqueta EXISTE y se puede
 * imprimir — no sólo que DAC emitió la guía.
 *
 * POR QUÉ. Emitir la guía en DAC y tener el PDF imprimible son dos pasos
 * distintos. Hasta hoy el fulfillment se disparaba con el PRIMERO: si el segundo
 * fallaba, el pedido le quedaba al comerciante en verde ("preparado") mientras el
 * portal mostraba "Sin PDF". No podía imprimir, el paquete no salía, y nada se lo
 * avisaba: se enteraba por el reclamo del comprador. El propio job ya sabía que
 * eso había salido mal —marca `NEEDS_REVIEW` y NO le cobra al comerciante (la
 * guarda de facturación de process-orders.job.ts)— pero igual le decía a Shopify
 * que estaba preparado. Esta es la otra mitad de ese arreglo.
 *
 * QUÉ CAMBIA. Sin PDF no se fulfillea: el pedido queda SIN PREPARAR (amarillo) en
 * la lista de Shopify, que es donde el comerciante mira todos los días, y además
 * se lo taggea `SIN ETIQUETA` (sin-etiqueta-tag.job.ts, ya en producción).
 * Cuando la etiqueta se recupera, `finalize-recovered-guias.ts` hace el fulfill y
 * manda el tracking en ese momento — el circuito ya existe y no se toca acá.
 *
 * ESCOTILLA, SIN MIGRACIÓN. Una tienda que imprima directo del portal de DAC (y
 * que por lo tanto despacha aunque LabelFlow no tenga el PDF) puede volver al
 * comportamiento viejo sin tocar el schema ni redeployar código: se agrega su
 * `tenantId` a la env var `FULFILL_SIN_PDF_TENANTS` del worker, separado por
 * comas, y se reinicia el servicio.
 *
 * Reportado por el dueño de Kinevia y Todo a Mano (11-09-2026), sobre el mismo
 * incidente que motivó el tag SIN ETIQUETA el 10-09.
 */

/**
 * ¿Esta tienda pidió explícitamente seguir marcando "preparado" aunque no haya
 * PDF? Por defecto NO: sin etiqueta imprimible, el pedido no se fulfillea.
 */
export function permiteFulfillSinPdf(tenantId: string): boolean {
  const crudo = process.env.FULFILL_SIN_PDF_TENANTS ?? '';
  if (!crudo.trim()) return false;
  return crudo
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .includes(tenantId);
}

/**
 * LA REGLA, en un solo lugar: ¿se puede marcar este pedido como preparado?
 *
 * Vive acá y no suelta en cada job a propósito: el mismo defecto estaba
 * duplicado en `process-orders.job.ts` y en `agent-bulk-upload.job.ts`, y los
 * dos tienen que cambiar juntos. Hay tests que fijan que ambos pasen por acá.
 */
export function etiquetaEsImprimible(pdfUploaded: boolean, tenantId: string): boolean {
  return pdfUploaded || permiteFulfillSinPdf(tenantId);
}
