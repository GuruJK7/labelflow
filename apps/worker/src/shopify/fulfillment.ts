import { AxiosInstance } from 'axios';
import logger from '../logger';

const DAC_TRACKING_BASE_URL = 'https://www.dac.com.uy/envios/rastrear';

/**
 * Gets all open fulfillment order IDs for a Shopify order.
 * Orders with multiple locations will have multiple fulfillment orders.
 */
async function getOpenFulfillmentOrderIds(client: AxiosInstance, orderId: number): Promise<number[]> {
  const { data } = await client.get(`/orders/${orderId}/fulfillment_orders.json`);
  const fulfillmentOrders = data.fulfillment_orders ?? [];

  const openOrders = fulfillmentOrders.filter(
    (fo: { id: number; status: string }) => fo.status === 'open'
  );

  if (openOrders.length === 0) {
    throw new Error(`No open fulfillment orders found for order ${orderId}`);
  }

  return openOrders.map((fo: { id: number }) => fo.id);
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
): Promise<void> {
  if (!guia || guia.startsWith('PENDING-')) {
    throw new Error(`Cannot fulfill order ${orderId}: invalid guia "${guia}"`);
  }

  const fulfillmentOrderIds = await getOpenFulfillmentOrderIds(client, orderId);
  const trackingUrl = `${DAC_TRACKING_BASE_URL}?guia=${encodeURIComponent(guia)}`;

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
