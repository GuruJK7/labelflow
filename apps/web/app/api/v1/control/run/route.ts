/**
 * POST /api/v1/control/run   { tenantId: string, maxOrders?: number }
 *
 * Run a SPECIFIC store's pending orders from the multi-store control dashboard.
 * Same effect as POST /api/v1/jobs, but the store is chosen explicitly (and
 * ownership re-validated) instead of being the single active tenant in the JWT.
 *
 * Reuses every existing safety primitive: ownership check, credit-holder
 * plan-active gate, per-store isJobRunning lock, and enqueueProcessOrders (which
 * goes through the worker's PendingShipment duplicate-shipment guard). It adds
 * NO new shipment path.
 */

import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { getPlanLimit } from '@/lib/mercadopago';

export async function POST(req: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  let tenantId = '';
  let maxOrders = 0; // 0 = tenant default (all)
  try {
    const body = await req.json();
    tenantId = typeof body?.tenantId === 'string' ? body.tenantId : '';
    if (body?.maxOrders && Number.isInteger(body.maxOrders) && body.maxOrders > 0 && body.maxOrders <= 50) {
      maxOrders = body.maxOrders;
    }
  } catch {
    return apiError('Body invalido', 400);
  }
  if (!tenantId) return apiError('Falta tenantId', 422);

  // Ownership — the store must belong to the user. Same 403 whether it is
  // someone else's or does not exist (no-leak posture, mirrors tenants/switch).
  const owned = await db.tenant.findFirst({
    where: { id: tenantId, userId: auth.userId },
    select: { id: true, name: true, labelsThisMonth: true },
  });
  if (!owned) return apiError('Tienda no encontrada', 403);

  // Plan-active gate — billing flags live on the credit-holder (oldest) tenant.
  const holderId = await getCreditHolderTenantId(tenantId);
  const holder = await db.tenant.findUnique({
    where: { id: holderId },
    select: { isActive: true, subscriptionStatus: true, stripePriceId: true },
  });
  if (!holder) return apiError('Tenant no encontrado', 404);
  if (!holder.isActive || holder.subscriptionStatus !== 'ACTIVE') {
    return apiError('Tu plan no esta activo. Activa una suscripcion para procesar pedidos.', 403);
  }

  // Plan label limit — counted against the originating store's month, same as
  // POST /api/v1/jobs.
  const limit = getPlanLimit(holder.stripePriceId);
  if (owned.labelsThisMonth >= limit) {
    return apiError(`Alcanzaste el limite de ${limit} etiquetas este mes. Upgrade tu plan para continuar.`, 429);
  }

  // One job per store at a time.
  if (await isJobRunning(tenantId)) {
    return apiError('Ya hay un job en ejecucion para esta tienda.', 409);
  }

  const jobId = await enqueueProcessOrders(tenantId, 'MANUAL');
  if (maxOrders > 0) {
    await db.runLog.create({
      data: {
        jobId,
        tenantId,
        level: 'INFO',
        message: `maxOrdersOverride=${maxOrders}`,
        meta: { maxOrdersPerRun: maxOrders, source: 'control-run' },
      },
    });
  }

  const label = maxOrders === 1 ? '1 pedido' : maxOrders > 0 ? `${maxOrders} pedidos` : 'todos los pedidos';
  return apiSuccess(
    { jobId, tenantId, tenantName: owned.name, maxOrders, message: `Job encolado para ${owned.name}: ${label}` },
    { status: 202 },
  );
}
