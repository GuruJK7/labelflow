import cron from 'node-cron';
import { db } from '../db';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../logger';

const QUEUE_NAME = 'labelflow:process-orders';

/**
 * Runs every minute. For each active tenant, checks if their cronSchedule
 * matches the current time, and if so, enqueues a process-orders job.
 */
export function startScheduler(redisConnection: IORedis): void {
  const queue = new Queue(QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 200, attempts: 1 },
  });

  // Check every minute
  cron.schedule('* * * * *', async () => {
    try {
      const tenants = await db.tenant.findMany({
        where: {
          isActive: true,
          subscriptionStatus: 'ACTIVE',
          shopifyStoreUrl: { not: null },
          shopifyToken: { not: null },
          dacUsername: { not: null },
          dacPassword: { not: null },
        },
        select: {
          id: true,
          cronSchedule: true,
        },
      });

      for (const tenant of tenants) {
        // Check if cron matches current time
        if (!cron.validate(tenant.cronSchedule)) continue;

        // Simple cron match: check if the schedule would fire now
        const task = cron.schedule(tenant.cronSchedule, () => {}, { scheduled: false });
        // node-cron doesn't expose a "matches now" method, so we use a workaround:
        // We only check if the schedule is valid and use a hash-based approach
        const now = new Date();
        const minuteKey = `${now.getMinutes()}-${now.getHours()}-${now.getDate()}-${now.getMonth()}-${now.getDay()}`;
        const tenantHash = tenant.id.charCodeAt(0) % 60;

        // Parse cron to check if it should run now
        const [min] = tenant.cronSchedule.split(' ');
        let shouldRun = false;

        if (min === '*') {
          shouldRun = true;
        } else if (min.startsWith('*/')) {
          const interval = parseInt(min.substring(2));
          shouldRun = now.getMinutes() % interval === 0;
        } else {
          shouldRun = now.getMinutes() === parseInt(min);
        }

        if (!shouldRun) continue;

        // Check no running job
        const runningJob = await db.job.findFirst({
          where: { tenantId: tenant.id, status: { in: ['PENDING', 'RUNNING'] } },
        });

        if (runningJob) {
          logger.debug({ tenantId: tenant.id }, 'Job already running, skipping cron');
          continue;
        }

        // Enqueue
        const dbJob = await db.job.create({
          data: { tenantId: tenant.id, trigger: 'CRON', type: 'PROCESS_ORDERS', status: 'PENDING' },
        });

        await queue.add('process-orders', {
          tenantId: tenant.id,
          jobId: dbJob.id,
          trigger: 'CRON',
        }, { jobId: `${tenant.id}-${dbJob.id}` });

        logger.info({ tenantId: tenant.id, jobId: dbJob.id }, 'Cron job enqueued');
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Scheduler error');
    }
  });

  logger.info('Tenant cron scheduler started (checks every minute)');
}
