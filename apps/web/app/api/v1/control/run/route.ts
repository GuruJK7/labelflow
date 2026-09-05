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
 *
 * Alcance: el usuario opera sus tiendas; el admin (ADMIN_EMAILS) además
 * cualquier tenant activo (lib/control-scope). El gate de plan/saldo se
 * evalúa sobre el holder del DUEÑO de la tienda, no del que aprieta el botón.
 */

import { db } from '@/lib/db';
import { apiError, apiSuccess } from '@/lib/api-utils';
import { getControlActor, controlTenantWhere, auditControlAccess } from '@/lib/control-scope';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { getPlanLimit } from '@/lib/mercadopago';
import { checkRunGate, checkPlanLimit } from '@/lib/can-run';
import { warmShopifyToken } from '@/lib/shopify-access';
import { storeConnection } from '@/lib/onboarding-state';
import { leerLimitePedido, hayOverride, etiquetaDeLimite, TODOS } from '@/lib/limite-por-corrida';

export async function POST(req: Request) {
  const actor = await getControlActor();
  if (!actor) return apiError('No autorizado', 401);

  let tenantId = '';
  // 🔴 El comentario que estaba acá decía "0 = tenant default (all)" y las dos
  // mitades se contradecían: 0 caía al default de la tienda (5 o 20), que NO es
  // "all". Ahora `undefined` = default de la tienda y `0` = TODOS de verdad.
  // Ver lib/limite-por-corrida.ts.
  let maxOrders: number | undefined;
  try {
    const body = await req.json();
    tenantId = typeof body?.tenantId === 'string' ? body.tenantId : '';
    maxOrders = leerLimitePedido(body);
  } catch {
    return apiError('Body invalido', 400);
  }
  if (!tenantId) return apiError('Falta tenantId', 422);

  // Alcance — the store must belong to the user (or, for an admin, be any
  // active tenant: lib/control-scope). Same 403 whether it is someone else's
  // or does not exist (no-leak posture, mirrors tenants/switch).
  const owned = await db.tenant.findFirst({
    where: { id: tenantId, ...controlTenantWhere(actor) },
    select: {
      id: true,
      name: true,
      labelsThisMonth: true,
      // Con qué fuente está conectada esta tienda. Sin esto no se puede saber
      // qué job encolar — ver el bloque de `kind` más abajo.
      shopifyStoreUrl: true,
      shopifyToken: true,
      dashboardSourceEnabled: true,
      dashboardUrl: true,
      dashboardToken: true,
    },
  });
  if (!owned) return apiError('Tienda no encontrada', 403);

  // Queda registro de que un operador miró datos de un cliente ajeno.
  await auditControlAccess(actor, tenantId, 'control.run.run');

  // Plan-active gate — billing flags live on the credit-holder (oldest) tenant.
  const holderId = await getCreditHolderTenantId(tenantId);
  const holder = await db.tenant.findUnique({
    where: { id: holderId },
    select: {
      isActive: true,
      subscriptionStatus: true,
      stripePriceId: true,
      shipmentCredits: true,
      referralBonusCredits: true,
    },
  });
  if (!holder) return apiError('Tenant no encontrado', 404);
  // Mismo criterio que el scheduler del worker (isActive + saldo). Ver lib/can-run.ts.
  const gate = checkRunGate(holder);
  if (!gate.ok) return apiError(gate.message, gate.status);

  // Plan label limit — counted against the originating store's month, same as
  // POST /api/v1/jobs.
  const planGate = checkPlanLimit(
    { stripePriceId: holder.stripePriceId, labelsThisMonth: owned.labelsThisMonth },
    getPlanLimit,
  );
  if (!planGate.ok) return apiError(planGate.message, planGate.status);

  // Soft gate: one job per store at a time. This is a non-atomic read, so two
  // near-simultaneous requests could both pass; that is acceptable because the
  // real anti-double-ship guarantee is the worker's PendingShipment
  // @@unique([tenantId, shopifyOrderId]) (it throws before a second Finalizar),
  // NOT this check. Do not treat isJobRunning as authoritative.
  if (await isJobRunning(tenantId)) {
    return apiError('Ya hay un job en ejecucion para esta tienda.', 409);
  }

  // ── Qué job encolar, según con qué está conectada la tienda ──────────────
  //
  // 🔴 ESTO FALTABA, y era la mitad de una promesa rota. Hasta acá esta ruta
  // encolaba SIEMPRE `PROCESS_ORDERS`, que es el procesador de Shopify. Para
  // una tienda de la fuente dashboard —las que aprovisiona
  // `/api/provisioning/dac-tenant`, o sea VentaFlow y las cuentas operadas por
  // el depósito— eso creaba un job que no tenía de dónde leer pedidos: el
  // botón "Ejecutar" contestaba "Job encolado" y no despachaba NADA, sin un
  // solo error a la vista. `POST /api/v1/jobs` ya routeaba bien desde D33;
  // esta ruta se quedó atrás. Mismo criterio, mismo helper.
  const kind = storeConnection(owned).kind;
  if (!kind) return apiError('Esa tienda no tiene ninguna fuente conectada.', 422);
  const type = kind === 'shopify' ? 'PROCESS_ORDERS' : 'PROCESS_DASHBOARD_ORDERS';

  // El límite por corrida sólo lo entiende el procesador de Shopify: el job de
  // la fuente dashboard no lee el RunLog `maxOrdersOverride` y despacharía TODO
  // igual. Mismo rechazo explícito que hace /api/v1/jobs, por el mismo motivo:
  // aceptarlo en silencio quemaría envíos que nadie pidió gastar.
  // `TODOS` (0) pasa: es lo único que sabe hacer ese job. Un tope > 0 no.
  if (kind === 'dashboard' && maxOrders !== undefined && maxOrders > TODOS) {
    return apiError(
      'El límite por corrida sólo aplica a tiendas Shopify. Con la fuente dashboard se procesan todos los pedidos confirmados: ejecutá sin límite.',
      422,
    );
  }

  if (kind === 'shopify') {
    // Token fresco ANTES de encolar (D29), mismo motivo que en /api/v1/jobs.
    // Una tienda de la fuente dashboard no tiene token de Shopify que renovar.
    await warmShopifyToken(tenantId);
  }

  const jobId = await enqueueProcessOrders(tenantId, 'MANUAL', { type });
  if (hayOverride(maxOrders)) {
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

  const label = etiquetaDeLimite(maxOrders);
  // NOTE: apiSuccess serializes its 2nd arg into the BODY as `meta` — it does
  // NOT set the HTTP status. Return a clean 200 (no bogus meta.status); the
  // client only checks res.ok and reads .data.
  return apiSuccess({
    jobId,
    tenantId,
    tenantName: owned.name,
    maxOrders: maxOrders ?? TODOS,
    message: `Job encolado para ${owned.name}: ${label}`,
  });
}
