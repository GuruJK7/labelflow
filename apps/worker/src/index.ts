// 2026-05-15 — Sentry MUST be initialized BEFORE the other imports below
// because Sentry auto-instruments errors and outgoing requests by monkey-
// patching globals (fetch, http.request). If any other module captures a
// reference BEFORE Sentry runs, Sentry never sees those calls. Keep this
// as the literal first import in the worker entry point.
import { initSentry, captureWorkerError, flushSentry } from './observability/sentry';
initSentry();

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

// ─── Graceful shutdown state (2026-05-12 incident) ───────────────────────
//
// When Render redeploys, the OLD worker receives SIGTERM. Render's rolling
// deploy means the NEW worker is live before the OLD worker is killed,
// creating a brief overlap window (~30-60s) where BOTH can claim jobs from
// the same PENDING queue.
//
// Before this fix the OLD worker would:
//   1. Receive SIGTERM
//   2. Continue running the poll loop (`while (true)`)
//   3. Claim a fresh job and start processing (browser, CAPTCHA, DAC form)
//   4. Get SIGKILLed by Render mid-flow
//   5. Leave the Job row in RUNNING status forever
//   6. Leave a DAC processing lease that locks out the new worker for 10 min
//   7. Customer sees "Ya hay un job en ejecucion. Espera a que termine."
//
// The 2026-05-12 incident — User triggered "Procesar Ahora" 9s after a
// new worker came up. Old worker (still alive) claimed the job, spent 40s
// in CAPTCHA solve, was killed at 40s mark. Job stayed RUNNING. New worker
// was healthy but blocked because the dashboard refused to enqueue a new
// job while one was supposedly running.
//
// Fix:
//   - `isShuttingDown` flag flipped to true on the FIRST SIGTERM/SIGINT.
//     `pollForJobs` checks it BEFORE claiming and returns immediately if
//     true, so no new claims happen even though the poll loop is still
//     spinning waiting for `process.exit()`.
//   - `currentJobId` tracks the in-flight job. The shutdown handler uses
//     it to atomically flip RUNNING → FAILED (only if still RUNNING) and
//     release any DAC processing lease for that tenant.
//   - The new worker's boot-time reconciliation will see the FAILED row
//     and the freed lease and pick up retry on the next cron tick.
let isShuttingDown = false;
let currentJobId: string | null = null;
let currentJobTenantId: string | null = null;

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
  // Graceful-shutdown guard: when SIGTERM has been received, stop claiming
  // new jobs. The poll loop's `while (true)` keeps spinning until
  // process.exit() runs inside the shutdown handler — without this check,
  // a stray claim during the SIGTERM grace window would create the exact
  // zombie-job state the 2026-05-12 incident exposed.
  if (isShuttingDown) return;

  let claimedJobId: string | null = null;
  try {
    const claimed = await claimPendingJob();
    if (!claimed) return;

    claimedJobId = claimed.id;
    currentJobId = claimed.id;
    currentJobTenantId = claimed.tenantId;

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
    logger.error({ jobId: claimedJobId, error: (err as Error).message }, 'Error in poll cycle');
    // Same pattern as pollForAdUploadJobs / pollForRecoverJobs: when the
    // processor throws an unhandled exception, mark the Job FAILED so it
    // doesn't stay stuck in RUNNING forever. The boot-time reconciliation
    // catches this too, but the per-call cleanup keeps the dashboard
    // ("Procesar Ahora" button) unblocked instantly instead of waiting
    // for the next reconcile pass.
    if (claimedJobId) {
      await db.job
        .updateMany({
          where: { id: claimedJobId, status: 'RUNNING' },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorMessage: `Unhandled poll-cycle error: ${(err as Error).message ?? 'unknown'}`.slice(0, 500),
          },
        })
        .catch(() => {});
    }
  } finally {
    // Always clear — the shutdown handler relies on currentJobId being
    // null when nothing's in flight. Without this finally, a successful
    // job would leave currentJobId set and a later SIGTERM would try to
    // FAIL an already-COMPLETED row (the updateMany filter handles that
    // safely, but clearing is cleaner).
    if (currentJobId === claimedJobId) {
      currentJobId = null;
      currentJobTenantId = null;
    }
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

  // Graceful shutdown. Render's blue-green deploy gives the OLD worker
  // ~30 s of SIGTERM grace before SIGKILL. We use that window to:
  //   1. Flip isShuttingDown=true so the poll loop stops claiming new jobs.
  //   2. Atomically transition the in-flight Job (if any) RUNNING → FAILED
  //      so it can be retried by the NEW worker that's already live.
  //   3. Release the DAC processing lease for that tenant so the new
  //      worker isn't blocked for 10 min waiting for the lease to expire.
  //   4. Flush PostHog, close browser, disconnect Prisma, exit.
  //
  // Steps 2-3 each have their own try/catch so a DB hiccup during shutdown
  // can't leave the process hung — we ALWAYS reach process.exit.
  const shutdown = async (signal: string) => {
    // Idempotent — if SIGTERM and SIGINT both fire we only run cleanup once.
    if (isShuttingDown) return;
    isShuttingDown = true;

    const inFlightJobId = currentJobId;
    const inFlightTenantId = currentJobTenantId;

    logger.info(
      { signal, inFlightJobId, inFlightTenantId },
      'Shutting down worker — marking in-flight job FAILED + releasing DAC lease...',
    );

    if (inFlightJobId) {
      // updateMany with a status filter is atomic: only flips if the row
      // is STILL in RUNNING state. If the processor managed to finish and
      // mark it COMPLETED in the race window between SIGTERM and this
      // code, the conditional update is a no-op.
      try {
        await db.job.updateMany({
          where: { id: inFlightJobId, status: 'RUNNING' },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorMessage: `Worker received ${signal} during processing — auto-recovered for retry by next cron tick`,
          },
        });
        logger.info({ jobId: inFlightJobId }, 'Marked in-flight job as FAILED for retry');
      } catch (e) {
        logger.error(
          { jobId: inFlightJobId, error: (e as Error).message },
          'Failed to mark in-flight job FAILED on shutdown — boot-time reconcile will catch it',
        );
      }

      if (inFlightTenantId) {
        // Release the DAC processing lease for this tenant so the new
        // worker can claim it on the next cron tick without waiting for
        // the 10-min lease expiry.
        try {
          await db.dacProcessingLease.deleteMany({
            where: { tenantId: inFlightTenantId },
          });
          logger.info(
            { tenantId: inFlightTenantId },
            'Released DAC processing lease on shutdown',
          );
        } catch (e) {
          logger.error(
            { tenantId: inFlightTenantId, error: (e as Error).message },
            'Failed to release DAC lease on shutdown — will expire naturally in 10 min',
          );
        }
      }
    }

    // Flush PostHog buffer — events captured during the last poll cycle
    // are still in memory; without this they get dropped on Render
    // redeploy. flushWorkerAnalytics() is a no-op if PostHog wasn't
    // initialized (env vars unset).
    await flushWorkerAnalytics().catch(() => {});
    // 2026-05-15 — flush Sentry alongside PostHog. Critical for SIGTERM
    // recovery: if a job was failing right when Render killed us, the
    // captureException call in the catch block writes to a buffer that
    // gets dropped on process.exit unless we await the network flush.
    await flushSentry(2000);
    await dacBrowser.close().catch(() => {});
    await db.$disconnect().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 2026-05-15 — last-resort handlers for errors that escape every other
  // catch. Without these, an uncaught error inside a setInterval or async
  // boundary kills the process WITHOUT Sentry reporting it. With them,
  // we get a single Sentry event before the worker dies and Render's
  // KeepAlive restarts it.
  process.on('uncaughtException', async (err) => {
    logger.error({ error: err.message, stack: err.stack }, '[fatal] uncaughtException');
    captureWorkerError(err, { step: 'uncaughtException' });
    await flushSentry(2000);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ error: err.message, stack: err.stack }, '[fatal] unhandledRejection');
    captureWorkerError(err, { step: 'unhandledRejection' });
    // Don't exit on unhandled rejections — they may be transient. Sentry
    // still captures, and the process keeps running. If they pile up,
    // Render's resource alerts will surface the pattern.
  });
}

main().catch(async (err) => {
  logger.error({ error: (err as Error).message }, 'Fatal worker error');
  captureWorkerError(err as Error, { step: 'main' });
  await flushSentry(2000);
  process.exit(1);
});
