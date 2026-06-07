/**
 * Shopify-fulfillment reconcile for the "Recuperar envios" count.
 *
 * ── Why this exists (2026-06-07 audit) ──────────────────────────────────────
 * A Label row goes "stuck" (status NEEDS_REVIEW/FAILED/PENDING, dacGuia=null)
 * when our pipeline could not mint a DAC guia. But the STORE can resolve that
 * same order OUTSIDE our pipeline — ship it by hand, mark it fulfilled, close
 * or cancel it in Shopify. Nothing in the worker reconciles those: the stale
 * Label lingers forever and inflates the recover count.
 *
 * Real measurement that motivated this: Curvadivina showed 82 "sin completar"
 * while only 4 were genuinely open in Shopify (unfulfilled+paid+open) — the
 * exact 4 the worker actually processes. 79 were already fulfilled/closed.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * For a tenant, it takes the stuck Labels, asks Shopify for their real status
 * in batches, and flags the ones that are TERMINAL-done (fulfilled / closed /
 * cancelled) so they drop out of the recover count.
 *
 * ── Design choices (deliberately conservative — "no rompas nada") ───────────
 *  - NO schema migration. The flag is a prefix marker on the existing
 *    `errorMessage` (RESOLVED_MARKER). Adding a column would require a
 *    `prisma db push` against prod, which can drop columns on any schema
 *    drift. A marker is zero-DDL and fully reversible (strip the prefix).
 *  - Status is NOT changed. The success-rate KPI (/api/v1/settings) counts by
 *    status and EXCLUDES SKIPPED; if we set these to SKIPPED the rate would
 *    jump. Keeping the status (NEEDS_REVIEW/FAILED/PENDING) leaves that KPI
 *    untouched — only the recover widget filters on the marker.
 *  - Only TERMINAL states are flagged. "unpaid" / "not in set" are NOT flagged
 *    (an unpaid order can still be paid + shipped later). We check the order's
 *    real fulfillment/closed/cancelled state explicitly.
 *  - Original errorMessage is preserved AFTER the marker for audit.
 *  - Fail-safe: any Shopify error throws; callers wrap in try/catch so the
 *    widget never breaks on a Shopify hiccup.
 */

import { db } from '@/lib/db';
import { decrypt } from '@/lib/encryption';

const SHOPIFY_API_VERSION = '2024-01';

/** Prefix written onto errorMessage to mark a stuck row resolved outside our pipeline. */
export const RESOLVED_MARKER = '[RESUELTO-EXTERNO]';

/** Statuses that represent "attempted but never produced a guia" (= stuck). */
const RETRYABLE_STATUSES = ['NEEDS_REVIEW', 'FAILED', 'PENDING'] as const;

/** Bound the candidate scan so a large backlog can't make this unbounded. */
const MAX_RECONCILE_SCAN = 500;
/** Shopify `ids` filter accepts up to 250 per call; stay under it. */
const SHOPIFY_ID_BATCH = 200;

/** True when a stuck Label has already been flagged resolved-externally. */
export function isResolvedExternally(errorMessage: string | null | undefined): boolean {
  return !!errorMessage && errorMessage.startsWith(RESOLVED_MARKER);
}

interface ShopifyOrderStatus {
  id: number | string;
  fulfillment_status: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
}

/**
 * Classifies a Shopify order as TERMINAL-resolved or not. Pure + unit-tested.
 * Returns the reason ('fulfilled' | 'cancelled' | 'closed') when the order is
 * done outside our pipeline, or null when it is still our responsibility
 * (genuinely open, or merely unpaid — which is non-terminal and left alone).
 */
export function classifyShopifyResolution(
  order: ShopifyOrderStatus | undefined | null,
): 'fulfilled' | 'cancelled' | 'closed' | null {
  if (!order) return null;
  // Order matters: cancelled/closed are stronger signals than fulfillment.
  if (order.cancelled_at) return 'cancelled';
  if (order.fulfillment_status === 'fulfilled') return 'fulfilled';
  if (order.closed_at) return 'closed';
  return null;
}

export interface ReconcileResult {
  tenantId: string;
  checked: number;
  markedResolved: number;
  reasons: Record<string, number>;
  notFound: number;
  skipped?: 'no-token' | 'decrypt-failed';
}

/**
 * Reconciles a tenant's stuck Labels against Shopify's real order status and
 * flags the terminal-done ones with RESOLVED_MARKER so they leave the recover
 * count. Always writes a `reconcile-shopify` RunLog (used as the throttle
 * timestamp + an audit trail), even when nothing was marked.
 */
export async function reconcileStuckAgainstShopify(tenantId: string): Promise<ReconcileResult> {
  const empty: ReconcileResult = { tenantId, checked: 0, markedResolved: 0, reasons: {}, notFound: 0 };

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });
  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) {
    return { ...empty, skipped: 'no-token' };
  }
  let token: string;
  try {
    token = decrypt(tenant.shopifyToken);
  } catch {
    return { ...empty, skipped: 'decrypt-failed' };
  }

  // Candidate stuck rows, minus any already flagged (idempotent re-runs).
  const rawCandidates = await db.label.findMany({
    where: { tenantId, dacGuia: null, status: { in: RETRYABLE_STATUSES as unknown as never } },
    orderBy: { createdAt: 'asc' },
    take: MAX_RECONCILE_SCAN,
    select: { id: true, shopifyOrderId: true, errorMessage: true },
  });
  const candidates = rawCandidates.filter((c) => !isResolvedExternally(c.errorMessage));

  // Always record a heartbeat (throttle + audit) even with nothing to do.
  if (candidates.length === 0) {
    await db.runLog.create({
      data: { tenantId, jobId: null, level: 'INFO', message: 'reconcile-shopify', meta: { checked: 0, markedResolved: 0 } },
    });
    return empty;
  }

  // Fetch real status from Shopify in batches (numeric ids only).
  const ids = candidates.map((c) => c.shopifyOrderId).filter((id) => /^\d+$/.test(id));
  const statusById = new Map<string, ShopifyOrderStatus>();
  for (let i = 0; i < ids.length; i += SHOPIFY_ID_BATCH) {
    const batch = ids.slice(i, i + SHOPIFY_ID_BATCH);
    const params = new URLSearchParams({
      ids: batch.join(','),
      status: 'any',
      limit: '250',
      fields: 'id,fulfillment_status,closed_at,cancelled_at',
    });
    const url = `https://${tenant.shopifyStoreUrl}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params}`;
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) {
      throw new Error(`Shopify orders fetch failed (${res.status}) for tenant ${tenantId}`);
    }
    const data = (await res.json()) as { orders?: ShopifyOrderStatus[] };
    for (const o of data.orders ?? []) statusById.set(String(o.id), o);
  }

  // Classify + collect the terminal-done ones.
  const reasons: Record<string, number> = {};
  let notFound = 0;
  const toMark: { id: string; reason: string; errorMessage: string | null }[] = [];
  for (const c of candidates) {
    const order = statusById.get(c.shopifyOrderId);
    if (!order) {
      notFound += 1;
      continue;
    }
    const reason = classifyShopifyResolution(order);
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      toMark.push({ id: c.id, reason, errorMessage: c.errorMessage });
    }
  }

  // Flag them: prepend the marker, preserve the original message after it.
  if (toMark.length > 0) {
    await db.$transaction(
      toMark.map((m) =>
        db.label.update({
          where: { id: m.id },
          data: { errorMessage: `${RESOLVED_MARKER}:${m.reason} ${m.errorMessage ?? ''}`.trim() },
        }),
      ),
    );
  }

  await db.runLog.create({
    data: {
      tenantId,
      jobId: null,
      level: 'INFO',
      message: 'reconcile-shopify',
      meta: { checked: candidates.length, markedResolved: toMark.length, reasons, notFound },
    },
  });

  return { tenantId, checked: candidates.length, markedResolved: toMark.length, reasons, notFound };
}

/**
 * Throttled wrapper: runs the reconcile at most once per THROTTLE window per
 * tenant, so a dashboard that polls the recover widget can't hammer Shopify.
 * Never throws — a Shopify hiccup must not break the widget.
 */
export async function maybeReconcileStuck(tenantId: string, throttleMs = 30 * 60 * 1000): Promise<void> {
  try {
    const last = await db.runLog.findFirst({
      where: { tenantId, message: 'reconcile-shopify' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < throttleMs) return;
    await reconcileStuckAgainstShopify(tenantId);
  } catch {
    // Non-fatal: keep showing the DB-derived number on any failure.
  }
}
