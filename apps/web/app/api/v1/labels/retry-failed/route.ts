import { LabelStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { getCreditHolderTenantId } from '@/lib/credit-holder';

/**
 * POST /api/v1/labels/retry-failed   { count: number }
 * GET  /api/v1/labels/retry-failed   -> { count } (how many can be retried)
 *
 * Operator-initiated "Reintentar envios" action. Takes the N oldest
 * shipments that NEVER got a real DAC guia (sin guia), unblocks them in
 * bulk, and triggers a worker run so they are re-attempted with the
 * current fixes (incl. Lever B real geocoding).
 *
 * Mechanism — identical to POST /api/v1/labels/[id]/redo but applied to
 * many rows at once. For each selected order it deletes the Label row +
 * the matching PendingShipment row inside a single transaction. That
 * clears the two worker skip guards that otherwise keep a failed order
 * stuck forever:
 *
 *   - process-orders.job.ts COMPLETED-Label skip (only fires for
 *     COMPLETED, so it does not block these — kept for completeness).
 *   - C-4 "stuck PendingShipment" skip: any order with a PENDING/ORPHANED
 *     PendingShipment is dropped from the batch. Deleting that row is what
 *     lets the orphaned ("Posible guia huerfana") orders flow again.
 *
 * Ground truth (operator): an order that was NOT marked completed has NO
 * guia in DAC, so re-running it cannot double-ship. The Shopify order
 * note still carries any prior "LabelFlow-GUIA:" entries (append-only).
 *
 * Non-retryable cases are deliberately excluded so a retry is never
 * wasted on an order that automation cannot resolve (see
 * NON_RETRYABLE_ERROR_PATTERNS).
 *
 * Safety:
 *   - Tenant-scoped: only the authenticated tenant's labels are touched.
 *   - Plan-active gate mirrors POST /api/v1/jobs.
 *   - All deletes wrapped in one $transaction (all-or-nothing).
 *   - A RunLog "labels-retry-failed" row records the order names + ids.
 */

// Error-message substrings whose orders gain nothing from an automated
// retry — excluded so the count and the action stay honest:
//   - 'no se pudo interpretar': AI-feasibility bounce. The worker's
//     cost-fix filter skips these every tick until the operator edits the
//     Shopify address; deleting the Label would re-open the per-tick AI
//     spend that filter exists to prevent (and the order would just
//     bounce again with the same verdict).
//   - 'remitente': pickup / sender shipment that must be loaded by hand in
//     DAC. Reprocessing only re-flags it NEEDS_REVIEW.
//   - 'huérfana' / 'huerfana': ORPHAN class — DAC may have minted a guia we
//     could not link back (Label.dacGuia stays null even though a guia exists
//     in DAC), and the worker DELIBERATELY preserves the PendingShipment
//     "para evitar duplicados" (process-orders.job.ts orphan path). A retry
//     here deletes that very guard (deleteMany PendingShipment below) and
//     re-submits the order — risking a SECOND guia and a double charge. These
//     must be verified/linked by hand or by orphan-reconcile, never blind-
//     retried. (Note: labels whose guia we DID link are already excluded by
//     the dacGuia:null filter in selectRetryable; this covers the ones where
//     the guia exists in DAC but is not yet linked on our side.)
const NON_RETRYABLE_ERROR_PATTERNS = [
  'no se pudo interpretar',
  'remitente',
  'huérfana',
  'huerfana',
];

// Statuses that represent "no llego a despacharse" (never produced a guia).
const RETRYABLE_STATUSES: LabelStatus[] = [
  LabelStatus.NEEDS_REVIEW,
  LabelStatus.FAILED,
  LabelStatus.PENDING,
];

// Hard cap on how many candidate rows we scan, so the JS-side filter stays
// bounded even for a tenant with a large backlog.
const MAX_CANDIDATE_SCAN = 200;

function isRetryable(errorMessage: string | null): boolean {
  if (!errorMessage) return true;
  const lower = errorMessage.toLowerCase();
  return !NON_RETRYABLE_ERROR_PATTERNS.some((p) => lower.includes(p));
}

interface RetryableLabel {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  status: LabelStatus;
  errorMessage: string | null;
}

/**
 * Selects the oldest not-done labels for a tenant (sin guia real),
 * dropping the non-retryable classes. Optionally slices to `limit`.
 */
async function selectRetryable(tenantId: string, limit?: number): Promise<RetryableLabel[]> {
  const candidates = await db.label.findMany({
    where: {
      tenantId,
      dacGuia: null, // no real guia minted
      status: { in: RETRYABLE_STATUSES },
    },
    orderBy: { createdAt: 'asc' }, // oldest-stuck first
    take: MAX_CANDIDATE_SCAN,
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      status: true,
      errorMessage: true,
    },
  });
  const retryable = candidates.filter((l) => isRetryable(l.errorMessage));
  return typeof limit === 'number' ? retryable.slice(0, limit) : retryable;
}

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const retryable = await selectRetryable(auth.tenantId);
  return apiSuccess({ count: retryable.length });
}

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);
  const tenantId = auth.tenantId;

  let count = 5;
  try {
    const body = await req.json();
    if (Number.isInteger(body?.count) && body.count > 0 && body.count <= 50) {
      count = body.count;
    }
  } catch {
    // No body / invalid JSON — keep the default.
  }

  // Plan-active gate — same model as POST /api/v1/jobs: billing flags live
  // on the credit-holder tenant (oldest one).
  const holderId = await getCreditHolderTenantId(tenantId);
  const holder = await db.tenant.findUnique({
    where: { id: holderId },
    select: { isActive: true, subscriptionStatus: true },
  });
  if (!holder) return apiError('Tenant no encontrado', 404);
  if (!holder.isActive || holder.subscriptionStatus !== 'ACTIVE') {
    return apiError('Tu plan no esta activo. Activa una suscripcion para reintentar envios.', 403);
  }

  const selected = await selectRetryable(tenantId, count);
  if (selected.length === 0) {
    return apiSuccess({
      retried: [],
      count: 0,
      jobId: null,
      alreadyRunning: false,
      message: 'No hay envios sin completar para reintentar.',
    });
  }

  const labelIds = selected.map((l) => l.id);
  const shopifyOrderIds = selected.map((l) => l.shopifyOrderId);
  const orderNames = selected.map((l) => l.shopifyOrderName);

  // Atomically unblock the selected orders (delete Label + PendingShipment).
  await db.$transaction(async (tx) => {
    await tx.label.deleteMany({ where: { id: { in: labelIds }, tenantId } });
    await tx.pendingShipment.deleteMany({
      where: { tenantId, shopifyOrderId: { in: shopifyOrderIds } },
    });
    await tx.runLog.create({
      data: {
        tenantId,
        jobId: null,
        level: 'INFO',
        message: 'labels-retry-failed',
        meta: {
          count: selected.length,
          requestedCount: count,
          orderNames,
          shopifyOrderIds,
          triggeredBy: 'dashboard-retry-failed',
        },
      },
    });
  });

  // Trigger a run capped at the unblocked count so the worker reprocesses
  // them. Kinevia (and the default) sort oldest_first, so the just-cleared
  // stuck orders are the oldest unfulfilled and get picked first. If a job
  // is already running, skip the enqueue — the in-flight job (or the next
  // scheduled tick) will pick the now-unblocked orders up.
  let jobId: string | null = null;
  const running = await isJobRunning(tenantId);
  if (!running) {
    jobId = await enqueueProcessOrders(tenantId, 'MANUAL');
    await db.runLog.create({
      data: {
        jobId,
        tenantId,
        level: 'INFO',
        message: `maxOrdersOverride=${selected.length}`,
        meta: { maxOrdersPerRun: selected.length, source: 'retry-failed' },
      },
    });
  }

  return apiSuccess({
    retried: orderNames,
    count: selected.length,
    jobId,
    alreadyRunning: running,
    message: running
      ? `${selected.length} envio(s) desbloqueado(s). Hay un job en curso: se reintentaran en la proxima corrida.`
      : `Reintentando ${selected.length} envio(s): ${orderNames.join(', ')}.`,
  });
}
