import { ShopifyOrder } from '../shopify/types';
import logger from '../logger';

/**
 * Determines payment type based on order total and threshold.
 * If paymentRuleEnabled is false, always returns DESTINATARIO.
 * If enabled:
 *   > threshold = REMITENTE (store pays with pre-loaded DAC card)
 *   <= threshold = DESTINATARIO (customer pays on delivery)
 */
export function determinePaymentType(
  order: ShopifyOrder,
  thresholdUyu: number,
  paymentRuleEnabled: boolean = false,
): 'REMITENTE' | 'DESTINATARIO' {
  // If payment rule is disabled, customer always pays on delivery
  if (!paymentRuleEnabled) {
    logger.info({ orderId: order.id, paymentRuleEnabled }, 'Payment rule disabled — defaulting to DESTINATARIO');
    return 'DESTINATARIO';
  }

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

  logger.info({ orderId: order.id, totalUyu, thresholdUyu, paymentType, paymentRuleEnabled }, 'Payment type determined');

  return paymentType;
}
