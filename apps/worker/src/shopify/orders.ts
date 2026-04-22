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
export async function getUnfulfilledOrders(
  client: AxiosInstance,
  sortDirection: 'oldest_first' | 'newest_first' = 'oldest_first',
): Promise<ShopifyOrder[]> {
  const { data } = await client.get('/orders.json', {
    params: {
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      status: 'open',
      limit: 250,
      order: sortDirection === 'newest_first' ? 'created_at desc' : 'created_at asc',
    },
  });

  const orders: ShopifyOrder[] = data.orders ?? [];

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
