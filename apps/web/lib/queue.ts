import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { db } from './db';

const QUEUE_NAME = 'labelflow:process-orders';

let _connection: IORedis | null = null;

function getRedisConnection(): IORedis {
  if (_connection) return _connection;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for queue');
  }

  _connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return _connection;
}

let _queue: Queue | null = null;

function getQueue(): Queue {
  if (_queue) return _queue;

  _queue = new Queue(QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 1,
    },
  });

  return _queue;
}

/**
 * Enqueues a process-orders job for a tenant.
 * Returns the BullMQ job ID.
 */
export async function enqueueProcessOrders(
  tenantId: string,
  trigger: 'CRON' | 'WEBHOOK' | 'MANUAL' | 'MCP'
): Promise<string> {
  const queue = getQueue();

  // Create job record in DB first
  const dbJob = await db.job.create({
    data: {
      tenantId,
      trigger,
      type: 'PROCESS_ORDERS',
      status: 'PENDING',
    },
  });

  // Enqueue in BullMQ
  const bullJob = await queue.add(
    'process-orders',
    { tenantId, jobId: dbJob.id, trigger },
    { jobId: `${tenantId}-${dbJob.id}` }
  );

  // Update DB with BullMQ job ID
  await db.job.update({
    where: { id: dbJob.id },
    data: { bullJobId: bullJob.id },
  });

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
