import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { getPlanLimit } from '@/lib/mercadopago';
import { getCreditHolderTenantId } from '@/lib/credit-holder';

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let testMode = false;
  let maxOrders = 0; // 0 = use tenant default
  try {
    const body = await req.json();
    testMode = body?.testMode === true;
    if (body?.maxOrders && Number.isInteger(body.maxOrders) && body.maxOrders > 0 && body.maxOrders <= 50) {
      maxOrders = body.maxOrders;
    }
  } catch {
    // No body or invalid JSON — default to normal mode
  }

  // Audit 2026-05-08 — multi-store credit pool. Billing flags
  // (isActive, subscriptionStatus, stripePriceId/plan tier) live on
  // the user's CREDIT-HOLDER tenant (oldest one), same model as the
  // credit wallet. Per-store metrics (labelsThisMonth) stay on the
  // originating tenant.
  const holderId = await getCreditHolderTenantId(auth.tenantId);
  const [holder, originating] = await Promise.all([
    db.tenant.findUnique({
      where: { id: holderId },
      select: {
        isActive: true,
        subscriptionStatus: true,
        stripePriceId: true,
      },
    }),
    db.tenant.findUnique({
      where: { id: auth.tenantId },
      select: { labelsThisMonth: true },
    }),
  ]);

  if (!holder || !originating) return apiError('Tenant no encontrado', 404);

  if (!holder.isActive || holder.subscriptionStatus !== 'ACTIVE') {
    return apiError('Tu plan no esta activo. Activa una suscripcion para procesar pedidos.', 403);
  }

  // Tenant alias for the rest of the function — combines holder flags
  // with originating per-store metrics so existing reads keep working.
  const tenant = {
    isActive: holder.isActive,
    subscriptionStatus: holder.subscriptionStatus,
    stripePriceId: holder.stripePriceId,
    labelsThisMonth: originating.labelsThisMonth,
  };

  // Check plan limit
  const limit = getPlanLimit(tenant.stripePriceId);
  if (tenant.labelsThisMonth >= limit) {
    return apiError(
      `Alcanzaste el limite de ${limit} etiquetas este mes. Upgrade tu plan para continuar.`,
      429
    );
  }

  // Check no running job
  const running = await isJobRunning(auth.tenantId);
  if (running) {
    return apiError('Ya hay un job en ejecucion. Espera a que termine.', 409);
  }

  const jobId = await enqueueProcessOrders(auth.tenantId, 'MANUAL');

  // Store maxOrders override in RunLog so the worker reads it
  const effectiveMax = maxOrders || (testMode ? 1 : 0);
  if (effectiveMax > 0) {
    await db.runLog.create({
      data: {
        jobId,
        tenantId: auth.tenantId,
        level: 'INFO',
        message: `maxOrdersOverride=${effectiveMax}`,
        meta: { testMode, maxOrdersPerRun: effectiveMax },
      },
    });
  }

  const label = effectiveMax === 1 ? '1 pedido' : effectiveMax > 0 ? `${effectiveMax} pedidos` : 'todos los pedidos';
  return apiSuccess({ jobId, maxOrders: effectiveMax, message: `Job encolado: ${label}` }, { status: 202 });
}

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const jobs = await db.job.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      status: true,
      trigger: true,
      totalOrders: true,
      successCount: true,
      failedCount: true,
      skippedCount: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      createdAt: true,
    },
  });

  return apiSuccess(jobs);
}
