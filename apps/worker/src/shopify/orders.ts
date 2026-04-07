import { AxiosInstance } from 'axios';
import { ShopifyOrder } from './types';
import logger from '../logger';

const PROCESSED_TAG = 'RASTREO ENVIADO';
const GUIA_NOTE_PREFIX = 'LabelFlow-GUIA:';

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

  return orders.filter((order) => {
    const tags = order.tags.split(',').map((t: string) => t.trim().toLowerCase());
    if (tags.includes(PROCESSED_TAG.toLowerCase())) return false;
    // Also respect legacy tag
    if (tags.includes('labelflow-procesado')) return false;
    if (order.note?.includes(GUIA_NOTE_PREFIX)) return false;
    return true;
  });
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
  // Replace ALL existing tags with only the specified tag
  await client.put(`/orders/${orderId}.json`, {
    order: { id: orderId, tags: tag },
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
