import { NextResponse } from 'next/server';
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
 * Email verificado (D26): activar exige `User.emailVerified`, sin importar
 * `EMAIL_VERIFICATION_REQUIRED`. Es la única puerta que prende `isActive`, y
 * con ella el cron del worker (cada 15 min por tenant activo con saldo) y el
 * botón manual. Sin esto, un script podía crear N cuentas sin abrir jamás
 * el mail, cargar Shopify + un DAC cualquiera (test-dac no lo verifica) y
 * poner N jobs contra el bridge. Los tenants que ya estaban completos no
 * se tocan (early return de arriba).
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
      user: { select: { email: true, emailVerified: true } },
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
  if (!tenant.user?.emailVerified) {
    return NextResponse.json(
      {
        error: 'Confirmá tu email antes de activar la cuenta. Te mandamos un link al registrarte.',
        code: 'email_not_verified',
        email: tenant.user?.email ?? null,
      },
      { status: 422 },
    );
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
