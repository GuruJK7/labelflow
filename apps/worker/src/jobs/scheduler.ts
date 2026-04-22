import { db } from '../db';
import logger from '../logger';
import {
  resetAllDailyQuotas,
  cleanupExpiredAddressResolutions,
} from '../dac/ai-resolver';
import { probeCaptchaBalance } from '../dac/captcha-balance';

/**
 * Converts a UTC Date to a Date-like object in a given IANA timezone.
 * Returns { minutes, hours, date, month (1-based), dayOfWeek (0=Sun) }
 */
function toTimezone(utcDate: Date, tz: string): { minutes: number; hours: number; date: number; month: number; year: number; dayOfWeek: number } {
  // Use Intl to get parts in the target timezone
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(utcDate);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';

  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    minutes: parseInt(get('minute'), 10),
    hours: parseInt(get('hour'), 10),
    date: parseInt(get('day'), 10),
    month: parseInt(get('month'), 10),
    // M-6 (2026-04-21 audit): year is returned alongside month/date so callers
    // can build a single-timezone date key. Previously the consumer mixed UTC
    // year with UY month/date — fine on most days, but on Dec 31 UTC
    // transitioning to Jan 1 UY (or vice versa at year-end) the date key
    // would skip or duplicate a day and the AI-quota reset would either fire
    // twice or not at all.
    year: parseInt(get('year'), 10),
    dayOfWeek: weekdayMap[get('weekday')] ?? 0,
  };
}

/**
 * Checks if a cron expression matches a given Date in a specific timezone.
 * Parses all 5 fields: minute, hour, day-of-month, month, day-of-week.
 */
function cronMatchesNow(cronExpr: string, now: Date, timezone?: string): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minField, hourField, domField, monthField, dowField] = parts;

  // Convert to tenant's timezone (default UTC if not specified)
  const t = timezone ? toTimezone(now, timezone) : {
    minutes: now.getUTCMinutes(),
    hours: now.getUTCHours(),
    date: now.getUTCDate(),
    month: now.getUTCMonth() + 1,
    dayOfWeek: now.getUTCDay(),
  };

  return (
    fieldMatches(minField, t.minutes, 0, 59) &&
    fieldMatches(hourField, t.hours, 0, 23) &&
    fieldMatches(domField, t.date, 1, 31) &&
    fieldMatches(monthField, t.month, 1, 12) &&
    fieldMatches(dowField, t.dayOfWeek, 0, 6)
  );
}

// Checks if a single cron field matches a value.
// Supports: star, star-slash-N, N, N-M, comma-separated
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
 * Also performs the daily AI resolver quota reset at midnight UY time.
 */
export function startScheduler(): void {
  // Track last AI quota reset date (YYYY-MM-DD in UY timezone) to prevent duplicate resets
  let lastAiQuotaResetDate: string | null = null;

  // Check every 60 seconds (no node-cron dependency to avoid regex bugs)
  setInterval(async () => {
    try {
      // ── AI Resolver daily quota reset ──
      // Fires once per day at 00:xx in America/Montevideo. Using the minute-based
      // scheduler already in place means we run the check every minute, but the
      // date guard ensures the reset fires only once per calendar day.
      const nowForReset = new Date();
      const tzNow = toTimezone(nowForReset, 'America/Montevideo');
      if (tzNow.hours === 0) {
        // M-6: every component of the key comes from tzNow so the boundary is
        // consistent — no UTC year mixed with UY month/date (the old bug that
        // would break on year-end transitions).
        const todayKey = `${tzNow.year}-${tzNow.month}-${tzNow.date}`;
        if (lastAiQuotaResetDate !== todayKey) {
          try {
            const count = await resetAllDailyQuotas();
            lastAiQuotaResetDate = todayKey;
            logger.info({ tenantsReset: count, date: todayKey }, 'Daily AI quota reset completed');
          } catch (resetErr) {
            logger.error({ error: (resetErr as Error).message }, 'Failed to reset AI quotas');
          }

          // H-2 (2026-04-21 audit): piggy-back on the once-per-day guard to
          // sweep expired AddressResolution rows. Runs after the quota reset
          // so that a failure here doesn't skip the (more important) reset.
          try {
            const deleted = await cleanupExpiredAddressResolutions();
            if (deleted > 0) {
              logger.info(
                { deleted, date: todayKey },
                'Expired AddressResolution rows swept',
              );
            }
          } catch (sweepErr) {
            logger.error(
              { error: (sweepErr as Error).message },
              'Failed to sweep expired AddressResolution rows',
            );
          }

          // O-2 (2026-04-21 audit): 2Captcha wallet probe. Alerting at
          // the daily boundary gives us ~24h of runway to top up before a
          // fresh-login tenant hits ERROR_ZERO_BALANCE. The probe itself
          // logs the alert (and swallows probe failures); we don't need
          // to branch on the return value here.
          try {
            await probeCaptchaBalance();
          } catch (probeErr) {
            // probeCaptchaBalance already swallows internally, but belt &
            // suspenders to make sure the scheduler tick never throws.
            logger.error(
              { error: (probeErr as Error).message },
              '2Captcha balance probe crashed unexpectedly',
            );
          }
        }
      }

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
          scheduleSlots: true,
          timezone: true,
          maxOrdersPerRun: true,
        },
      });

      const now = new Date();

      for (const tenant of tenants) {
        if (!tenant.cronSchedule || tenant.cronSchedule.trim().split(/\s+/).length < 5) continue;

        const tz = tenant.timezone ?? 'America/Montevideo';

        // Check ALL 5 cron fields against current time in tenant's timezone
        if (!cronMatchesNow(tenant.cronSchedule, now, tz)) continue;

        // Check no running/pending job
        const existingJob = await db.job.findFirst({
          where: { tenantId: tenant.id, status: { in: ['PENDING', 'RUNNING'] } },
        });

        if (existingJob) {
          logger.debug({ tenantId: tenant.id }, 'Job already running/pending, skipping cron');
          continue;
        }

        // Determine maxOrders from matched schedule slot
        let slotMaxOrders = 0; // 0 = use tenant default
        const slots = tenant.scheduleSlots as { time: string; maxOrders: number }[] | null;
        if (slots && slots.length > 0) {
          const t = toTimezone(now, tz);
          const nowTime = `${String(t.hours).padStart(2, '0')}:${String(t.minutes).padStart(2, '0')}`;
          const matched = slots.find(s => s.time === nowTime);
          if (matched) {
            slotMaxOrders = matched.maxOrders;
          }
        }

        // Create job in DB (worker polling will pick it up)
        const dbJob = await db.job.create({
          data: { tenantId: tenant.id, trigger: 'CRON', type: 'PROCESS_ORDERS', status: 'PENDING' },
        });

        // If slot has a specific maxOrders, store it as override in RunLog meta
        if (slotMaxOrders > 0) {
          await db.runLog.create({
            data: {
              tenantId: tenant.id,
              jobId: dbJob.id,
              level: 'INFO',
              message: 'maxOrdersOverride',
              meta: { maxOrdersPerRun: slotMaxOrders } as any,
            },
          });
          logger.info({ tenantId: tenant.id, jobId: dbJob.id, slotMaxOrders }, 'Cron job created with slot maxOrders override');
        } else {
          logger.info({ tenantId: tenant.id, jobId: dbJob.id, cron: tenant.cronSchedule }, 'Cron job created');
        }
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Scheduler error');
    }
  }, 60_000); // every 60 seconds

  logger.info('Tenant cron scheduler started (checks every 60s, validates all 5 cron fields, no node-cron)');
}
