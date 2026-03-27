import { getConfig } from './config';
import { processOrdersJob } from './jobs/process-orders.job';
import { dacBrowser } from './dac/browser';
import { db } from './db';
import logger from './logger';

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

  // Poll loop
  const poll = async () => {
    while (true) {
      await pollForJobs();
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  poll();

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
