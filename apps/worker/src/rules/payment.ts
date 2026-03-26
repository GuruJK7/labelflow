import { ShopifyOrder } from '../shopify/types';
import logger from '../logger';

/**
 * Determines payment type based on order total and threshold.
 * > threshold = REMITENTE (store pays shipping)
 * <= threshold = DESTINATARIO (customer pays on delivery)
 */
export function determinePaymentType(
  order: ShopifyOrder,
  thresholdUyu: number
): 'REMITENTE' | 'DESTINATARIO' {
  let totalUyu = parseFloat(order.total_price);

  if (!Number.isFinite(totalUyu)) {
    logger.warn({ orderId: order.id, totalPrice: order.total_price }, 'Invalid total_price, defaulting to 0');
    totalUyu = 0;
  }

  // Convert USD to UYU if needed (approximate rate)
  if (order.currency === 'USD') {
    totalUyu = totalUyu * 42;
    logger.warn({ orderId: order.id, currency: 'USD', convertedUyu: totalUyu }, 'USD order converted to UYU');
  }

  const paymentType = totalUyu > thresholdUyu ? 'REMITENTE' : 'DESTINATARIO';

  logger.info({ orderId: order.id, totalUyu, thresholdUyu, paymentType }, 'Payment type determined');

  return paymentType;
}
