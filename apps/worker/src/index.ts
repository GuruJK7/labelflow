import { getConfig } from './config';
import { processOrdersJob } from './jobs/process-orders.job';
import { startScheduler } from './jobs/scheduler';
import { dacBrowser } from './dac/browser';
import { db } from './db';
import logger from './logger';
import { processAdUploadJob } from './ads/upload-job';
import { processAdMonitorJob } from './ads/monitor-job';
import { processRecoverMessage } from './recover/process-message';

const RECOVER_POLL_INTERVAL_MS = 10_000; // Check for recover jobs every 10 seconds

const POLL_INTERVAL_MS = 5_000; // Check for jobs every 5 seconds

async function pollForJobs(): Promise<void> {
  try {
    // Find PENDING jobs
    const pendingJob = await db.job.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });

    if (!pendingJob) return;

    logger.info(
      { jobId: pendingJob.id, tenantId: pendingJob.tenantId },
      'Found pending job, processing...'
    );

    // Mark as RUNNING
    await db.job.update({
      where: { id: pendingJob.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Process
    await processOrdersJob(pendingJob.tenantId, pendingJob.id);

    logger.info({ jobId: pendingJob.id }, 'Job completed');
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Error in poll cycle');
  }
}

async function pollForAdUploadJobs(): Promise<void> {
  const pendingJob = await db.adUploadJob.findFirst({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });

  if (!pendingJob) return;

  logger.info(
    { jobId: pendingJob.id, metaAdAccountId: pendingJob.metaAdAccountId },
    'Found pending ad upload job, processing...'
  );

  await db.adUploadJob.update({
    where: { id: pendingJob.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    await processAdUploadJob(pendingJob.id, pendingJob.metaAdAccountId);
  } catch (err) {
    logger.error(
      { jobId: pendingJob.id, error: (err as Error).message },
      'Unhandled error in ad upload job — marking FAILED'
    );
    await db.adUploadJob
      .update({
        where: { id: pendingJob.id },
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
  const now = new Date();

  const pendingJob = await db.recoverJob.findFirst({
    where: {
      status: 'PENDING',
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: 'asc' },
  });

  if (!pendingJob) return;

  logger.info(
    { jobId: pendingJob.id, cartId: pendingJob.cartId, messageNumber: pendingJob.messageNumber },
    '[Recover] Found pending recover job, processing...'
  );

  await db.recoverJob.update({
    where: { id: pendingJob.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    await processRecoverMessage(pendingJob.id);
  } catch (err) {
    // Ensure the job never stays stuck in RUNNING state
    logger.error(
      { jobId: pendingJob.id, error: (err as Error).message },
      '[Recover] Unhandled error in processRecoverMessage — marking job FAILED'
    );
    await db.recoverJob
      .update({
        where: { id: pendingJob.id },
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
  const pendingJob = await db.adMonitorQueue.findFirst({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });

  if (!pendingJob) return;

  logger.info(
    { jobId: pendingJob.id, metaAdAccountId: pendingJob.metaAdAccountId },
    'Found pending ad monitor job, processing...'
  );

  await db.adMonitorQueue.update({
    where: { id: pendingJob.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    await processAdMonitorJob(pendingJob.id, pendingJob.metaAdAccountId);
  } catch (err) {
    logger.error(
      { jobId: pendingJob.id, error: (err as Error).message },
      'Unhandled error in ad monitor job — marking FAILED'
    );
    await db.adMonitorQueue
      .update({
        where: { id: pendingJob.id },
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
    },
    'LabelFlow Worker starting (DB polling mode)...'
  );

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

  logger.info('LabelFlow Worker ready and polling for jobs');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker...');
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
