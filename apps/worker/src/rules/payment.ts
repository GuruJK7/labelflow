import { ShopifyOrder } from '../shopify/types';
import logger from '../logger';

/**
 * Approximate exchange rates to UYU for currencies commonly used in Uruguay Shopify stores.
 * These are conservative estimates — for orders near the threshold, the payment type
 * may be slightly wrong, but it is much better than no conversion at all.
 *
 * A human operator would check the current rate. Since we cannot call an API here
 * (this is a pure function), we use conservative rates and LOG a warning so operators
 * can review orders near the boundary.
 *
 * Last updated: 2026-04-08
 */
const EXCHANGE_RATES_TO_UYU: Record<string, number> = {
  'UYU': 1,
  'USD': 43,    // Conservative (actual ~43-44)
  'EUR': 47,    // Conservative (actual ~47-48)
  'ARS': 0.04,  // ARS is volatile — conservative
  'BRL': 8,     // Conservative
};

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

  // Guard against misconfigured threshold
  if (!Number.isFinite(thresholdUyu) || thresholdUyu <= 0) {
    logger.warn({ orderId: order.id, thresholdUyu }, 'Invalid threshold (0 or negative) — defaulting to DESTINATARIO for safety');
    return 'DESTINATARIO';
  }

  let totalUyu = parseFloat(order.total_price);

  if (!Number.isFinite(totalUyu)) {
    logger.warn({ orderId: order.id, totalPrice: order.total_price }, 'Invalid total_price, defaulting to DESTINATARIO');
    return 'DESTINATARIO';
  }

  // Guard against zero or negative totals (refunds, fully discounted orders)
  if (totalUyu <= 0) {
    logger.warn({ orderId: order.id, totalUyu }, 'Zero or negative total — defaulting to DESTINATARIO');
    return 'DESTINATARIO';
  }

  // Convert foreign currencies to UYU
  const currency = order.currency ?? 'UYU';
  if (currency !== 'UYU') {
    const rate = EXCHANGE_RATES_TO_UYU[currency];
    if (rate) {
      const originalTotal = totalUyu;
      totalUyu = totalUyu * rate;
      logger.info({ orderId: order.id, currency, rate, originalTotal, convertedUyu: totalUyu },
        `Converted ${currency} to UYU using rate ${rate}`);

      // Warn if near threshold (within 10%) — a human would double-check these
      const distancePercent = Math.abs(totalUyu - thresholdUyu) / thresholdUyu * 100;
      if (distancePercent < 10) {
        logger.warn({ orderId: order.id, totalUyu, thresholdUyu, distancePercent: distancePercent.toFixed(1) },
          `Order total near threshold after ${currency} conversion — human should verify payment type`);
      }
    } else {
      logger.warn({ orderId: order.id, currency, totalPrice: order.total_price },
        `Unknown currency "${currency}" — no conversion available, defaulting to DESTINATARIO for safety`);
      return 'DESTINATARIO';
    }
  }

  const paymentType = totalUyu > thresholdUyu ? 'REMITENTE' : 'DESTINATARIO';

  logger.info({ orderId: order.id, totalUyu, thresholdUyu, paymentType, paymentRuleEnabled, currency },
    'Payment type determined');

  return paymentType;
}
