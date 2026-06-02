/**
 * Reconciliation job: automatically fixes stuck/failed labels.
 *
 * Runs periodically (every 10 minutes) and handles:
 *
 * 1. FAILED labels with network errors (ERR_ABORTED, timeout) → resets to allow retry
 * 2. Stale PendingShipment rows (>10 min in PENDING) → marked ORPHANED and the
 *    linked Label is parked as NEEDS_REVIEW so the operator can match against
 *    DAC historial before anything gets retried. (C-4, 2026-04-21 audit.)
 * 3. Stale RUNNING jobs (no sign of life) → marks as FAILED so they don't block
 *    the queue. "No sign of life" = older than STALE_JOB_THRESHOLD_MS AND no
 *    live DAC lease AND no RunLog within STALE_JOB_NO_PROGRESS_MS. A healthy
 *    long run (a full order batch can take ~30 min) is never touched.
 *
 * This replaces a human operator who would check on stuck orders and fix them.
 */
import { db } from '../db';
import logger from '../logger';
import { deductCreditsAndStamp } from '../credits';
import { isJobStillAlive } from './job-liveness';

// Cadence: a typical order finishes in 20–60 s (YELLOW with AI resolver can go
// up to ~90 s).
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
// Minimum age before a RUNNING job is even *considered* for the stale sweep.
// This is NOT "fail at 10 min" — see STALE_JOB_NO_PROGRESS_MS and
// isJobStillAlive(). A full PROCESS_ORDERS cycle ships up to maxOrdersPerRun
// orders serially through DAC's slow form (20 × ~90 s ≈ 30 min), so absolute
// age alone is a terrible "is it stuck?" signal — it used to mislabel healthy
// long runs as FAILED, corrupting dashboard stats and draining credits early
// (2026-06-02 audit). Past this floor we additionally require no sign of life.
const STALE_JOB_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
// A live worker writes a RunLog every few seconds and refreshes its DAC lease
// every 2 min. If a RUNNING job has gone silent on BOTH for this long, the
// worker really did die (OOM/SIGTERM/kill -9) and the row must be reconciled.
// 8 min sits comfortably above the longest quiet stretch of a healthy run (DAC
// login + orphan-reconcile historial scan) while still recovering real crashes
// within a couple of reconcile passes.
const STALE_JOB_NO_PROGRESS_MS = 8 * 60 * 1000; // 8 minutes
// C-4: PendingShipment rows still in PENDING this long after the Finalizar
// click are almost certainly orphaned — either the worker crashed between
// click and extraction, or the extraction bailed on a form rejection path
// that didn't delete the row. 15 min gives slow DAC flows (YELLOW path with
// captcha + Plexo + historial probe) plenty of room before we intervene.
const ORPHAN_PENDING_SHIPMENT_MS = 15 * 60 * 1000;
// CreditPurchase sigue PENDING porque el usuario hizo click en "Comprar"
// pero abandonó el flow de MercadoPago. La preferencia MP expira a las 24h
// (default), así que cualquier PENDING más viejo que eso es ruido en el
// historial del tenant — lo flippeamos a FAILED.
const STALE_CREDIT_PURCHASE_MS = 24 * 60 * 60 * 1000;
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

/**
 * DB-backed liveness probe for the stale-job sweep. Gathers the two signals
 * isJobStillAlive() needs:
 *   1. the DAC processing lease for this tenant (if it still points at this
 *      job and hasn't expired, the worker is actively heartbeating it), and
 *   2. the timestamp of the job's most recent RunLog.
 *
 * Biases to "alive" (returns true) if the probe itself errors — we would much
 * rather re-check a possibly-dead job on the next pass than wrongly FAIL a
 * healthy one mid-run.
 */
async function jobShowsRecentProgress(job: {
  id: string;
  tenantId: string;
}): Promise<boolean> {
  try {
    const now = Date.now();

    const lease = await db.dacProcessingLease.findUnique({
      where: { tenantId: job.tenantId },
      select: { jobId: true, expiresAt: true },
    });
    const leaseExpiresAt =
      lease && lease.jobId === job.id ? lease.expiresAt.getTime() : null;

    const lastLog = await db.runLog.findFirst({
      where: { tenantId: job.tenantId, jobId: job.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const lastRunLogAt = lastLog ? lastLog.createdAt.getTime() : null;

    return isJobStillAlive({
      now,
      leaseExpiresAt,
      lastRunLogAt,
      noProgressMs: STALE_JOB_NO_PROGRESS_MS,
    });
  } catch (probeErr) {
    logger.warn(
      {
        jobId: job.id,
        tenantId: job.tenantId,
        error: (probeErr as Error).message,
      },
      '[Reconcile] Liveness probe failed — assuming job alive, will re-check next pass',
    );
    return true;
  }
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
    //
    // 2026-04-29: when a stale job is auto-failed, drain credits for the
    // successCount it banked via mid-run checkpoint. Without this, an
    // external crash (kill -9, OOM, server restart) means orders that
    // already shipped (DAC guia generated, Shopify fulfilled, customer
    // emailed) get billed zero — silent revenue leak.
    //
    // The mid-run checkpoint in process-orders.job.ts and
    // agent-bulk-upload.job.ts increments Job.successCount after each fully
    // successful order, so by the time reconcile sees the row, that field
    // is the source of truth for "how many shipments shipped before the
    // crash". deductCreditsAndStamp is the same helper the happy-path uses.
    const staleThreshold = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
    const staleJobs = await db.job.findMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: staleThreshold },
      },
      select: {
        id: true,
        tenantId: true,
        successCount: true,
      },
    });

    let reconciledStale = 0;
    for (const job of staleJobs) {
      // 2026-06-02 audit: do NOT fail a job purely because it has been RUNNING
      // a while. A real order batch legitimately runs ~30 min. Only reconcile a
      // job that ALSO shows no sign of life (no live DAC lease AND no recent
      // RunLog) — otherwise we corrupt the dashboard and drain credits while
      // the worker is still actively shipping.
      if (await jobShowsRecentProgress(job)) {
        logger.info(
          { jobId: job.id, tenantId: job.tenantId },
          '[Reconcile] RUNNING job past age floor but still progressing (live lease / recent logs) — leaving alone',
        );
        continue;
      }

      try {
        await db.job.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorMessage:
              'Auto-reconciled: job had no sign of life (no live DAC lease, no recent logs) for >10 min',
            finishedAt: new Date(),
          },
        });

        if (job.successCount > 0) {
          await deductCreditsAndStamp(job.tenantId, job.successCount).catch(
            (deductErr) => {
              logger.error(
                {
                  jobId: job.id,
                  tenantId: job.tenantId,
                  successCount: job.successCount,
                  error: (deductErr as Error).message,
                },
                '[Reconcile] Failed to drain credits for stale job — manual reconciliation needed',
              );
            },
          );
          logger.info(
            { jobId: job.id, tenantId: job.tenantId, drained: job.successCount },
            '[Reconcile] Drained banked credits from stale-failed job',
          );
        }

        fixed += 1;
        reconciledStale += 1;
      } catch (failErr) {
        logger.error(
          { jobId: job.id, error: (failErr as Error).message },
          '[Reconcile] Failed to mark stale job as FAILED',
        );
      }
    }

    if (staleJobs.length > 0) {
      logger.warn(
        {
          considered: staleJobs.length,
          reconciled: reconciledStale,
          stillAlive: staleJobs.length - reconciledStale,
        },
        '[Reconcile] Stale RUNNING job sweep complete',
      );
    }

    // ================================================
    // 4. Sweep stale PENDING CreditPurchase rows (>24h)
    // ================================================
    //
    // El handler /api/credit-packs/checkout crea un row PENDING antes de
    // redirigir a MercadoPago. Si el usuario abandona el checkout, el row
    // se queda PENDING para siempre y aparece en su historial como pago en
    // proceso (falso positivo). MP expira la preferencia a 24h por default,
    // así que cualquier row más viejo que eso ya no se va a aprobar.
    const stalePurchaseCutoff = new Date(Date.now() - STALE_CREDIT_PURCHASE_MS);
    const stalePurchases = await db.creditPurchase.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: stalePurchaseCutoff },
      },
      data: {
        status: 'FAILED',
      },
    });

    if (stalePurchases.count > 0) {
      logger.warn(
        { count: stalePurchases.count, olderThanHours: STALE_CREDIT_PURCHASE_MS / (60 * 60 * 1000) },
        '[Reconcile] Marked stale PENDING CreditPurchase rows as FAILED (abandoned checkouts)',
      );
      fixed += stalePurchases.count;
    }

    // ================================================
    // 5. Log summary
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
