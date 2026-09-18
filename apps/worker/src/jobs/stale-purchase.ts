/**
 * ¿Cuándo una `CreditPurchase` en PENDING ya no se va a aprobar nunca?
 *
 * 🔴 POR QUÉ EXISTE ESTE ARCHIVO. El barrido de `reconcile.job.ts` usaba un
 * único corte de 24 h para todos los rieles, con un comentario que razonaba
 * sólo sobre MercadoPago («la preferencia MP expira a 24h»). El riel de
 * Shopify llegó después (02-09) y nadie tocó el corte — pero Shopify le da al
 * comerciante DOS DÍAS para aprobar el cargo:
 *
 *   «EXPIRED — The app purchase was not accepted within two days of being
 *    created.» (AppPurchaseStatus, shopify.dev)
 *
 * O sea que entre la hora 24 y la 48 había una ventana de 24 h en la que el
 * barrido ya había marcado la fila FAILED y el cargo de Shopify todavía se
 * podía aprobar. Si el comerciante aprobaba ahí: Shopify le cobraba de verdad,
 * `settlePaidPurchase` no acreditaba nada (su `updateMany` exige PENDING) y no
 * saltaba ninguna alerta. Cobro real, cero envíos.
 *
 * El caso no es hipotético: el cargo 3466854650 de la app pública vivió como
 * PENDING desde el 14-09 hasta que Shopify lo venció el 17-09 — tres días.
 *
 * DECISIÓN. El corte pasa a depender del riel, que se lee del prefijo de
 * `mpExternalRef` (`shopify|`, `whop|`, o MercadoPago). Es el mismo patrón que
 * ya usan los handlers de Whop para no pisar filas de otro riel.
 */

export type Riel = 'shopify' | 'whop' | 'mercadopago';

/**
 * Cuánto esperamos, por riel, antes de dar una compra por abandonada.
 *
 * - `mercadopago`: la preferencia expira a las 24 h por default. Sin cambios.
 * - `whop`: sin cambios respecto del comportamiento histórico (24 h). No se
 *   tocó a propósito: cambiarlo sería otro arreglo, con su propia evidencia.
 * - `shopify`: 48 h de ventana documentada + 1 h de gracia, porque el barrido
 *   corre cada 10 min y el timestamp del vencimiento del lado de Shopify no
 *   coincide al minuto con el nuestro (el cargo 3466854650 se creó el 14-09 y
 *   Shopify recién lo marcó vencido el 17-09 08:00). La gracia hace que el
 *   barrido nunca le gane de mano a Shopify.
 */
export const VENTANA_POR_RIEL_MS: Record<Riel, number> = {
  mercadopago: 24 * 60 * 60 * 1000,
  whop: 24 * 60 * 60 * 1000,
  shopify: 49 * 60 * 60 * 1000,
};

/** El corte más corto de todos: sirve de pre-filtro barato en la query. */
export const VENTANA_MINIMA_MS = Math.min(...Object.values(VENTANA_POR_RIEL_MS));

/**
 * De qué riel es la compra, leído del prefijo de `mpExternalRef`.
 *
 * El formato lo escribe cada checkout: `shopify|<id>`, `whop|<id>`, y
 * `pkg|<id>` para MercadoPago. Cualquier cosa que no reconozcamos cae en
 * `mercadopago`, que es el comportamiento histórico del barrido.
 */
export function rielDeCompra(mpExternalRef: string | null | undefined): Riel {
  if (typeof mpExternalRef !== 'string') return 'mercadopago';
  if (mpExternalRef.startsWith('shopify|')) return 'shopify';
  if (mpExternalRef.startsWith('whop|')) return 'whop';
  return 'mercadopago';
}

export interface CompraCandidata {
  mpExternalRef: string | null;
  createdAt: Date;
}

/**
 * `true` si la compra ya está fuera de la ventana de su riel y se puede marcar
 * FAILED sin riesgo de pisar un pago que todavía puede entrar.
 */
export function esCompraAbandonada(compra: CompraCandidata, ahora: Date): boolean {
  const ventanaMs = VENTANA_POR_RIEL_MS[rielDeCompra(compra.mpExternalRef)];
  const edadMs = ahora.getTime() - compra.createdAt.getTime();
  return edadMs >= ventanaMs;
}
