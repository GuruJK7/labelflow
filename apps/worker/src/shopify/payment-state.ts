import type { ShopifyOrder } from './types';

/**
 * ¿Este pedido YA tiene la plata cobrada?
 *
 * 🔴 POR QUÉ ESTO EXISTE Y POR QUÉ VIVE ACÁ. Hasta el 04-09-2026 el pipeline
 * pedía a Shopify SÓLO pedidos `financial_status: 'paid'`, así que "el pedido
 * está pagado" era una invariante de todo el worker y varios lugares la daban
 * por sentada sin chequearla. Al abrir el filtro para las tiendas que cobran al
 * entregar (`Tenant.codEnabled`, ver shopify/orders.ts) esa invariante dejó de
 * valer, y cada lugar que decide si hay que cobrar en destino tiene que
 * preguntarlo explícitamente. Vive en `shopify/` —y no en `correo/`— porque lo
 * usan los TRES transportistas: DAC, Correo Uruguayo y reparto propio.
 *
 * Los siete estados que Shopify puede devolver (doc REST Admin API, verificada
 * el 04-09-2026): `authorized`, `pending`, `partially_paid`, `paid`,
 * `partially_refunded`, `refunded`, `voided`.
 *
 * Cuentan como COBRADOS —no se les cobra en destino— `paid`, `partially_paid` y
 * `authorized`. Los dos primeros son obvios; `authorized` es plata autorizada
 * online que el comerciante va a capturar, así que cobrarla también al entregar
 * sería cobrar dos veces.
 *
 * Cuentan como NO cobrados `pending` y el campo ausente: `pending` es el estado
 * en el que Shopify deja una venta contra entrega, y la fuente panel no manda el
 * campo porque sus pedidos son contra entrega por definición.
 *
 * `refunded`, `voided` y `partially_refunded` no se listan porque esos pedidos
 * ni siquiera se traen (ver ESTADOS_DESPACHABLES_CONTRAENTREGA): son ventas
 * canceladas y no se despachan.
 */
export function yaEstaCobrado(order: Pick<ShopifyOrder, 'financial_status'>): boolean {
  const f = (order.financial_status ?? '').trim().toLowerCase();
  return f === 'paid' || f === 'partially_paid' || f === 'authorized';
}

/**
 * Monto a cobrar al entregar, o `null` si no hay nada que cobrar.
 *
 * Devuelve null cuando el pedido ya está cobrado, cuando el total no se puede
 * leer, o cuando está en una moneda que no es peso uruguayo — los tres
 * transportistas cobran en UYU y convertir a ojo sería peor que no cobrar.
 * El llamador tiene que tratar el null de un pedido NO cobrado como una
 * anomalía y no como "no hay que cobrar".
 */
export function montoACobrarAlEntregar(
  order: Pick<ShopifyOrder, 'financial_status' | 'total_price' | 'currency'>,
): number | null {
  if (yaEstaCobrado(order)) return null;
  const moneda = (order.currency ?? '').trim().toUpperCase();
  if (moneda && moneda !== 'UYU') return null;
  const total = Math.round(parseFloat(order.total_price) || 0);
  return total > 0 ? total : null;
}
