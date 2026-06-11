/**
 * Stuck-label classification — SINGLE SOURCE OF TRUTH.
 *
 * A Label is "stuck / sin completar" when it was attempted but never produced
 * a real DAC guia (dacGuia=null, status NEEDS_REVIEW/FAILED/PENDING). This
 * module decides, for each stuck label, what action it needs and which subset
 * is SAFE to blind-retry. The classification MUST stay identical everywhere it
 * is read (the single-store "Recuperar envios" widget, the bulk retry action,
 * and the multi-store control dashboard) so the count the operator sees can
 * never drift from what a retry actually touches.
 *
 * Extracted verbatim from app/api/v1/labels/retry-failed/route.ts (2026-06-11)
 * so the multi-store overview can reuse it without duplicating logic. The
 * retry-failed route now imports from here. Behavior is unchanged.
 *
 * DUPLICATE-SHIPMENT SAFETY: `orphan` and `remitente` classes are deliberately
 * NOT retryable — re-submitting them risks a SECOND DAC guia and a double
 * charge. Do not "simplify" classifyStuck to retry everything.
 */

import { LabelStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { isResolvedExternally } from '@/lib/shopify-reconcile';

// Category pattern groups — a stuck label is classified by the FIRST group its
// errorMessage matches.
const ORPHAN_PATTERNS = ['huérfana', 'huerfana']; // guia may exist in DAC — verify, never blind-retry
const REMITENTE_PATTERNS = ['remitente']; // store pays — load by hand in DAC
const ADDRESS_PATTERNS = ['no se pudo interpretar']; // AI could not parse address — fix it / bias-to-submit

export type StuckClass = 'retryable' | 'orphan' | 'remitente' | 'needsAddress';

// Agency-pickup ("retiro en sucursal DAC") detection — mirrors the worker's
// isPickupAtDacBranch (apps/worker/src/dac/shipment.ts). These orders bounced
// to "no se pudo interpretar" because the address is a branch, not a street;
// the worker now routes them via TipoEntrega=Agencia, so re-running them IS
// recoverable and safe (they never minted a guia -> the dacGuia:null filter in
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
 *   - retryable    -> safe to re-attempt (no blocker; agency-pickup routed via
 *                     TipoEntrega=Agencia; missing-number ships-with-note; OR a
 *                     DESTINATARIO orphan — an unlinked guia is inert/never ships,
 *                     so re-shipping is safe, business decision 2026-06-07)
 *   - orphan       -> REMITENTE-only now: DAC may already hold a guia AND the
 *                     store pre-pays, so a duplicate = double store charge -> held
 *                     for manual verify. (DESTINATARIO orphans are RETRYABLE.)
 *   - remitente    -> store-pays; load by hand in DAC
 *   - needsAddress -> DEPRECATED as a distinct outcome (now always 0). Kept in
 *                     the type + breakdown shape for back-compat.
 * Precedence: orphan first (DESTINATARIO orphan -> retryable, REMITENTE orphan
 * -> held); then remitente; then agency / missing-number / no blocker ->
 * retryable. A null errorMessage with a normal address is retryable.
 */
export function classifyStuck(
  errorMessage: string | null,
  deliveryAddress: string | null,
  paymentType: string | null,
): StuckClass {
  const l = (errorMessage ?? '').toLowerCase();
  if (errorMessage && ORPHAN_PATTERNS.some((p) => l.includes(p))) {
    // Orphan = DAC MAY have minted a guia we could not link. Business decision
    // (operator, 2026-06-07): an UNLINKED guia is INERT — it never reaches the
    // client label portal, so it never ships. A held orphan is therefore a
    // GUARANTEED lost shipment, worse than the rare cost of a duplicate guia.
    //   - DESTINATARIO (customer pays on delivery): a duplicate guia costs
    //     nothing real (the inert orphan never ships) -> RETRYABLE.
    //   - REMITENTE (store pre-pays): a duplicate could double-charge the store,
    //     so it stays held ('orphan') for manual verification in DAC.
    return paymentType === 'REMITENTE' ? 'orphan' : 'retryable';
  }
  if (errorMessage && REMITENTE_PATTERNS.some((p) => l.includes(p))) return 'remitente';
  if (isAgencyPickupAddress(deliveryAddress)) return 'retryable';
  // 'no se pudo interpretar' (missing / uninterpretable address) is RETRYABLE
  // since the 2026-05-11 ship-with-note directive: the worker ships with "S/N"
  // + an operator-call note instead of bouncing. ADDRESS_PATTERNS kept to
  // document intent (branch returns the same as the default fall-through).
  if (errorMessage && ADDRESS_PATTERNS.some((p) => l.includes(p))) return 'retryable';
  return 'retryable';
}

// Statuses that represent "no llego a despacharse" (never produced a guia).
export const RETRYABLE_STATUSES: LabelStatus[] = [
  LabelStatus.NEEDS_REVIEW,
  LabelStatus.FAILED,
  LabelStatus.PENDING,
];

// Hard cap on how many candidate rows we scan, so the JS-side filter stays
// bounded even for a tenant with a large backlog.
export const MAX_CANDIDATE_SCAN = 200;

export interface RetryableLabel {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  status: LabelStatus;
  errorMessage: string | null;
  deliveryAddress: string | null;
  paymentType: string | null;
}

/**
 * Selects the oldest not-done labels for a tenant (sin guia real) whose class
 * is safely retryable (see classifyStuck — includes agency-pickup, excludes
 * orphan / remitente). Optionally slices to `limit`.
 */
export async function selectRetryable(tenantId: string, limit?: number): Promise<RetryableLabel[]> {
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
      paymentType: true,
    },
  });
  const retryable = candidates.filter(
    (l) =>
      !isResolvedExternally(l.errorMessage) &&
      classifyStuck(l.errorMessage, l.deliveryAddress, l.paymentType) === 'retryable',
  );
  return typeof limit === 'number' ? retryable.slice(0, limit) : retryable;
}

export interface StuckBreakdown {
  /** = retryable (the blind-retryable subset). Kept named `count` for back-compat. */
  count: number;
  /** all stuck rows (attempted, no real guia, not resolved-externally). */
  total: number;
  retryable: number;
  orphan: number;
  remitente: number;
  needsAddress: number;
}

/**
 * Pure-DB stuck breakdown for ONE tenant — NO Shopify reconcile side effect, so
 * it is safe to call per-tenant in a multi-store loop without fanning out
 * Shopify calls. It is the PRE-reconcile DB count: callers that need the
 * Shopify-reconciled number (terminal-done orders dropped) must run
 * maybeReconcileStuck first, as the single-store GET /api/v1/labels/retry-failed
 * does. The oldest-first ordering + 200 cap match selectRetryable exactly, so
 * the breakdown is deterministic across polls and aligned with the set the
 * retry button actually processes.
 */
export async function getStuckBreakdown(tenantId: string): Promise<StuckBreakdown> {
  const candidates = await db.label.findMany({
    where: { tenantId, dacGuia: null, status: { in: RETRYABLE_STATUSES } },
    orderBy: { createdAt: 'asc' },
    take: MAX_CANDIDATE_SCAN,
    select: { errorMessage: true, deliveryAddress: true, paymentType: true },
  });
  // Exclude resolved-externally rows in JS (a Prisma NOT-startsWith on a
  // nullable column would also drop null-errorMessage rows, which are valid
  // candidates — e.g. a PENDING with no error recorded).
  const live = candidates.filter((c) => !isResolvedExternally(c.errorMessage));
  const breakdown = { retryable: 0, orphan: 0, remitente: 0, needsAddress: 0 };
  for (const c of live) breakdown[classifyStuck(c.errorMessage, c.deliveryAddress, c.paymentType)] += 1;
  return { count: breakdown.retryable, total: live.length, ...breakdown };
}
