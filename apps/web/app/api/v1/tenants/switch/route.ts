/**
 * POST /api/v1/tenants/switch
 *
 * Switches the active store for the current session. The actual JWT
 * mutation happens inside the NextAuth jwt callback (auth.ts) when the
 * client subsequently calls `update({ tenantId })` from `useSession()`.
 * This endpoint exists to:
 *
 *   1. Validate ownership server-side BEFORE the client triggers the
 *      session update — defense against a tampered client trying to
 *      switch into someone else's tenant. (The jwt callback re-validates
 *      anyway, but failing fast here gives a clean 403 instead of a
 *      silent no-op.)
 *
 *   2. Return the freshly-loaded tenant data so the client can update
 *      its UI state without an extra round-trip.
 *
 * Body: { tenantId: string }
 *
 * After a 200 here, the client must call useSession().update({ tenantId })
 * to mint a new JWT — only then is the new tenant the source of truth for
 * subsequent API calls.
 */

import { db } from '@/lib/db';
import {
  getAuthenticatedUser,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';
import { getCreditHolderTenantIdForUser } from '@/lib/credit-holder';

export async function POST(req: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  let body: { tenantId?: string };
  try {
    body = await req.json();
  } catch {
    return apiError('Body inválido', 400);
  }

  const tenantId = body.tenantId?.trim();
  if (!tenantId || typeof tenantId !== 'string') {
    return apiError('tenantId requerido', 422);
  }

  const tenant = await db.tenant.findFirst({
    where: { id: tenantId, userId: auth.userId },
    select: {
      id: true,
      name: true,
      slug: true,
      onboardingComplete: true,
    },
  });

  if (!tenant) {
    // Don't leak whether the tenantId exists for a different user vs
    // doesn't exist at all — both surface as 403.
    return apiError('Tenant no encontrado o no tenés permiso', 403);
  }

  // Audit 2026-05-08 — multi-store credit pool. The wallet lives on
  // the user's CREDIT-HOLDER tenant (oldest one). The switcher dropdown
  // shows the SAME shared balance for every store, so users understand
  // the wallet is one shared pool.
  const holderId = await getCreditHolderTenantIdForUser(auth.userId);
  const holderWallet = holderId
    ? await db.tenant.findUnique({
        where: { id: holderId },
        select: { shipmentCredits: true, referralBonusCredits: true },
      })
    : null;
  const sharedAvailable =
    (holderWallet?.shipmentCredits ?? 0) + (holderWallet?.referralBonusCredits ?? 0);

  return apiSuccess({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      onboardingComplete: tenant.onboardingComplete,
      availableCredits: sharedAvailable,
    },
  });
}
