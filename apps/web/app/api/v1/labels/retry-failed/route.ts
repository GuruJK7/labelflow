import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { maybeReconcileStuck } from '@/lib/shopify-reconcile';
import { getStuckBreakdown } from '@/lib/stuck-labels';
import { runRetryForTenant } from '@/lib/retry-runner';

/**
 * POST /api/v1/labels/retry-failed   { count: number }
 * GET  /api/v1/labels/retry-failed   -> { count, total, ...breakdown }
 *
 * Operator-initiated "Reintentar envios" action. Unblocks the N oldest
 * shipments that NEVER got a real DAC guia (sin guia) and triggers a worker
 * run so they are re-attempted with the current fixes.
 *
 * The actual unblock + re-run lives in lib/retry-runner (runRetryForTenant),
 * shared with the multi-store control dashboard so the safety logic (only
 * `retryable`-class labels, C-4 PendingShipment guard) can never drift. The
 * classification itself is in lib/stuck-labels (single source of truth).
 *
 * Safety:
 *   - Tenant-scoped: only the authenticated tenant's labels are touched.
 *   - Plan-active gate mirrors POST /api/v1/jobs (credit-holder tenant).
 *   - Non-retryable cases (orphan / remitente) are excluded so a retry never
 *     double-ships (see classifyStuck).
 */

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Keep the count honest: flag stuck rows whose Shopify order is already
  // fulfilled/closed/cancelled (resolved outside our pipeline) so they drop
  // out. Throttled (max once / 30 min / tenant) so a polling dashboard cannot
  // hammer Shopify; never throws.
  await maybeReconcileStuck(auth.tenantId);

  // `count` stays = retryable for back-compat with existing callers; `total` +
  // per-class counts let the dashboard show the REAL number and route each class.
  return apiSuccess(await getStuckBreakdown(auth.tenantId));
}

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);
  const tenantId = auth.tenantId;

  let count = 5;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.count) && body.count > 0 && body.count <= 50) {
      count = body.count;
    }
  } catch {
    // No body / invalid JSON — keep the default.
  }

  // Plan-active gate — same model as POST /api/v1/jobs: billing flags live
  // on the credit-holder tenant (oldest one).
  const holderId = await getCreditHolderTenantId(tenantId);
  const holder = await db.tenant.findUnique({
    where: { id: holderId },
    select: { isActive: true, subscriptionStatus: true },
  });
  if (!holder) return apiError('Tenant no encontrado', 404);
  if (!holder.isActive || holder.subscriptionStatus !== 'ACTIVE') {
    return apiError('Tu plan no esta activo. Activa una suscripcion para reintentar envios.', 403);
  }

  const result = await runRetryForTenant(tenantId, count);
  return apiSuccess(result);
}
