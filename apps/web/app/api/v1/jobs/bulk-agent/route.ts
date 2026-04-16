import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrdersBulk, isJobRunning } from '@/lib/queue';
import { getPlanLimit } from '@/lib/mercadopago';

/**
 * POST /api/v1/jobs/bulk-agent
 *
 * Creates a bulk DAC job that will be:
 *  1. Processed on Render: fetch Shopify orders + generate xlsx + upload to Storage
 *  2. Handed off to Adrian's Mac (agent): upload xlsx to DAC + extract guias
 *
 * Tenant auth required. Respects plan limits and cooldown.
 */
export async function POST(_req: Request) {
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
      dacUsername: true,
      dacPassword: true,
      shopifyStoreUrl: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  if (!tenant.isActive || tenant.subscriptionStatus !== 'ACTIVE') {
    return apiError(
      'Tu plan no está activo. Activá una suscripción para procesar pedidos.',
      403,
    );
  }

  // Bulk requires both Shopify and DAC configured
  if (!tenant.shopifyStoreUrl) {
    return apiError('Conectá tu tienda de Shopify antes de usar bulk.', 400);
  }
  if (!tenant.dacUsername || !tenant.dacPassword) {
    return apiError('Configurá tus credenciales DAC en Configuración antes de usar bulk.', 400);
  }

  // Check plan limit
  const limit = getPlanLimit(tenant.stripePriceId);
  if (tenant.labelsThisMonth >= limit) {
    return apiError(
      `Alcanzaste el limite de ${limit} etiquetas este mes. Upgrade tu plan para continuar.`,
      429,
    );
  }

  // Check no running job (including agent-handoff states)
  const running = await isJobRunning(auth.tenantId);
  if (running) {
    return apiError('Ya hay un job en ejecución. Esperá a que termine.', 409);
  }

  const jobId = await enqueueProcessOrdersBulk(auth.tenantId, 'MANUAL');

  return apiSuccess(
    {
      jobId,
      message: 'Bulk job encolado — Render está preparando el archivo. Un agente lo subirá a DAC en unos minutos.',
    },
    { status: 202 },
  );
}
