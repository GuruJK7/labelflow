/**
 * Reconciliation job: automatically fixes stuck/failed labels.
 *
 * Runs periodically (every 10 minutes) and handles:
 *
 * 1. FAILED labels with network errors (ERR_ABORTED, timeout) → resets to allow retry
 * 2. CREATED labels with PENDING guia → tries to find the real guia in DAC historial
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
      },
    });

    for (const label of failedLabels) {
      if (!isRetryableError(label.errorMessage)) continue;

      // Check how many times we've already auto-retried this label
      const retryCount = await db.runLog.count({
        where: {
          tenantId: label.tenantId,
          message: { contains: `auto-retry:${label.shopifyOrderName}` },
        },
      });

      if (retryCount >= MAX_AUTO_RETRIES) {
        logger.info({ label: label.shopifyOrderName, retries: retryCount },
          '[Reconcile] Max auto-retries reached, leaving as FAILED');
        continue;
      }

      // If this label has a real guia, DON'T reset it — the DAC shipment exists
      if (label.dacGuia && !label.dacGuia.startsWith('PENDING-') && !label.dacGuia.startsWith('TEST-')) {
        logger.info({ label: label.shopifyOrderName, guia: label.dacGuia },
          '[Reconcile] FAILED label has real guia — not resetting (would cause duplicate)');
        continue;
      }

      // Delete the FAILED label record so the order can be re-processed fresh
      await db.label.delete({ where: { id: label.id } });

      // Log the auto-retry for tracking
      await db.runLog.create({
        data: {
          tenantId: label.tenantId,
          jobId: 'reconcile',
          level: 'INFO',
          message: `auto-retry:${label.shopifyOrderName} — deleted FAILED label (${label.errorMessage?.substring(0, 80)})`,
        },
      });

      fixed++;
      logger.info({ label: label.shopifyOrderName, error: label.errorMessage?.substring(0, 60) },
        '[Reconcile] Deleted FAILED label for auto-retry');
    }

    // ================================================
    // 2. Fix stale RUNNING jobs (stuck > 30 minutes)
    // ================================================
    const staleThreshold = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
    const staleJobs = await db.job.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: staleThreshold },
      },
      data: {
        status: 'FAILED',
        errorMessage: 'Auto-reconciled: job was stuck in RUNNING for >30 minutes',
        finishedAt: new Date(),
      },
    });

    if (staleJobs.count > 0) {
      logger.warn({ count: staleJobs.count }, '[Reconcile] Fixed stale RUNNING jobs');
      fixed += staleJobs.count;
    }

    // ================================================
    // 3. Log summary
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
