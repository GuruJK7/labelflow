// Pure filter logic for the cross-tenant duplicate-prevention gate. Extracted
// so it can be unit-tested independently from the giant processOrders function
// + its DB dependencies.
//
// Three filters live here:
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
//
// 3. partitionByStuckPendingShipment — added 2026-05-11 after the Nueva
//    tienda batch-starvation incident. The C-4 guard inside DAC's
//    assertNoPriorSubmit blocks orders with PendingShipment.status in
//    ['PENDING','ORPHANED'] FOREVER (the safe default — those orders might
//    have an orphan guía in DAC historial we never linked). Problem: those
//    blocked orders STILL stay unfulfilled in Shopify and STILL come back
//    every cron tick. Shopify's newest_first sort puts them at the top of
//    the unfulfilled list, the limit cap takes the first N, and every cycle
//    gets `0 success / N failed / 0 skipped` — real new orders never get
//    processed. The fix is to skip them at the FILTER level (before the
//    limit cap) so they stop consuming batch capacity. The C-4 guard inside
//    shipment.ts is kept intact as defence-in-depth — this filter just
//    means the C-4 guard rarely needs to fire. Operator unblocks via the
//    dashboard "Reenviar" action or by deleting the PendingShipment row.

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

// ── Stuck PendingShipment skip (2026-05-11) ──────────────────────────────

/**
 * A PendingShipment row whose status is ambiguous (PENDING or ORPHANED) and
 * therefore blocks re-submission via the C-4 guard inside shipment.ts. Those
 * orders need OPERATOR reconciliation (check DAC historial, link an orphan
 * guía or delete the row). Until that happens, we skip them at the cron
 * filter level so they don't fill up batch slots.
 *
 * status meaning:
 *   - PENDING:  worker started, never reported back. Likely the worker
 *               crashed/timed out mid-Finalizar. DAC may or may not have
 *               minted a guía.
 *   - ORPHANED: worker finished but rescue path could not link the guía
 *               (silent reject + historial scan exhausted). Guía MIGHT
 *               exist in DAC under a different recipient match.
 */
export type StuckPendingShipment = {
  shopifyOrderId: string;
  status: 'PENDING' | 'ORPHANED';
  resolvedGuia: string | null;
  submitAttemptedAt: Date;
};

export type StuckPendingSkipRecord = {
  orderName: string;
  status: 'PENDING' | 'ORPHANED';
  guia: string | null;
  ageMs: number;
};

/**
 * Skip orders that have a PendingShipment in PENDING or ORPHANED state.
 * RESOLVED rows are NOT skipped here — the C-4 guard inside shipment.ts
 * handles those (recent ones block, >72h auto-clears). We only short-circuit
 * the ambiguous statuses, which are the ones that would always re-block
 * downstream and waste batch capacity.
 *
 * @param now Reference timestamp for age computation. Defaults to Date.now().
 *            Injected as a parameter so unit tests can pin time deterministically.
 */
export function partitionByStuckPendingShipment<T extends ShopifyOrderLike>(
  orders: T[],
  stuckShipments: StuckPendingShipment[],
  now: number = Date.now(),
): { kept: T[]; skipped: StuckPendingSkipRecord[] } {
  const stuckByOrderId = new Map<string, StuckPendingShipment>(
    stuckShipments.map((s) => [s.shopifyOrderId, s] as const),
  );

  const skipped: StuckPendingSkipRecord[] = [];
  const kept = orders.filter((o) => {
    const prev = stuckByOrderId.get(String(o.id));
    if (!prev) return true;
    skipped.push({
      orderName: o.name,
      status: prev.status,
      guia: prev.resolvedGuia,
      ageMs: now - prev.submitAttemptedAt.getTime(),
    });
    return false;
  });

  return { kept, skipped };
}
