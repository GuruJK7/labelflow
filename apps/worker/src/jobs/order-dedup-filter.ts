// Pure filter logic for the cross-tenant duplicate-prevention gate. Extracted
// so it can be unit-tested independently from the giant processOrders function
// + its DB dependencies.
//
// Two filters live here:
//
// 1. partitionByCompletedLabels — the original cross-tenant filter. Skips any
//    order that already has a COMPLETED Label (any sibling tenant pointing at
//    the same Shopify shop) — the DB says we already shipped it, Shopify's
//    "unfulfilled" flag is unreliable while the fulfillment POST may be
//    failing. Load-bearing for the 2026-05-08 Aura incident: prevents
//    NuevaTienda re-billing DAC for orders Alex already fulfilled.
//
// 2. partitionByAIFeasibilityBounce — added 2026-05-09 after audit found we
//    were spending ~$8/day on AI feasibility calls. The cause: orders that
//    bounce to NEEDS_REVIEW because the AI says "address not shippable" stay
//    unfulfilled in Shopify, so every cron tick re-fetches them, calls AI
//    again, gets the same verdict, bounces again. Same address → same
//    verdict → wasted spend. This filter skips those orders UNLESS the
//    operator edited the address in Shopify (in which case re-evaluation is
//    desired). Same-address comparison is normalized (trim + lowercase) for
//    robustness against incidental whitespace/casing changes.

export type CompletedLabel = {
  shopifyOrderId: string;
  dacGuia: string | null;
  updatedAt: Date;
  tenantId: string;
};

export type ShopifyOrderLike = {
  id: number;
  name: string;
};

export type SkipRecord = {
  orderName: string;
  guia: string | null;
  completedAt: Date;
  sameTenant: boolean;
};

export function partitionByCompletedLabels<T extends ShopifyOrderLike>(
  orders: T[],
  completedLabels: CompletedLabel[],
  currentTenantId: string,
): { kept: T[]; skipped: SkipRecord[] } {
  const completedByOrderId = new Map<string, CompletedLabel>(
    completedLabels.map((l) => [l.shopifyOrderId, l] as const),
  );

  const skipped: SkipRecord[] = [];
  const kept = orders.filter((o) => {
    const prev = completedByOrderId.get(String(o.id));
    if (!prev) return true;
    skipped.push({
      orderName: o.name,
      guia: prev.dacGuia,
      completedAt: prev.updatedAt,
      sameTenant: prev.tenantId === currentTenantId,
    });
    return false;
  });

  return { kept, skipped };
}

// ── AI feasibility bounce skip (2026-05-09) ──────────────────────────────

/**
 * A NEEDS_REVIEW label whose errorMessage indicates the address was bounced
 * by `assessAddressFeasibility` (the "no se pudo interpretar" pattern). Other
 * NEEDS_REVIEW reasons (C-4 ORPHANED, REMITENTE manual, PDF upload failure,
 * possible orphan guía) are NOT included here — they have their own gates and
 * shouldn't be skipped by this filter.
 */
export type AIFeasibilityBounce = {
  shopifyOrderId: string;
  /** The address1 that was bounced — normalized comparison against current. */
  deliveryAddress: string;
  errorMessage: string | null;
  updatedAt: Date;
  tenantId: string;
};

export type StuckSkipRecord = {
  orderName: string;
  reason: string;
  bouncedAt: Date;
  sameTenant: boolean;
};

/** Conservative normalization: trim + collapse whitespace + lowercase.
 * Avoids false positives on capitalization/extra spaces while still flagging
 * any meaningful edit (number changed, street changed, additional info added).
 */
function normalizeAddress(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Filter out orders whose previous AI-feasibility verdict still applies
 * (same address1 → same verdict). Orders whose Shopify address1 changed
 * since the bounce flow through unchanged for re-evaluation.
 *
 * @param currentAddress1ByOrderId map of `String(order.id)` → current
 *                                 Shopify shipping_address.address1.
 *                                 The caller builds this from the orders array.
 */
export function partitionByAIFeasibilityBounce<T extends ShopifyOrderLike>(
  orders: T[],
  bounces: AIFeasibilityBounce[],
  currentAddress1ByOrderId: Map<string, string>,
  currentTenantId: string,
): { kept: T[]; skipped: StuckSkipRecord[] } {
  const bouncedByOrderId = new Map<string, AIFeasibilityBounce>(
    bounces.map((b) => [b.shopifyOrderId, b] as const),
  );

  const skipped: StuckSkipRecord[] = [];
  const kept = orders.filter((o) => {
    const prev = bouncedByOrderId.get(String(o.id));
    if (!prev) return true;

    const currentAddr = currentAddress1ByOrderId.get(String(o.id)) ?? '';
    const prevAddrNormalized = normalizeAddress(prev.deliveryAddress);
    const currAddrNormalized = normalizeAddress(currentAddr);

    if (prevAddrNormalized !== currAddrNormalized) {
      // Operator edited the address in Shopify — re-evaluate. Don't skip.
      return true;
    }

    // Same address as the prior bounce → same verdict → don't burn AI again.
    skipped.push({
      orderName: o.name,
      reason: prev.errorMessage ?? '',
      bouncedAt: prev.updatedAt,
      sameTenant: prev.tenantId === currentTenantId,
    });
    return false;
  });

  return { kept, skipped };
}
