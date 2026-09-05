import { AxiosInstance } from 'axios';
import { ShopifyOrder } from './types';
import logger from '../logger';

const PROCESSED_TAG = 'RASTREO ENVIADO';
const GUIA_NOTE_PREFIX = 'LabelFlow-GUIA:';

/**
 * Returns Shopify orders that Shopify itself considers unfulfilled.
 *
 * ── 2026-04-22 post-run audit ──────────────────────────────────────────────
 * Shopify's `fulfillment_status=unfulfilled` is the single source of truth
 * for "this order still needs a shipment". If an operator manually cancels a
 * bad fulfillment in Shopify (to redo it — e.g. wrong address was printed),
 * that order returns to the unfulfilled set and we MUST reprocess it.
 *
 * Prior to this audit, we additionally filtered out orders carrying the
 * "RASTREO ENVIADO" tag or a "LabelFlow-GUIA:" note. That tag/note survives
 * a manual unfulfill, so the worker silently skipped orders the operator had
 * explicitly asked to redo — forcing them to hunt through Shopify tags + DB
 * Prisma Studio to unstick each one. The tag/note filter is removed.
 *
 * Safety: every active tenant has `fulfillMode` = "on" | "always", so a
 * successful processing always fulfills the order in Shopify, which takes it
 * out of `fulfillment_status=unfulfilled` automatically. The tag/note thus
 * became redundant as a skip signal and was only blocking the legitimate
 * reprocess flow.
 *
 * If a future tenant sets `fulfillMode: "off"`, their orders will loop here
 * (we'd create a new DAC shipment every cron tick). The DB-side filter in
 * `process-orders.job.ts` also no longer skips COMPLETED labels for the same
 * reason; a `fulfillMode=off` tenant would need a dedicated opt-in guard
 * added later.
 */
/**
 * Estados de pago que se pueden despachar cuando la tienda COBRA AL ENTREGAR.
 *
 * `pending` es el estado en el que Shopify deja un pedido contra entrega: no se
 * cobró nada todavía y se cobra al entregar. Una tienda que vende así genera
 * TODOS sus pedidos en `pending`, así que con el filtro fijo en `paid` el
 * pipeline no veía ni uno.
 *
 * 🔴 `refunded`, `voided` y `partially_refunded` quedan AFUERA a propósito: son
 * pedidos que se cancelaron o se devolvieron, y despacharlos es mandar
 * mercadería por una venta que no existe.
 */
const ESTADOS_DESPACHABLES_CONTRAENTREGA = new Set(['paid', 'pending']);

/**
 * Cuántos pedidos trae una corrida cuando NO se pidió "Todos".
 *
 * Es el tope histórico y se mantiene tal cual: una corrida con tope de 5, 10 o
 * 20 nunca necesitó más de una página.
 */
export const PAGINA_REST = 250;

/**
 * Techo de una corrida "Todos". Existe para que un error de filtro no barra la
 * tienda entera; cuando se toca, se AVISA (no se corta en silencio).
 * `SHOPIFY_TOPE_TODOS` lo sube si alguna tienda lo necesita.
 */
export const TOPE_TRAIDA_TODOS = (() => {
  const n = Number.parseInt((process.env.SHOPIFY_TOPE_TODOS ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();

/**
 * El `page_info` de la página siguiente, leído del header `Link` de Shopify.
 *
 * 🔴 Sin esto, `getUnfulfilledOrders` hacía UNA sola llamada con `limit=250` y
 * devolvía lo que entrara. Una tienda con 400 pendientes veía 250 y las otras
 * 150 no existían para el job — sin un log, sin un contador, sin nada. El
 * usuario apretaba "Todos" y se despachaban 250.
 *
 * Formato real: `<https://x.myshopify.com/admin/api/2026-07/orders.json?limit=250&page_info=abc>; rel="next"`
 * (puede venir junto al `rel="previous"`, separados por coma).
 */
export function siguientePageInfo(link: unknown): string | null {
  if (typeof link !== 'string' || !link) return null;
  for (const parte of link.split(',')) {
    const m = parte.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!m) continue;
    try {
      return new URL(m[1]).searchParams.get('page_info');
    } catch {
      return null;
    }
  }
  return null;
}

export async function getUnfulfilledOrders(
  client: AxiosInstance,
  sortDirection: 'oldest_first' | 'newest_first' = 'oldest_first',
  /**
   * `true` SÓLO para tiendas que cobran al entregar (`Tenant.codEnabled`).
   *
   * Default `false` a propósito: el comportamiento histórico —y el de las 33
   * tiendas que hay hoy— es despachar únicamente lo ya cobrado. Prenderlo es
   * una decisión explícita del comerciante, no algo que se deduzca.
   */
  incluirNoPagados = false,
  /**
   * Cuántos pedidos como máximo devolver. Default `PAGINA_REST` (250) = el
   * comportamiento histórico exacto. Una corrida "Todos" pasa
   * `TOPE_TRAIDA_TODOS` y entonces SÍ se paginan las páginas siguientes.
   */
  tope: number = PAGINA_REST,
): Promise<ShopifyOrder[]> {
  const limite = Math.max(1, Math.floor(tope));
  const paramsBase = {
    // REST no acepta dos valores en `financial_status`, así que para el caso
    // contra entrega se pide `any` y se filtra abajo con la lista blanca.
    // Pedir `any` sin filtrar traería reembolsados y anulados.
    financial_status: incluirNoPagados ? 'any' : 'paid',
    fulfillment_status: 'unfulfilled',
    status: 'open',
    limit: Math.min(limite, PAGINA_REST),
    order: sortDirection === 'newest_first' ? 'created_at desc' : 'created_at asc',
  };

  const crudas: ShopifyOrder[] = [];
  // Shopify sólo acepta `limit`, `fields` y `page_info` en las páginas
  // siguientes: mandarle de nuevo los filtros devuelve 400. Por eso la primera
  // request lleva `paramsBase` y las demás sólo el cursor.
  let params: Record<string, unknown> = paramsBase;
  let paginas = 0;
  let cortadoPorTope = false;

  while (crudas.length < limite) {
    const res = await client.get('/orders.json', { params });
    const pagina: ShopifyOrder[] = res.data?.orders ?? [];
    crudas.push(...pagina);
    paginas++;

    const cursor = siguientePageInfo(res.headers?.link ?? (res.headers as Record<string, unknown>)?.Link);
    if (pagina.length === 0 || !cursor) break;
    if (crudas.length >= limite) {
      // Hay más páginas del otro lado y no las vamos a pedir: eso es un recorte
      // y se dice en voz alta.
      cortadoPorTope = true;
      break;
    }
    params = { limit: paramsBase.limit, page_info: cursor };
  }

  if (crudas.length > limite) crudas.length = limite;

  if (cortadoPorTope) {
    logger.warn(
      { traidos: crudas.length, tope: limite, paginas },
      'Shopify tiene MÁS pedidos sin despachar de los que entra esta corrida: se cortó en el tope. ' +
        'Volvé a ejecutar para seguir, o subí SHOPIFY_TOPE_TODOS.',
    );
  }

  const orders: ShopifyOrder[] = incluirNoPagados
    ? crudas.filter((o) => ESTADOS_DESPACHABLES_CONTRAENTREGA.has((o.financial_status ?? '').toLowerCase()))
    : crudas;

  if (incluirNoPagados && crudas.length !== orders.length) {
    logger.info(
      { descartados: crudas.length - orders.length, total: crudas.length },
      'Contra entrega: se descartaron pedidos reembolsados/anulados que Shopify devolvió con financial_status=any',
    );
  }

  logger.info(
    { traidos: orders.length, paginas, tope: limite, cortadoPorTope },
    'Shopify REST: pedidos sin despachar traídos',
  );

  // Telemetry: log when we're handing back orders that were previously
  // processed (carry our tag or note). This used to be a skip condition;
  // now it's a breadcrumb so an audit of reprocess activity is cheap.
  let reprocessCandidates = 0;
  for (const order of orders) {
    const tags = order.tags.split(',').map((t) => t.trim().toLowerCase());
    const hasProcessedTag =
      tags.includes(PROCESSED_TAG.toLowerCase()) ||
      tags.includes('labelflow-procesado');
    const hasGuiaNote = order.note?.includes(GUIA_NOTE_PREFIX) ?? false;
    if (hasProcessedTag || hasGuiaNote) reprocessCandidates++;
  }
  if (reprocessCandidates > 0) {
    logger.info(
      { reprocessCandidates, totalUnfulfilled: orders.length },
      'Shopify returned orders that were previously processed (tag/note still present). ' +
        'Treating as reprocess — Shopify unfulfilled status is authoritative.',
    );
  }

  return orders;
}

/**
 * Fetches the most recent N orders regardless of fulfillment status.
 * Used for TEST mode only — does not filter by tags or status.
 */
export async function getRecentOrders(
  client: AxiosInstance,
  limit: number = 5,
): Promise<ShopifyOrder[]> {
  const { data } = await client.get('/orders.json', {
    params: {
      status: 'any',
      limit,
      order: 'created_at desc',
    },
  });

  return data.orders ?? [];
}

export async function addOrderTag(client: AxiosInstance, orderId: number, tag: string): Promise<void> {
  // APPEND tag to existing tags (never destroy existing ones)
  const { data } = await client.get(`/orders/${orderId}.json`);
  const currentTags: string = data.order?.tags ?? '';
  const tagList = currentTags.split(',').map((t: string) => t.trim()).filter(Boolean);

  // Avoid duplicate tags
  if (!tagList.some((t: string) => t.toLowerCase() === tag.toLowerCase())) {
    tagList.push(tag);
  }

  await client.put(`/orders/${orderId}.json`, {
    order: { id: orderId, tags: tagList.join(', ') },
  });
}

export async function addOrderNote(client: AxiosInstance, orderId: number, noteText: string): Promise<void> {
  const { data } = await client.get(`/orders/${orderId}.json`);
  const currentNote: string = data.order?.note ?? '';
  const updatedNote = currentNote ? `${currentNote}\n${noteText}` : noteText;

  await client.put(`/orders/${orderId}.json`, {
    order: { id: orderId, note: updatedNote },
  });
}

export async function markOrderProcessed(
  client: AxiosInstance,
  orderId: number,
  guia: string
): Promise<void> {
  await addOrderTag(client, orderId, PROCESSED_TAG);
  await addOrderNote(client, orderId, `${GUIA_NOTE_PREFIX} ${guia} | ${new Date().toISOString()}`);
  logger.info({ orderId, guia }, 'Order marked as processed in Shopify');
}
