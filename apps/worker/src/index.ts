import { getConfig } from './config';
import { processOrdersJob } from './jobs/process-orders.job';
import { dacBrowser } from './dac/browser';
import { db } from './db';
import logger from './logger';
import { processAdUploadJob } from './ads/upload-job';
import { processAdMonitorJob } from './ads/monitor-job';

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

  await processAdUploadJob(pendingJob.id, pendingJob.metaAdAccountId);
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

  await processAdMonitorJob(pendingJob.id, pendingJob.metaAdAccountId);
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
      await pollForJobs();
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
