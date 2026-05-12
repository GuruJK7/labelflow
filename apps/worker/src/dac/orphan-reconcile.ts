/**
 * Orphan-PendingShipment auto-reconcile.
 *
 * Background (2026-05-12 audit):
 *
 * The C-4 guard in shipment.ts marks a PendingShipment row as ORPHANED when
 * the worker clicked DAC's Finalizar button but couldn't extract a guía in
 * 15 min (e.g. silent reject + rescue path missed the historial row in its
 * narrow first-attempt window). The order's Label is parked as NEEDS_REVIEW
 * and `partitionByStuckPendingShipment` skips the order on every subsequent
 * cron tick — refusing to re-submit the form because that might duplicate
 * a real DAC shipment.
 *
 * Production state on 2026-05-12: 10 orders sitting in this state for hours
 * (oldest 46.8h) on one tenant. Each one is either:
 *   (a) DAC actually created the guía — it's hiding in historial under a
 *       recipient+destination match, just out of the original rescue's
 *       sight (timing/pagination), OR
 *   (b) DAC silent-rejected with no guía minted — the order is safe to
 *       retry from scratch (next cycle's normal flow will handle it).
 *
 * This module proactively distinguishes (a) from (b) using the SAME
 * recipient+destination historial scan that the in-line rescue uses
 * (`findRecentGuiaForRecipient`), but applied AFTER login from a
 * standalone cron pass instead of mid-shipment. Outcomes:
 *
 *   (a) recovered  → Label.dacGuia=<real>, Label.status=FAILED,
 *                    PendingShipment.status=RESOLVED. Next cron cycle's
 *                    existing prior-label-with-real-guia path (see
 *                    process-orders.job.ts ~line 759) skips the DAC form
 *                    and runs PDF download + Shopify fulfill directly.
 *
 *   (b) reset      → PendingShipment row deleted, Label flipped back to
 *                    PENDING. Next cron cycle treats the order as fresh
 *                    and runs the full submit pipeline (which now has
 *                    the new cross-street detector / name inference /
 *                    Tacuarembó accent fixes from earlier today).
 *
 * Safety guard: we never adopt a guía that already lives on another Label
 * in the same tenant (excludeGuias). That prevents the
 * "Noelia Osorio poisoning" class of bug.
 *
 * Cadence: runs once per process-orders cycle (15 min) AFTER DAC login,
 * limited to N orphans per pass so a backlog drains across a few cycles
 * rather than hammering DAC historial in one go.
 */
import type { Page } from 'playwright';
import { db } from '../db';
import { findRecentGuiaForRecipient } from './shipment';
import type { StepLogger } from '../logger';

const STEP = 'orphan-reconcile';

export type OrphanReconcileOutcome =
  | { kind: 'recovered'; guia: string }
  | { kind: 'reset-for-retry' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string };

export interface OrphanReconcileSummary {
  total: number;
  recovered: number;
  resetForRetry: number;
  skipped: number;
  errored: number;
  details: Array<{ orderName: string; outcome: OrphanReconcileOutcome }>;
}

export interface OrphanReconcileOptions {
  /** Max orphans to process in one pass. Default 5 — prevents hammering DAC's
   *  historial under a backlog and keeps the cycle's total time bounded. */
  maxOrphans?: number;
  /** Minimum age (ms) before an ORPHANED row is eligible for auto-reconcile.
   *  Default 30 min — gives the regular worker a chance to handle the order
   *  through the normal path before we intervene. */
  minAgeMs?: number;
}

/**
 * Reconcile up to N ORPHANED PendingShipments for a tenant against DAC
 * historial. Caller is responsible for passing a Page that is already
 * logged into DAC — we don't manage the session here.
 *
 * Returns a summary the caller can log + surface in the cycle log.
 */
export async function reconcileOrphansForTenant(
  page: Page,
  tenantId: string,
  slog: StepLogger,
  options: OrphanReconcileOptions = {},
): Promise<OrphanReconcileSummary> {
  const maxOrphans = options.maxOrphans ?? 5;
  const minAgeMs = options.minAgeMs ?? 30 * 60 * 1000; // 30 min
  const cutoff = new Date(Date.now() - minAgeMs);

  const orphans = await db.pendingShipment.findMany({
    where: {
      tenantId,
      status: 'ORPHANED',
      submitAttemptedAt: { lt: cutoff },
    },
    orderBy: { submitAttemptedAt: 'asc' }, // oldest first — least risky to recover
    take: maxOrphans,
  });

  const summary: OrphanReconcileSummary = {
    total: orphans.length,
    recovered: 0,
    resetForRetry: 0,
    skipped: 0,
    errored: 0,
    details: [],
  };

  if (orphans.length === 0) {
    return summary;
  }

  slog.info(
    STEP,
    `Found ${orphans.length} ORPHANED PendingShipment(s) ≥${Math.round(minAgeMs / 60000)}min old — attempting historial reconcile`,
    { maxOrphans, minAgeMs },
  );

  // Batch-load the Labels for all orphans in one query.
  const labels = await db.label.findMany({
    where: {
      tenantId,
      shopifyOrderId: { in: orphans.map((o) => o.shopifyOrderId) },
    },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      customerName: true,
      city: true,
      department: true,
    },
  });
  const labelByOrderId = new Map(labels.map((l) => [l.shopifyOrderId, l]));

  // Build the exclude list once — every real guía already linked on this
  // tenant. We never want to adopt a guía that's already on someone else's
  // label (poisoning defense).
  const existingGuiasRows = await db.label.findMany({
    where: { tenantId, dacGuia: { not: null } },
    select: { dacGuia: true },
  });
  const excludeGuias = existingGuiasRows
    .map((r) => r.dacGuia as string)
    .filter((g) => !g.startsWith('PENDING-') && !g.startsWith('TEST-'));

  for (const orphan of orphans) {
    const label = labelByOrderId.get(orphan.shopifyOrderId);
    const orderName = label?.shopifyOrderName ?? `(orphan:${orphan.shopifyOrderId})`;

    // Case 0: PendingShipment without a Label row. Anomalous, but safe to
    // just delete — there's no Label to lose, and the order will get a
    // fresh attempt next cycle.
    if (!label) {
      try {
        await db.pendingShipment.delete({ where: { id: orphan.id } });
        summary.skipped += 1;
        summary.details.push({
          orderName,
          outcome: { kind: 'skipped', reason: 'no Label row exists' },
        });
        slog.info(
          STEP,
          `[${orderName}] No Label row — deleted dangling PendingShipment so cycle can retry from scratch`,
        );
      } catch (delErr) {
        summary.errored += 1;
        summary.details.push({
          orderName,
          outcome: { kind: 'error', message: (delErr as Error).message },
        });
      }
      continue;
    }

    // Case 1: recipient name too short for safe historial matching. We skip
    // these to avoid false positives (a 1-2 letter name could match dozens
    // of unrelated guías in historial).
    if (!label.customerName || label.customerName.trim().length < 3) {
      summary.skipped += 1;
      summary.details.push({
        orderName,
        outcome: { kind: 'skipped', reason: 'recipient name too short for safe historial match' },
      });
      slog.warn(
        STEP,
        `[${orderName}] Recipient name "${label.customerName ?? ''}" too short — refusing to rescue (would risk poisoning)`,
      );
      continue;
    }

    // Case 2 + 3: run the historial scan. Same primitive as the in-line
    // rescue path.
    let rescued: { guia: string; trackingUrl?: string } | null;
    try {
      rescued = await findRecentGuiaForRecipient(
        page,
        label.customerName,
        excludeGuias,
        slog,
        orderName,
        { city: label.city, department: label.department },
      );
    } catch (rescueErr) {
      summary.errored += 1;
      summary.details.push({
        orderName,
        outcome: { kind: 'error', message: (rescueErr as Error).message },
      });
      slog.warn(
        STEP,
        `[${orderName}] Historial scan threw — leaving ORPHANED for next pass: ${(rescueErr as Error).message}`,
      );
      continue;
    }

    if (rescued) {
      // Case 2: RECOVERED. DAC has the guía. Link it on the Label, flip
      // Label.status=FAILED so the existing prior-label-with-real-guia
      // branch in process-orders.job.ts (around line 759) handles the
      // PDF download + Shopify fulfill on the next cycle.
      //
      // PendingShipment goes to RESOLVED so partitionByStuckPendingShipment
      // stops filtering the order out.
      try {
        await db.$transaction([
          db.label.update({
            where: { id: label.id },
            data: {
              status: 'FAILED',
              dacGuia: rescued.guia,
              errorMessage: `Orphan-reconcile recovered guía ${rescued.guia} from DAC historial — next cycle will download PDF + fulfill Shopify.`,
            },
          }),
          db.pendingShipment.update({
            where: { id: orphan.id },
            data: {
              status: 'RESOLVED',
              resolvedGuia: rescued.guia,
              resolvedAt: new Date(),
              errorNote: 'Auto-reconciled from DAC historial via recipient + destination match.',
            },
          }),
        ]);
        // Track the just-adopted guía so we don't adopt it again on a sibling
        // orphan in this same pass (the same guía cannot belong to two orders).
        excludeGuias.push(rescued.guia);
        summary.recovered += 1;
        summary.details.push({
          orderName,
          outcome: { kind: 'recovered', guia: rescued.guia },
        });
        slog.success(
          STEP,
          `[${orderName}] Recovered guía ${rescued.guia} from historial — Label.dacGuia set, PendingShipment RESOLVED. Next cycle will fulfill in Shopify.`,
          { guia: rescued.guia, trackingUrl: rescued.trackingUrl },
        );
      } catch (txErr) {
        summary.errored += 1;
        summary.details.push({
          orderName,
          outcome: { kind: 'error', message: (txErr as Error).message },
        });
        slog.error(
          STEP,
          `[${orderName}] Failed to persist recovery transaction: ${(txErr as Error).message}`,
        );
      }
    } else {
      // Case 3: NOT FOUND. Historial scan exhausted (3 attempts × up to 3
      // pages each) without finding a recipient+destination match. Safe to
      // assume DAC didn't mint a guía → delete PendingShipment and flip
      // Label back to PENDING so the next cycle treats it as fresh.
      try {
        await db.$transaction([
          db.pendingShipment.delete({ where: { id: orphan.id } }),
          db.label.update({
            where: { id: label.id },
            data: {
              status: 'PENDING',
              errorMessage: null,
            },
          }),
        ]);
        summary.resetForRetry += 1;
        summary.details.push({
          orderName,
          outcome: { kind: 'reset-for-retry' },
        });
        slog.info(
          STEP,
          `[${orderName}] No guía found in historial after thorough scan — PendingShipment deleted, Label reset to PENDING. Order eligible for fresh submit next cycle.`,
        );
      } catch (txErr) {
        summary.errored += 1;
        summary.details.push({
          orderName,
          outcome: { kind: 'error', message: (txErr as Error).message },
        });
        slog.error(
          STEP,
          `[${orderName}] Failed to reset for retry: ${(txErr as Error).message}`,
        );
      }
    }
  }

  slog.info(
    STEP,
    `Reconcile pass complete: ${summary.recovered} recovered, ${summary.resetForRetry} reset-for-retry, ${summary.skipped} skipped, ${summary.errored} errored (of ${summary.total} eligible orphans)`,
    {
      recovered: summary.recovered,
      resetForRetry: summary.resetForRetry,
      skipped: summary.skipped,
      errored: summary.errored,
      total: summary.total,
    },
  );

  return summary;
}
