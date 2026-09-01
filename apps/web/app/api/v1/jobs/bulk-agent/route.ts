import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrdersBulk, isJobRunning } from '@/lib/queue';
import { getPlanLimit } from '@/lib/mercadopago';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { checkRunGate, checkPlanLimit } from '@/lib/can-run';

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

  // Audit 2026-05-08 — multi-store credit pool. Billing flags read from
  // the user's CREDIT-HOLDER tenant (oldest one); per-store + per-config
  // fields stay on the originating tenant (DAC/Shopify creds are
  // configured per-store).
  const holderId = await getCreditHolderTenantId(auth.tenantId);
  const [holder, originating] = await Promise.all([
    db.tenant.findUnique({
      where: { id: holderId },
      select: {
        isActive: true,
        subscriptionStatus: true,
        shipmentCredits: true,
        referralBonusCredits: true,
        stripePriceId: true,
      },
    }),
    db.tenant.findUnique({
      where: { id: auth.tenantId },
      select: {
        labelsThisMonth: true,
        dacUsername: true,
        dacPassword: true,
        shopifyStoreUrl: true,
      },
    }),
  ]);

  if (!holder || !originating) return apiError('Tenant no encontrado', 404);

  // Mismo criterio que el cron y que los otros dos disparos manuales.
  // Ver lib/can-run.ts — antes esta ruta quedaba con el gate viejo y le decía
  // "plan no activo" al mismo cliente al que el botón de al lado ya lo dejaba pasar.
  const runGate = checkRunGate(holder);
  if (!runGate.ok) {
    return apiError(
      runGate.message,
      runGate.status,
    );
  }

  const tenant = {
    isActive: holder.isActive,
    subscriptionStatus: holder.subscriptionStatus,
    stripePriceId: holder.stripePriceId,
    labelsThisMonth: originating.labelsThisMonth,
    dacUsername: originating.dacUsername,
    dacPassword: originating.dacPassword,
    shopifyStoreUrl: originating.shopifyStoreUrl,
  };

  // Bulk requires both Shopify and DAC configured
  if (!tenant.shopifyStoreUrl) {
    return apiError('Conectá tu tienda de Shopify antes de usar bulk.', 400);
  }
  if (!tenant.dacUsername || !tenant.dacPassword) {
    return apiError('Configurá tus credenciales DAC en Configuración antes de usar bulk.', 400);
  }

  const planGate = checkPlanLimit(tenant, getPlanLimit);
  if (!planGate.ok) return apiError(planGate.message, planGate.status);

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
