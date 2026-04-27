import { db } from '@/lib/db';
import {
  getAuthenticatedTenant,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';

/**
 * POST /api/v1/onboarding/complete
 *
 * Marks the wizard as finished. Validates that both Shopify and DAC creds
 * are actually saved before flipping the flag — otherwise the dashboard
 * gate in (dashboard)/layout.tsx would just bounce the user right back
 * here, which is worse UX than failing loudly.
 *
 * We also opportunistically activate the tenant (isActive = true) so the
 * scheduler picks them up on the next cron run. Pre-existing isActive=true
 * tenants are unchanged.
 *
 * Idempotent — calling twice is a no-op.
 */
export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      shopifyStoreUrl: true,
      shopifyToken: true,
      dacUsername: true,
      dacPassword: true,
      onboardingComplete: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  // Already done — return success but don't re-stamp the timestamp. Lets
  // the wizard's "Volver al dashboard" button work even on stale sessions.
  if (tenant.onboardingComplete) {
    return apiSuccess({ ok: true, alreadyComplete: true });
  }

  if (!tenant.shopifyStoreUrl || !tenant.shopifyToken) {
    return apiError('Falta conectar Shopify', 422);
  }
  if (!tenant.dacUsername || !tenant.dacPassword) {
    return apiError('Falta conectar DAC', 422);
  }

  await db.tenant.update({
    where: { id: auth.tenantId },
    data: {
      onboardingComplete: true,
      onboardingCompletedAt: new Date(),
      isActive: true,
    },
  });

  return apiSuccess({ ok: true });
}
