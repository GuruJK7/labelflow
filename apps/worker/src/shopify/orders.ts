import { AxiosInstance } from 'axios';
import { ShopifyOrder } from './types';
import logger from '../logger';

const PROCESSED_TAG = 'labelflow-procesado';
const GUIA_NOTE_PREFIX = 'LabelFlow-GUIA:';

export async function getUnfulfilledOrders(client: AxiosInstance): Promise<ShopifyOrder[]> {
  const { data } = await client.get('/orders.json', {
    params: {
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      status: 'open',
      limit: 250,
    },
  });

  const orders: ShopifyOrder[] = data.orders ?? [];

  return orders.filter((order) => {
    const tags = order.tags.split(',').map((t: string) => t.trim().toLowerCase());
    if (tags.includes(PROCESSED_TAG)) return false;
    if (order.note?.includes(GUIA_NOTE_PREFIX)) return false;
    return true;
  });
}

export async function addOrderTag(client: AxiosInstance, orderId: number, tag: string): Promise<void> {
  const { data } = await client.get(`/orders/${orderId}.json`);
  const currentTags: string = data.order?.tags ?? '';
  const tagsArray = currentTags.split(',').map((t: string) => t.trim()).filter(Boolean);

  if (tagsArray.includes(tag)) return;
  tagsArray.push(tag);

  await client.put(`/orders/${orderId}.json`, {
    order: { id: orderId, tags: tagsArray.join(', ') },
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
