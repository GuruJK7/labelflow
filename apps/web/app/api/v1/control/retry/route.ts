/**
 * POST /api/v1/control/retry   { tenantId: string, count?: number }
 *
 * Reintentar a SPECIFIC store's stuck (sin completar) orders from the
 * multi-store control dashboard. Same as POST /api/v1/labels/retry-failed but
 * the store is chosen explicitly and ownership re-validated.
 *
 * The unblock + re-run is the shared runRetryForTenant (lib/retry-runner), so
 * the duplicate-shipment safety (only `retryable`-class labels + C-4 guard) is
 * identical to the single-store path.
 */

import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { runRetryForTenant } from '@/lib/retry-runner';

export async function POST(req: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  let tenantId = '';
  let count = 5;
  try {
    const body = await req.json();
    tenantId = typeof body?.tenantId === 'string' ? body.tenantId : '';
    if (Number.isInteger(body?.count) && body.count > 0 && body.count <= 50) {
      count = body.count;
    }
  } catch {
    return apiError('Body invalido', 400);
  }
  if (!tenantId) return apiError('Falta tenantId', 422);

  // Ownership — same 403 whether someone else's or nonexistent.
  const owned = await db.tenant.findFirst({
    where: { id: tenantId, userId: auth.userId },
    select: { id: true },
  });
  if (!owned) return apiError('Tienda no encontrada', 403);

  // Plan-active gate — billing flags live on the credit-holder (oldest) tenant.
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
