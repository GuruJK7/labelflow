import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { getPlanLimit } from '@/lib/stripe';

export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Check tenant is active
  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      isActive: true,
      subscriptionStatus: true,
      stripePriceId: true,
      labelsThisMonth: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  if (!tenant.isActive || tenant.subscriptionStatus !== 'ACTIVE') {
    return apiError('Tu plan no esta activo. Activa una suscripcion para procesar pedidos.', 403);
  }

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

  return apiSuccess({ jobId, message: 'Job encolado exitosamente' }, { status: 202 });
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
