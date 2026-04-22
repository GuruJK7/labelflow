/**
 * O-1 (2026-04-21 audit): per-day GREEN/YELLOW/RED counters from the
 * order classifier.
 *
 * Before this file existed, "what fraction of orders are we auto-shipping
 * vs. parking for human review?" could only be reconstructed by scanning
 * RunLog for a specific message substring. That grew linearly with log
 * volume and broke any time the message format drifted. This helper
 * upserts one row per (tenantId, UY-local day) and atomically increments
 * the three counters. A day-grained dashboard query is now a single
 * SELECT with no substring math.
 *
 * Called from the bulk job (the only place that runs the classifier
 * today). Safe to call from other paths — the upsert is idempotent on
 * the unique key.
 */
import { db } from '../db';
import logger from '../logger';
import { localYmd } from '../utils';

/**
 * Increment today's counters for a tenant. `green`/`yellow`/`red` are the
 * NUMBER OF ORDERS classified into each zone in this batch — each call
 * ADDS to the existing row for today (or creates the row if first call
 * of the day).
 *
 * The tenant timezone could be read from Tenant.timezone for strict
 * correctness; we hard-code America/Montevideo here because every tenant
 * in production is UY-based and passing timezone would require a second
 * DB round-trip from the caller. Revisit when we ship to a non-UY
 * tenant.
 */
export async function recordClassifierMetric(
  tenantId: string,
  counts: { green: number; yellow: number; red: number },
): Promise<void> {
  const dayYmd = localYmd();
  try {
    await db.classifierMetric.upsert({
      where: { tenantId_dayYmd: { tenantId, dayYmd } },
      create: {
        tenantId,
        dayYmd,
        green: counts.green,
        yellow: counts.yellow,
        red: counts.red,
      },
      update: {
        green: { increment: counts.green },
        yellow: { increment: counts.yellow },
        red: { increment: counts.red },
      },
    });
  } catch (err) {
    // Telemetry failure must never fail the bulk job. Log and swallow.
    logger.warn(
      { tenantId, dayYmd, error: (err as Error).message },
      '[ClassifierMetric] Failed to record counters (non-fatal)',
    );
  }
}
