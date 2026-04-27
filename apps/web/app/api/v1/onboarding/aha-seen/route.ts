import { db } from '@/lib/db';
import {
  getAuthenticatedTenant,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';

/**
 * POST /api/v1/onboarding/aha-seen
 *
 * Called by <AhaMomentModal> when the user dismisses (or otherwise closes)
 * the first-shipment celebration. Sets Tenant.firstJobCompletedAt so the
 * dashboard layout never re-renders the modal.
 *
 * Idempotent + best-effort: a duplicate call (e.g. user double-clicks the
 * close button) just no-ops. We also tolerate "user closed the tab before
 * the request landed" — the modal is keyed on firstJobCompletedAt being
 * null AND a COMPLETED label existing, so on the next dashboard load they'd
 * see it again and dismiss it then.
 */
export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Use updateMany so the no-row case (somehow tenant is gone) returns 0
  // rows updated rather than throwing P2025. Also conditionally only set
  // firstJobCompletedAt when it's still NULL — protects against accidental
  // overwrite if the worker already wrote a more meaningful timestamp first.
  await db.tenant.updateMany({
    where: { id: auth.tenantId, firstJobCompletedAt: null },
    data: { firstJobCompletedAt: new Date() },
  });

  return apiSuccess({ ok: true });
}
