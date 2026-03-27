import { db } from './db';

/**
 * Enqueues a process-orders job for a tenant.
 * Creates a Job record in the database.
 * Attempts to push to Redis/BullMQ, but if Redis is unavailable,
 * the job is still created in DB (the worker polls DB as fallback).
 */
export async function enqueueProcessOrders(
  tenantId: string,
  trigger: 'CRON' | 'WEBHOOK' | 'MANUAL' | 'MCP'
): Promise<string> {
  // Create job record in DB first (always works)
  const dbJob = await db.job.create({
    data: {
      tenantId,
      trigger,
      type: 'PROCESS_ORDERS',
      status: 'PENDING',
    },
  });

  // Try to enqueue in BullMQ (best-effort)
  try {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      const IORedis = (await import('ioredis')).default;
      const { Queue } = await import('bullmq');

      const connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: () => null, // Don't retry on serverless
      });

      const queue = new Queue('labelflow:process-orders', {
        connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 200,
          attempts: 1,
        },
      });

      const bullJob = await queue.add(
        'process-orders',
        { tenantId, jobId: dbJob.id, trigger },
        { jobId: `${tenantId}-${dbJob.id}` }
      );

      await db.job.update({
        where: { id: dbJob.id },
        data: { bullJobId: bullJob.id },
      });

      // Cleanup serverless connection
      await queue.close();
      await connection.quit();
    }
  } catch (err) {
    // Redis/BullMQ failed but job is in DB — worker will pick it up via polling
    console.error('[QUEUE] BullMQ enqueue failed (job still in DB):', (err as Error).message);
  }

  return dbJob.id;
}

/**
 * Checks if there's a running job for a tenant.
 */
export async function isJobRunning(tenantId: string): Promise<boolean> {
  const runningJob = await db.job.findFirst({
    where: {
      tenantId,
      status: { in: ['PENDING', 'RUNNING'] },
    },
  });

  return runningJob !== null;
}
