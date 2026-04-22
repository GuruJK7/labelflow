/**
 * Reconciliation job: automatically fixes stuck/failed labels.
 *
 * Runs periodically (every 10 minutes) and handles:
 *
 * 1. FAILED labels with network errors (ERR_ABORTED, timeout) → resets to allow retry
 * 2. Stale PendingShipment rows (>10 min in PENDING) → marked ORPHANED and the
 *    linked Label is parked as NEEDS_REVIEW so the operator can match against
 *    DAC historial before anything gets retried. (C-4, 2026-04-21 audit.)
 * 3. Stale RUNNING jobs (stuck > 10 min) → marks as FAILED so they don't block the queue
 *
 * This replaces a human operator who would check on stuck orders and fix them.
 */
import { db } from '../db';
import logger from '../logger';

// Cadence: a typical order finishes in 20–60 s (YELLOW with AI resolver can go
// up to ~90 s). 10 min is ~10× the worst case, so anything older than that is
// almost certainly orphaned by an OOM/SIGTERM/crash. Shortened from 30 min so
// the queue unblocks faster after an incident.
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_JOB_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
// C-4: PendingShipment rows still in PENDING this long after the Finalizar
// click are almost certainly orphaned — either the worker crashed between
// click and extraction, or the extraction bailed on a form rejection path
// that didn't delete the row. 15 min gives slow DAC flows (YELLOW path with
// captcha + Plexo + historial probe) plenty of room before we intervene.
const ORPHAN_PENDING_SHIPMENT_MS = 15 * 60 * 1000;
const MAX_AUTO_RETRIES = 3;

/**
 * Retryable error patterns — these are transient network/browser errors,
 * NOT logic errors. Safe to retry automatically.
 */
const RETRYABLE_ERRORS = [
  'ERR_ABORTED',
  'net::ERR_',
  'Navigation timeout',
  'Timeout',
  'timeout',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'Target closed',
  'Session closed',
  'Browser closed',
  'page.goto',
  'waiting for selector',
];

function isRetryableError(errorMessage: string | null): boolean {
  if (!errorMessage) return false;
  return RETRYABLE_ERRORS.some(pattern => errorMessage.includes(pattern));
}

export async function runReconciliation(): Promise<void> {
  const startTime = Date.now();
  let fixed = 0;

  try {
    // ================================================
    // 1. Reset FAILED labels with retryable errors
    // ================================================
    const failedLabels = await db.label.findMany({
      where: {
        status: 'FAILED',
        errorMessage: { not: null },
      },
      select: {
        id: true,
        shopifyOrderName: true,
        errorMessage: true,
        dacGuia: true,
        tenantId: true,
        createdAt: true,
        // M-2: structured retry counter replaces the RunLog full-text scan.
        autoRetryCount: true,
      },
    });

    for (const label of failedLabels) {
      if (!isRetryableError(label.errorMessage)) continue;

      // M-2 (2026-04-21 audit): O(1) cap check against a structured field.
      // The previous implementation ran a `RunLog.count WHERE message
      // CONTAINS 'auto-retry:<orderName>'` for every FAILED label on every
      // reconcile pass — linear in RunLog size (millions of rows on busy
      // tenants) and vulnerable to substring false-matches when an order
      // name happened to appear in an unrelated log line. The counter is
      // incremented below on each reset and reset to 0 by the success path
      // in process-orders.job.ts upsert-update, so "already retried N
      // times" is a single field comparison.
      if (label.autoRetryCount >= MAX_AUTO_RETRIES) {
        logger.info(
          { label: label.shopifyOrderName, retries: label.autoRetryCount },
          '[Reconcile] Max auto-retries reached, leaving as FAILED',
        );
        continue;
      }

      // If this label has a real guia, DON'T reset it — the DAC shipment exists
      if (label.dacGuia && !label.dacGuia.startsWith('PENDING-') && !label.dacGuia.startsWith('TEST-')) {
        logger.info({ label: label.shopifyOrderName, guia: label.dacGuia },
          '[Reconcile] FAILED label has real guia — not resetting (would cause duplicate)');
        continue;
      }

      // Reset the FAILED label back to PENDING so the next cron cycle picks
      // it up through the normal path (processOrdersJob's upsert handles the
      // rest — no more deletes, no more orphan-row churn). Bump
      // autoRetryCount so the cap check on the next reconcile pass sees the
      // attempt even if it fails identically. We keep dacGuia intact (the
      // guard above ensures it's null or a placeholder) so the prior-label
      // reuse path in processOrdersJob stays correct.
      await db.label.update({
        where: { id: label.id },
        data: {
          status: 'PENDING',
          errorMessage: null,
          autoRetryCount: { increment: 1 },
        },
      });

      fixed++;
      logger.info(
        {
          label: label.shopifyOrderName,
          error: label.errorMessage?.substring(0, 60),
          nextRetry: label.autoRetryCount + 1,
        },
        '[Reconcile] Reset FAILED label to PENDING for auto-retry',
      );
    }

    // ================================================
    // 2. C-4: orphan stale PendingShipment rows
    // ================================================
    //
    // A PendingShipment in PENDING means the worker clicked Finalizar in DAC
    // but didn't complete guía extraction. The shipment EXISTS in DAC —
    // retrying would double-bill. We don't auto-probe DAC historial here
    // (that lives in a future step 2b once the probe is tested); we just
    // mark the row ORPHANED and park the linked Label as NEEDS_REVIEW so
    // the operator sees it in the dashboard and knows to manually reconcile.
    const orphanCutoff = new Date(Date.now() - ORPHAN_PENDING_SHIPMENT_MS);
    const orphans = await db.pendingShipment.findMany({
      where: {
        status: 'PENDING',
        submitAttemptedAt: { lt: orphanCutoff },
      },
      select: {
        id: true,
        tenantId: true,
        shopifyOrderId: true,
        submitAttemptedAt: true,
      },
    });

    for (const orphan of orphans) {
      try {
        // Flip the marker to ORPHANED so the next pass doesn't re-park the
        // same Label and so the operator has a stable id to triage against.
        await db.pendingShipment.update({
          where: { id: orphan.id },
          data: { status: 'ORPHANED' },
        });

        // Park the linked Label (if any) in NEEDS_REVIEW. We use updateMany
        // (not update) so a missing Label — shouldn't happen, but can —
        // doesn't throw.
        const labelUpdate = await db.label.updateMany({
          where: {
            tenantId: orphan.tenantId,
            shopifyOrderId: orphan.shopifyOrderId,
            status: { notIn: ['COMPLETED', 'NEEDS_REVIEW'] },
          },
          data: {
            status: 'NEEDS_REVIEW',
            errorMessage:
              'C-4: DAC submit attempted but no guía extracted within 15 min — manual reconciliation required (check DAC historial).',
          },
        });

        fixed += 1;
        logger.warn(
          {
            pendingShipmentId: orphan.id,
            tenantId: orphan.tenantId,
            shopifyOrderId: orphan.shopifyOrderId,
            ageMs: Date.now() - orphan.submitAttemptedAt.getTime(),
            labelsParked: labelUpdate.count,
          },
          '[Reconcile] Orphaned PendingShipment — Label parked for review',
        );
      } catch (orphErr) {
        logger.error(
          { error: (orphErr as Error).message, pendingShipmentId: orphan.id },
          '[Reconcile] Failed to orphan PendingShipment row',
        );
      }
    }

    // ================================================
    // 3. Fix stale RUNNING jobs (stuck > 10 minutes)
    // ================================================
    const staleThreshold = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
    const staleJobs = await db.job.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: staleThreshold },
      },
      data: {
        status: 'FAILED',
        errorMessage: 'Auto-reconciled: job was stuck in RUNNING for >10 minutes',
        finishedAt: new Date(),
      },
    });

    if (staleJobs.count > 0) {
      logger.warn({ count: staleJobs.count }, '[Reconcile] Fixed stale RUNNING jobs');
      fixed += staleJobs.count;
    }

    // ================================================
    // 4. Log summary
    // ================================================
    const durationMs = Date.now() - startTime;
    logger.info({ fixed, durationMs }, '[Reconcile] Reconciliation complete');

  } catch (err) {
    logger.error({ error: (err as Error).message }, '[Reconcile] Reconciliation failed');
  }
}

/**
 * Start the reconciliation loop.
 * Runs every 30 minutes, independent of the main processing loop.
 */
export function startReconciliationLoop(): void {
  // A boot-time reconcile runs in index.ts before we begin polling. After
  // that, run every 10 min. No initial delay here — index.ts already fired
  // the first pass before calling us.
  setInterval(runReconciliation, RECONCILE_INTERVAL_MS);

  logger.info({ intervalMs: RECONCILE_INTERVAL_MS },
    '[Reconcile] Reconciliation loop scheduled (every 10 min; boot pass fires separately from index.ts)');
}
