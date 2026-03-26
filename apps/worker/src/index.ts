import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getConfig } from './config';
import { processOrdersJob } from './jobs/process-orders.job';
import { startScheduler } from './jobs/scheduler';
import { dacBrowser } from './dac/browser';
import logger from './logger';

const QUEUE_NAME = 'labelflow:process-orders';

async function main(): Promise<void> {
  const config = getConfig();

  logger.info({
    concurrency: config.WORKER_CONCURRENCY,
    headless: config.PLAYWRIGHT_HEADLESS,
  }, 'LabelFlow Worker starting...');

  // Redis connection
  const redisConnection = new IORedis(process.env.REDIS_URL ?? '', {
    maxRetriesPerRequest: null,
  });

  // BullMQ Worker — processes jobs from the queue
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { tenantId, jobId } = job.data as { tenantId: string; jobId: string };
      logger.info({ tenantId, jobId, bullJobId: job.id }, 'Processing job');

      await processOrdersJob(tenantId, jobId);

      logger.info({ tenantId, jobId }, 'Job completed');
    },
    {
      connection: redisConnection,
      concurrency: config.WORKER_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, 'Job failed in BullMQ');
  });

  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });

  // Start cron scheduler
  startScheduler(redisConnection);

  logger.info('LabelFlow Worker ready and listening for jobs');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker...');
    await worker.close();
    await dacBrowser.close();
    await redisConnection.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ error: (err as Error).message }, 'Fatal worker error');
  process.exit(1);
});
