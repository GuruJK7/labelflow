import { AxiosInstance } from 'axios';
import logger from '../logger';

const DAC_TRACKING_BASE_URL = 'https://www.dac.com.uy/envios/rastrear';

/**
 * Gets fulfillment order IDs for a Shopify order.
 * When forceAll is true, includes all non-cancelled fulfillment orders (not just "open").
 * This allows fulfilling orders regardless of their product/fulfillment status.
 */
async function getFulfillmentOrderIds(client: AxiosInstance, orderId: number, forceAll = false): Promise<number[]> {
  const { data } = await client.get(`/orders/${orderId}/fulfillment_orders.json`);
  const fulfillmentOrders = data.fulfillment_orders ?? [];

  const eligibleStatuses = forceAll
    ? ['open', 'in_progress', 'on_hold']
    : ['open'];

  const filtered = fulfillmentOrders.filter(
    (fo: { id: number; status: string }) => eligibleStatuses.includes(fo.status)
  );

  if (filtered.length === 0) {
    const allStatuses = fulfillmentOrders.map((fo: { status: string }) => fo.status).join(', ');
    throw new Error(`No fulfillable orders found for order ${orderId} (statuses: ${allStatuses || 'none'})`);
  }

  return filtered.map((fo: { id: number }) => fo.id);
}

/**
 * Creates a fulfillment in Shopify with DAC tracking info and notifies the customer.
 *
 * This marks the order as "Preparado" (Fulfilled) in Shopify, sets the tracking
 * number (guia DAC), company as "Other", the DAC tracking URL, and sends
 * Shopify's built-in fulfillment notification to the customer.
 *
 * Throws if guia is invalid (PENDING-) or if Shopify rejects the fulfillment.
 */
export async function fulfillOrderWithTracking(
  client: AxiosInstance,
  orderId: number,
  guia: string,
  dacTrackingUrl?: string,
  forceAll = false,
): Promise<void> {
  if (!guia || guia.startsWith('PENDING-')) {
    throw new Error(`Cannot fulfill order ${orderId}: invalid guia "${guia}"`);
  }

  const fulfillmentOrderIds = await getFulfillmentOrderIds(client, orderId, forceAll);
  // Use the real DAC tracking URL if available, otherwise construct fallback
  const trackingUrl = dacTrackingUrl || `${DAC_TRACKING_BASE_URL}?guia=${encodeURIComponent(guia)}`;

  const { data } = await client.post('/fulfillments.json', {
    fulfillment: {
      line_items_by_fulfillment_order: fulfillmentOrderIds.map((id) => ({
        fulfillment_order_id: id,
      })),
      tracking_info: {
        number: guia,
        url: trackingUrl,
        company: 'Other',
      },
      notify_customer: true,
    },
  });

  if (!data.fulfillment?.id) {
    throw new Error(`Shopify fulfillment creation failed: ${JSON.stringify(data.errors ?? data)}`);
  }

  logger.info({ orderId, guia, fulfillmentId: data.fulfillment.id, trackingUrl }, 'Order fulfilled in Shopify with DAC tracking');
}
