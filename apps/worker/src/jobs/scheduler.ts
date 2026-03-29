import { db } from '../db';
import logger from '../logger';

/**
 * Checks if a cron expression matches a given Date.
 * Parses all 5 fields: minute, hour, day-of-month, month, day-of-week.
 */
function cronMatchesNow(cronExpr: string, now: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minField, hourField, domField, monthField, dowField] = parts;

  return (
    fieldMatches(minField, now.getMinutes(), 0, 59) &&
    fieldMatches(hourField, now.getHours(), 0, 23) &&
    fieldMatches(domField, now.getDate(), 1, 31) &&
    fieldMatches(monthField, now.getMonth() + 1, 1, 12) &&
    fieldMatches(dowField, now.getDay(), 0, 6)
  );
}

/**
 * Checks if a single cron field matches a value.
 * Supports: *, */N, N, N-M, N,M,O
 */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  // Handle comma-separated values: "1,3,5"
  if (field.includes(',')) {
    return field.split(',').some(part => fieldMatches(part.trim(), value, min, max));
  }

  // Handle step: "*/15" or "1-5/2"
  if (field.includes('/')) {
    const [rangeStr, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    let rangeStart = min;
    let rangeEnd = max;

    if (rangeStr !== '*') {
      if (rangeStr.includes('-')) {
        const [s, e] = rangeStr.split('-').map(Number);
        rangeStart = s;
        rangeEnd = e;
      } else {
        rangeStart = parseInt(rangeStr, 10);
      }
    }

    if (value < rangeStart || value > rangeEnd) return false;
    return (value - rangeStart) % step === 0;
  }

  // Handle range: "1-5"
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }

  // Handle exact number: "30"
  return parseInt(field, 10) === value;
}

/**
 * Runs every minute. For each active tenant, checks if their cronSchedule
 * matches the current time (all 5 fields), and if so, creates a PENDING job.
 */
export function startScheduler(): void {
  // Check every 60 seconds (no node-cron dependency to avoid regex bugs)
  setInterval(async () => {
    try {
      const tenants = await db.tenant.findMany({
        where: {
          isActive: true,
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

      const now = new Date();

      for (const tenant of tenants) {
        if (!tenant.cronSchedule || tenant.cronSchedule.trim().split(/\s+/).length < 5) continue;

        // Check ALL 5 cron fields against current time
        if (!cronMatchesNow(tenant.cronSchedule, now)) continue;

        // Check no running/pending job
        const existingJob = await db.job.findFirst({
          where: { tenantId: tenant.id, status: { in: ['PENDING', 'RUNNING'] } },
        });

        if (existingJob) {
          logger.debug({ tenantId: tenant.id }, 'Job already running/pending, skipping cron');
          continue;
        }

        // Create job in DB (worker polling will pick it up)
        const dbJob = await db.job.create({
          data: { tenantId: tenant.id, trigger: 'CRON', type: 'PROCESS_ORDERS', status: 'PENDING' },
        });

        logger.info({ tenantId: tenant.id, jobId: dbJob.id, cron: tenant.cronSchedule }, 'Cron job created');
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Scheduler error');
    }
  }, 60_000); // every 60 seconds

  logger.info('Tenant cron scheduler started (checks every 60s, validates all 5 cron fields, no node-cron)');
}
