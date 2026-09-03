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
import { apiError, apiSuccess } from '@/lib/api-utils';
import { getControlActor, controlTenantWhere, auditControlAccess } from '@/lib/control-scope';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { runRetryForTenant } from '@/lib/retry-runner';
import { checkRunGate } from '@/lib/can-run';

export async function POST(req: Request) {
  const actor = await getControlActor();
  if (!actor) return apiError('No autorizado', 401);

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

  // Alcance — same 403 whether someone else's or nonexistent. El admin
  // (ADMIN_EMAILS) alcanza además cualquier tenant activo (lib/control-scope).
  const owned = await db.tenant.findFirst({
    where: { id: tenantId, ...controlTenantWhere(actor) },
    select: { id: true },
  });
  if (!owned) return apiError('Tienda no encontrada', 403);

  // Queda registro de que un operador miró datos de un cliente ajeno.
  await auditControlAccess(actor, tenantId, 'control.retry.run');

  // Plan-active gate — billing flags live on the credit-holder (oldest) tenant.
  const holderId = await getCreditHolderTenantId(tenantId);
  const holder = await db.tenant.findUnique({
    where: { id: holderId },
    select: {
      isActive: true,
      subscriptionStatus: true,
      shipmentCredits: true,
      referralBonusCredits: true,
    },
  });
  if (!holder) return apiError('Tenant no encontrado', 404);
  // Mismo gate que /api/v1/control/run (lib/can-run.ts): activo y con saldo.
  // Con el chequeo viejo, reintentar desde Control le devolvía 403 a cualquier
  // cliente de packs — incluso al operador mirando la tienda de un cliente.
  const gate = checkRunGate(holder);
  if (!gate.ok) return apiError(gate.message, gate.status);

  const result = await runRetryForTenant(tenantId, count);
  return apiSuccess(result);
}
