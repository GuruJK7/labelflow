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
// Category pattern groups — single source of truth for BOTH the retry filter
// and the dashboard breakdown, so the count the operator sees can never drift
// from what the retry action actually touches. A stuck label is classified by
// the FIRST group its errorMessage matches.
const ORPHAN_PATTERNS = ['huérfana', 'huerfana']; // guia may exist in DAC — verify, never blind-retry
const REMITENTE_PATTERNS = ['remitente']; // store pays — load by hand in DAC
const ADDRESS_PATTERNS = ['no se pudo interpretar']; // AI could not parse address — fix it / bias-to-submit

export type StuckClass = 'retryable' | 'orphan' | 'remitente' | 'needsAddress';

// Agency-pickup ("retiro en sucursal DAC") detection — mirrors the worker's
// isPickupAtDacBranch (apps/worker/src/dac/shipment.ts). These orders bounced
// to "no se pudo interpretar" because the address is a branch, not a street;
// the worker now routes them via TipoEntrega=Agencia, so re-running them IS
// recoverable and safe (they never minted a guia → the dacGuia:null filter in
// selectRetryable still holds). Checked against the stored deliveryAddress
// (the only address field we persist on the Label).
const AGENCY_ADDRESS_PATTERNS: RegExp[] = [
  /retiro\s+(en\s+)?(dac|agencia|sucursal|local|oficina)/i,
  /\bsucursal\s+(de\s+)?dac\b/i,
  /\bagencia\s+(de\s+)?dac\b/i,
  /^\s*dac\s+\S/i,
  /\bpickup\b/i,
];
function isAgencyPickupAddress(address: string | null): boolean {
  if (!address) return false;
  return AGENCY_ADDRESS_PATTERNS.some((re) => re.test(address));
}

/**
 * Classify a stuck label (sin guia real) by what action it needs, so the
 * dashboard shows the TRUE "sin completar" count and the retry touches only
 * the safe set:
 *   - retryable    → safe to re-attempt (no blocker, OR agency-pickup which the
 *                    worker now routes via TipoEntrega=Agencia)
 *   - orphan       → guia may already exist in DAC; verify/link, never retry
 *   - remitente    → store-pays; load by hand in DAC
 *   - needsAddress → address unparseable; fix the address (or bias-to-submit)
 * Precedence: orphan and remitente win over agency (never re-run a maybe-guia or
 * a store-pays order); agency wins over needsAddress (it IS recoverable now).
 * A null errorMessage with a normal address is retryable (no blocker recorded).
 */
function classifyStuck(errorMessage: string | null, deliveryAddress: string | null): StuckClass {
  const l = (errorMessage ?? '').toLowerCase();
  if (errorMessage && ORPHAN_PATTERNS.some((p) => l.includes(p))) return 'orphan';
  if (errorMessage && REMITENTE_PATTERNS.some((p) => l.includes(p))) return 'remitente';
  if (isAgencyPickupAddress(deliveryAddress)) return 'retryable';
  if (errorMessage && ADDRESS_PATTERNS.some((p) => l.includes(p))) return 'needsAddress';
  return 'retryable';
}

// Statuses that represent "no llego a despacharse" (never produced a guia).
const RETRYABLE_STATUSES: LabelStatus[] = [
  LabelStatus.NEEDS_REVIEW,
  LabelStatus.FAILED,
  LabelStatus.PENDING,
];

// Hard cap on how many candidate rows we scan, so the JS-side filter stays
// bounded even for a tenant with a large backlog.
const MAX_CANDIDATE_SCAN = 200;

interface RetryableLabel {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  status: LabelStatus;
  errorMessage: string | null;
  deliveryAddress: string | null;
}

/**
 * Selects the oldest not-done labels for a tenant (sin guia real) whose class
 * is safely retryable (see classifyStuck — includes agency-pickup, excludes
 * orphan / remitente / unparseable-address). Optionally slices to `limit`.
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
      deliveryAddress: true,
    },
  });
  const retryable = candidates.filter(
    (l) => classifyStuck(l.errorMessage, l.deliveryAddress) === 'retryable',
  );
  return typeof limit === 'number' ? retryable.slice(0, limit) : retryable;
}

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Full "stuck = attempted but no real guia" set, broken down by what each
  // class needs. `count` stays = retryable for back-compat with existing
  // callers; `total` + the per-class counts let the dashboard show the REAL
  // number (not just the blind-retryable subset) and route each class.
  const candidates = await db.label.findMany({
    where: { tenantId: auth.tenantId, dacGuia: null, status: { in: RETRYABLE_STATUSES } },
    take: MAX_CANDIDATE_SCAN,
    select: { errorMessage: true, deliveryAddress: true },
  });
  const breakdown = { retryable: 0, orphan: 0, remitente: 0, needsAddress: 0 };
  for (const c of candidates) breakdown[classifyStuck(c.errorMessage, c.deliveryAddress)] += 1;
  return apiSuccess({
    count: breakdown.retryable,
    total: candidates.length,
    ...breakdown,
  });
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
