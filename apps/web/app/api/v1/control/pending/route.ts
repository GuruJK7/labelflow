/**
 * GET /api/v1/control/pending          (cached ~2 min per store)
 * GET /api/v1/control/pending?force=1  (bypass cache)
 *
 * "Pedidos para completar" — the live Shopify backlog (paid, open, unfulfilled)
 * per store. Separate from /overview because it makes one Shopify API call per
 * store; it is throttled (lib/shopify-pending cache) and the dashboard calls it
 * on load + manual refresh, NOT on the fast poll loop, to respect rate limits.
 */

import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';
import { getUnfulfilledCount } from '@/lib/shopify-pending';
import { maybeReconcileStuck } from '@/lib/shopify-reconcile';

export async function GET(req: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const { searchParams } = new URL(req.url);
  const force = searchParams.get('force') === '1';

  const tenants = await db.tenant.findMany({
    where: { userId: auth.userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  // Fetch the live backlog counts AND (slow path only) reconcile each store's
  // stuck labels against Shopify, so the multi-store "sin completar" numbers in
  // /overview converge to the single-store widget (terminal-done orders drop
  // out). maybeReconcileStuck is throttled (once/30min/tenant) and never throws;
  // this endpoint is NOT on the fast poll loop, so it can afford the call.
  const [results] = await Promise.all([
    Promise.all(tenants.map((t) => getUnfulfilledCount(t.id, force))),
    Promise.all(tenants.map((t) => maybeReconcileStuck(t.id))),
  ]);

  return apiSuccess({
    pending: results.map((r) => ({
      tenantId: r.tenantId,
      count: r.count,
      cached: r.cached,
      skipped: r.skipped ?? null,
    })),
  });
}
