import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { getPlanLimit } from '@/lib/mercadopago';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { checkRunGate, checkPlanLimit } from '@/lib/can-run';
import { warmShopifyToken } from '@/lib/shopify-access';
import { storeConnection } from '@/lib/onboarding-state';
import { leerLimitePedido, limiteEfectivo, hayOverride, etiquetaDeLimite, TODOS } from '@/lib/limite-por-corrida';

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let testMode = false;
  // `undefined` = el usuario no pidió límite (manda el default de la tienda);
  // `0` = TODOS. Ver lib/limite-por-corrida.ts: hasta el 05-09-2026 estos dos
  // casos se colapsaban en uno y "Todos" despachaba 5 o 20 pedidos.
  let limitePedido: number | undefined;
  try {
    const body = await req.json();
    testMode = body?.testMode === true;
    limitePedido = leerLimitePedido(body);
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
        shipmentCredits: true,
        referralBonusCredits: true,
      },
    }),
    db.tenant.findUnique({
      where: { id: auth.tenantId },
      select: {
        labelsThisMonth: true,
        // Para elegir el tipo de job según la tienda conectada (D33, H10).
        shopifyStoreUrl: true,
        shopifyToken: true,
        dashboardSourceEnabled: true,
        dashboardUrl: true,
        dashboardToken: true,
      },
    }),
  ]);

  if (!holder || !originating) return apiError('Tenant no encontrado', 404);

  // Mismo criterio que el scheduler del worker (isActive + saldo), para que
  // el botón manual no pueda volver a divergir del cron. Ver lib/can-run.ts.
  const gate = checkRunGate(holder);
  if (!gate.ok) return apiError(gate.message, gate.status);

  // Tenant alias for the rest of the function — combines holder flags
  // with originating per-store metrics so existing reads keep working.
  const tenant = {
    isActive: holder.isActive,
    subscriptionStatus: holder.subscriptionStatus,
    stripePriceId: holder.stripePriceId,
    labelsThisMonth: originating.labelsThisMonth,
  };

  // Tope por plan legacy. Los clientes de packs no tienen plan: su tope es el
  // saldo, ya verificado arriba. Ver lib/can-run.ts.
  const planGate = checkPlanLimit(tenant, getPlanLimit);
  if (!planGate.ok) return apiError(planGate.message, planGate.status);

  // Check no running job
  const running = await isJobRunning(auth.tenantId);
  if (running) {
    return apiError('Ya hay un job en ejecucion. Espera a que termine.', 409);
  }

  // Tipo de job según la tienda conectada (D33). Shopify va como siempre;
  // Dashboard con Excel crea el mismo job que el scheduler
  // (`PROCESS_DASHBOARD_ORDERS`, apps/worker/src/jobs/scheduler.ts) y el
  // poller del worker lo rutea por tipo. Sin tienda no hay qué procesar.
  const kind = storeConnection(originating).kind;
  if (!kind) return apiError('Conectá una tienda antes de procesar', 422);
  const type = kind === 'shopify' ? 'PROCESS_ORDERS' : 'PROCESS_DASHBOARD_ORDERS';

  if (kind === 'shopify') {
    // Token fresco ANTES de encolar (D29): el worker no tiene el secret de la
    // app pública en Render, así que un job manual arranca con el par que la
    // web acaba de renovar. Best-effort: si falla, el job lo reporta.
    await warmShopifyToken(auth.tenantId);
  }

  // Store maxOrders override in RunLog so the worker reads it
  const effectiveMax = limiteEfectivo(limitePedido, testMode);

  // Revisión 2026-09-02: el job de Dashboard con Excel
  // (apps/worker/src/jobs/process-dashboard-orders.job.ts) trae hasta
  // DASHBOARD_FETCH_LIMIT=100 pedidos confirmados y sólo recorta por saldo:
  // NO lee el RunLog `maxOrdersOverride` como hace process-orders.job.ts.
  // Encolar "1 pedido" ahí despacharía todos y quemaría créditos que el
  // usuario no pidió gastar. Hasta que ese job lea el override (worker, otro
  // turno), el límite se rechaza antes de crear el job.
  // `TODOS` (0) SÍ se acepta para esta fuente: es exactamente lo único que ese
  // job sabe hacer. Lo que se rechaza es un tope > 0, que ignoraría en silencio.
  if (kind === 'dashboard' && effectiveMax !== undefined && effectiveMax > TODOS) {
    return apiError(
      'El límite de pedidos sólo aplica a tiendas Shopify. Con Dashboard con Excel se procesan todos los pedidos confirmados: ejecutá sin límite.',
      422,
    );
  }

  const jobId = await enqueueProcessOrders(auth.tenantId, 'MANUAL', { type });

  if (hayOverride(effectiveMax)) {
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

  const label = etiquetaDeLimite(effectiveMax);
  // `maxOrders` en la respuesta se mantiene numérico por compatibilidad con el
  // cliente: sin override devuelve 0, que para el lector significa "sin tope
  // propio". El override real (incluido el 0 explícito) ya quedó en el RunLog.
  return apiSuccess({ jobId, type, maxOrders: effectiveMax ?? TODOS, message: `Job encolado: ${label}` }, { status: 202 });
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
      skipReason: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      createdAt: true,
    },
  });

  return apiSuccess(jobs);
}
