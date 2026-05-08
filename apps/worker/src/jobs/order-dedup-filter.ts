// Pure filter logic for the cross-tenant duplicate-prevention gate. Extracted
// so it can be unit-tested independently from the giant processOrders function
// + its DB dependencies.
//
// Contract: given the current tenant's id, the set of Shopify orders Shopify
// returned as unfulfilled, and ALL COMPLETED Labels for tenants that share
// the same shopifyStoreUrl, return the orders we should keep processing and
// the diagnostic record of what we skipped (and whether the skip was caused
// by a sibling tenant pointing at the same shop — that's the load-bearing
// signal for the cross-tenant duplicate-shipping incident).

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
