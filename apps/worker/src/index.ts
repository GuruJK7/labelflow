import { getConfig } from './config';
import { processOrdersJob } from './jobs/process-orders.job';
import { processOrdersBulkJob } from './jobs/process-orders-bulk.job';
import { testDacJob } from './jobs/test-dac.job';
import { pollAgentBulkJobs } from './jobs/agent-bulk-upload.job';
import { startScheduler } from './jobs/scheduler';
import { dacBrowser } from './dac/browser';
import { db } from './db';
import logger from './logger';
import { processAdUploadJob } from './ads/upload-job';
import { processAdMonitorJob } from './ads/monitor-job';
import { processRecoverMessage } from './recover/process-message';
import { startReconciliationLoop, runReconciliation } from './jobs/reconcile.job';
import { flushWorkerAnalytics } from './analytics';

// Emit memory usage every 60 s so we can catch leaks / OOM risk in Render
// logs before the container gets killed. Numbers are in MB for readability.
const MEMORY_LOG_INTERVAL_MS = 60_000;
function startMemoryLogging(): void {
  setInterval(() => {
    const mem = process.memoryUsage();
    const toMB = (n: number) => Math.round(n / 1024 / 1024);
    logger.info(
      {
        rssMB: toMB(mem.rss),
        heapUsedMB: toMB(mem.heapUsed),
        heapTotalMB: toMB(mem.heapTotal),
        externalMB: toMB(mem.external),
        arrayBuffersMB: toMB(mem.arrayBuffers),
      },
      '[memory] worker memory snapshot',
    );
  }, MEMORY_LOG_INTERVAL_MS);
}

const RECOVER_POLL_INTERVAL_MS = 10_000; // Check for recover jobs every 10 seconds

const POLL_INTERVAL_MS = 5_000; // Check for jobs every 5 seconds
const AGENT_POLL_INTERVAL_MS = 30_000; // Agent polls less aggressively

// AGENT_MODE=true → this worker is running on Adrian's Mac, only picks up WAITING_FOR_AGENT jobs
const AGENT_MODE = process.env.AGENT_MODE === 'true';

/**
 * C-6 (2026-04-21 audit): atomic claim of the oldest PENDING job.
 *
 * Previously `findFirst({ status: 'PENDING' })` would return the same row to
 * two workers polling simultaneously; both would then call the processor,
 * both would UPDATE to RUNNING, and both would start hitting Shopify/DAC
 * concurrently for the same tenant. The fix uses a single atomic SQL
 * statement — `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED
 * LIMIT 1)` — so Postgres row-locking guarantees exactly one worker wins the
 * claim; any concurrent poller sees the row as locked and skips it.
 *
 * Returns the claimed row (now in RUNNING state) or null if nothing pending.
 * Processors MUST NOT re-mark the job as RUNNING — that's already done here.
 */
async function claimPendingJob(): Promise<
  { id: string; tenantId: string; type: string } | null
> {
  const rows = await db.$queryRaw<
    Array<{ id: string; tenantId: string; type: string }>
  >`
    UPDATE "Job"
    SET status = 'RUNNING', "startedAt" = NOW()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'PENDING'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "tenantId", type;
  `;
  return rows.length > 0 ? rows[0] : null;
}

async function pollForJobs(): Promise<void> {
  try {
    const claimed = await claimPendingJob();
    if (!claimed) return;

    logger.info(
      { jobId: claimed.id, tenantId: claimed.tenantId, type: claimed.type },
      'Claimed pending job, processing...'
    );

    // Route to correct processor based on job type
    if (claimed.type === 'TEST_DAC') {
      logger.info({ jobId: claimed.id }, 'Routing to TEST_DAC processor');
      await testDacJob(claimed.tenantId, claimed.id);
    } else if (claimed.type === 'PROCESS_ORDERS_BULK') {
      logger.info({ jobId: claimed.id }, 'Routing to BULK processor');
      await processOrdersBulkJob(claimed.tenantId, claimed.id);
    } else {
      await processOrdersJob(claimed.tenantId, claimed.id);
    }

    logger.info({ jobId: claimed.id }, 'Job completed');
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Error in poll cycle');
  }
}

/**
 * C-6: atomic claim for AdUploadJob — same pattern as claimPendingJob.
 */
async function claimPendingAdUploadJob(): Promise<
  { id: string; metaAdAccountId: string } | null
> {
  const rows = await db.$queryRaw<
    Array<{ id: string; metaAdAccountId: string }>
  >`
    UPDATE "AdUploadJob"
    SET status = 'RUNNING', "startedAt" = NOW()
    WHERE id = (
      SELECT id FROM "AdUploadJob"
      WHERE status = 'PENDING'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "metaAdAccountId";
  `;
  return rows.length > 0 ? rows[0] : null;
}

async function pollForAdUploadJobs(): Promise<void> {
  const claimed = await claimPendingAdUploadJob();
  if (!claimed) return;

  logger.info(
    { jobId: claimed.id, metaAdAccountId: claimed.metaAdAccountId },
    'Claimed ad upload job, processing...'
  );

  try {
    await processAdUploadJob(claimed.id, claimed.metaAdAccountId);
  } catch (err) {
    logger.error(
      { jobId: claimed.id, error: (err as Error).message },
      'Unhandled error in ad upload job — marking FAILED'
    );
    await db.adUploadJob
      .update({
        where: { id: claimed.id },
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: ((err as Error).message ?? 'Unhandled error').slice(0, 500) },
      })
      .catch(() => {});
  }
}

/**
 * Polls for pending RecoverJobs that are due to be sent.
 * Picks the oldest scheduled job where scheduledFor <= NOW().
 * Completely independent of DAC and Ads loops.
 */
async function pollForRecoverJobs(): Promise<void> {
  // C-6: atomic claim. Two workers can no longer both pick up the same recover
  // job and double-send the same WhatsApp message. We keep the scheduledFor
  // filter inside the inner SELECT so not-yet-due jobs aren't locked.
  const rows = await db.$queryRaw<
    Array<{ id: string; cartId: string; messageNumber: number }>
  >`
    UPDATE "RecoverJob"
    SET status = 'RUNNING', "startedAt" = NOW()
    WHERE id = (
      SELECT id FROM "RecoverJob"
      WHERE status = 'PENDING' AND "scheduledFor" <= NOW()
      ORDER BY "scheduledFor" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "cartId", "messageNumber";
  `;
  const claimed = rows.length > 0 ? rows[0] : null;
  if (!claimed) return;

  logger.info(
    { jobId: claimed.id, cartId: claimed.cartId, messageNumber: claimed.messageNumber },
    '[Recover] Claimed recover job, processing...'
  );

  try {
    await processRecoverMessage(claimed.id);
  } catch (err) {
    // Ensure the job never stays stuck in RUNNING state
    logger.error(
      { jobId: claimed.id, error: (err as Error).message },
      '[Recover] Unhandled error in processRecoverMessage — marking job FAILED'
    );
    await db.recoverJob
      .update({
        where: { id: claimed.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: ((err as Error).message ?? 'Unhandled error').slice(0, 500),
        },
      })
      .catch(() => {}); // best-effort — don't throw again
  }
}

async function pollForAdMonitorJobs(): Promise<void> {
  // C-6: atomic claim — see pollForJobs for the rationale.
  const rows = await db.$queryRaw<
    Array<{ id: string; metaAdAccountId: string }>
  >`
    UPDATE "AdMonitorQueue"
    SET status = 'RUNNING', "startedAt" = NOW()
    WHERE id = (
      SELECT id FROM "AdMonitorQueue"
      WHERE status = 'PENDING'
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, "metaAdAccountId";
  `;
  const claimed = rows.length > 0 ? rows[0] : null;
  if (!claimed) return;

  logger.info(
    { jobId: claimed.id, metaAdAccountId: claimed.metaAdAccountId },
    'Claimed ad monitor job, processing...'
  );

  try {
    await processAdMonitorJob(claimed.id, claimed.metaAdAccountId);
  } catch (err) {
    logger.error(
      { jobId: claimed.id, error: (err as Error).message },
      'Unhandled error in ad monitor job — marking FAILED'
    );
    await db.adMonitorQueue
      .update({
        where: { id: claimed.id },
        data: { status: 'FAILED', finishedAt: new Date(), errorMessage: ((err as Error).message ?? 'Unhandled error').slice(0, 500) },
      })
      .catch(() => {});
  }
}

async function main(): Promise<void> {
  const config = getConfig();

  logger.info(
    {
      concurrency: config.WORKER_CONCURRENCY,
      headless: config.PLAYWRIGHT_HEADLESS,
      pollInterval: POLL_INTERVAL_MS,
      agentMode: AGENT_MODE,
    },
    `LabelFlow Worker starting (DB polling mode, ${AGENT_MODE ? 'AGENT' : 'RENDER'} role)...`,
  );

  // AGENT MODE: only process WAITING_FOR_AGENT jobs (runs on Adrian's Mac)
  if (AGENT_MODE) {
    const pollAgent = async () => {
      while (true) {
        try {
          await pollAgentBulkJobs();
        } catch (err) {
          logger.error({ error: (err as Error).message }, '[Agent] Unhandled error in agent poll cycle');
        }
        await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_INTERVAL_MS));
      }
    };
    pollAgent();
    logger.info('[Agent] Worker in AGENT_MODE — only polling for WAITING_FOR_AGENT jobs');
    // In agent mode, skip all the other loops (Render handles regular jobs/ads/recover/cron)
    process.on('SIGTERM', async () => { await flushWorkerAnalytics(); await dacBrowser.close(); await db.$disconnect(); process.exit(0); });
    process.on('SIGINT', async () => { await flushWorkerAnalytics(); await dacBrowser.close(); await db.$disconnect(); process.exit(0); });
    return;
  }

  // RENDER MODE (normal): poll for all job types except WAITING_FOR_AGENT
  // Poll loop — DAC jobs
  const poll = async () => {
    while (true) {
      try {
        await pollForJobs();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'Unhandled error in DAC poll cycle');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  poll();

  // Poll loop — Meta Ads jobs (independent, never affects DAC)
  const pollAds = async () => {
    while (true) {
      try {
        await pollForAdUploadJobs();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'Error in ad upload poll cycle');
      }
      try {
        await pollForAdMonitorJobs();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'Error in ad monitor poll cycle');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  pollAds();

  // Poll loop — Recover jobs (WhatsApp cart recovery, independent of DAC and Ads)
  const pollRecover = async () => {
    while (true) {
      try {
        await pollForRecoverJobs();
      } catch (err) {
        logger.error({ error: (err as Error).message }, '[Recover] Error in recover poll cycle');
      }
      await new Promise((resolve) => setTimeout(resolve, RECOVER_POLL_INTERVAL_MS));
    }
  };

  pollRecover();

  // Start cron scheduler (checks every minute, validates all 5 cron fields)
  startScheduler();

  // Run reconciliation immediately on boot so any RUNNING job orphaned by a
  // previous crash/SIGTERM gets cleaned up before we start picking up new
  // work. Fire-and-forget — errors are logged inside runReconciliation.
  runReconciliation().catch((err) =>
    logger.error({ error: (err as Error).message }, '[Reconcile] Boot-time reconciliation failed'),
  );

  // Start reconciliation loop (auto-fixes FAILED labels every 30 min)
  startReconciliationLoop();

  // Memory telemetry so we can spot leaks / OOM risk in Render logs.
  startMemoryLogging();

  logger.info('LabelFlow Worker ready and polling for jobs');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker...');
    // Flush PostHog buffer first — events captured during the last poll
    // cycle are still in memory; without this they get dropped on Render
    // redeploy. flushWorkerAnalytics() is a no-op if PostHog wasn't
    // initialized (env vars unset).
    await flushWorkerAnalytics();
    await dacBrowser.close();
    await db.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ error: (err as Error).message }, 'Fatal worker error');
  process.exit(1);
});
