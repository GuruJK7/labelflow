import { ShopifyOrder } from './types';

/**
 * Resolve the best customer contact phone for a Shopify order.
 *
 * Audit 2026-05-12 — root-cause for "DAC courier had no number to call":
 * the DAC label code only ever read `shipping_address.phone`. But Shopify
 * scatters the customer's phone across up to five fields depending on how the
 * order was placed (web checkout, draft order, POS, phone order, account with
 * a saved address). Any order whose phone lived in a different field reached
 * DAC with the `099000000` placeholder from cleanPhone() — so the courier had
 * no real number, defeating the whole "que el cadete se comunique con el
 * cliente" directive.
 *
 * This walks every known phone location in priority order and returns the
 * first value that carries a usable number (>= 6 digits). Priority is
 * most-delivery-specific first, but every fallback is still the order-placer's
 * own number — precisely who the courier should call:
 *
 *   1. shipping_address.phone        — the number tied to THIS delivery
 *   2. billing_address.phone         — same payer, usually the same person
 *   3. customer.phone                — account-level contact (the buyer)
 *   4. order.phone                   — top-level checkout / SMS phone
 *   5. customer.default_address.phone — last-resort saved-address phone
 *
 * Returns `undefined` when no field carries a usable number, so callers can
 * fall back to cleanPhone()'s placeholder exactly as before (no behaviour
 * change for the genuinely-phoneless order).
 *
 * Pure function: no I/O, trivially unit-testable.
 */
export function resolveOrderPhone(
  order: Pick<
    ShopifyOrder,
    'phone' | 'shipping_address' | 'billing_address' | 'customer'
  >,
): string | undefined {
  const candidates: Array<string | null | undefined> = [
    order.shipping_address?.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.phone,
    order.customer?.default_address?.phone,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const digitCount = (candidate.match(/\d/g) ?? []).length;
    // Require >= 6 digits so we skip junk like "-" or "n/a" and only return a
    // number cleanPhone() would actually keep (it floors at 6 digits too).
    if (digitCount >= 6) return candidate.trim();
  }

  return undefined;
}
