import { db } from './db';
import { trackWorker } from './analytics';

/**
 * Atomically deduct N successful labels' worth of credits from a tenant.
 *
 * Drains `referralBonusCredits` (the free pool from being a referee) FIRST,
 * then falls through to `shipmentCredits` (paid credits). This preserves the
 * paid balance for the user and matches the UX promise: "envíos gratis por
 * entrar como referido — no te tocamos la billetera hasta que se agoten".
 *
 * Audit columns (`creditsConsumed`, `labelsThisMonth`, `labelsTotal`) ALWAYS
 * increment by the full count regardless of which pool funded it — they
 * track real usage, not paid usage. The one place that needs to know the
 * split is the BillingPanel / receipts, which can read the two pools
 * directly off Tenant.
 *
 * Implemented as a transaction (read-then-update) instead of a single
 * conditional UPDATE because Prisma's update API can't express
 * `GREATEST(0, x - n)` for multi-column arithmetic. The read happens at the
 * end of a job, off the hot path — no measurable contention risk for our
 * traffic profile (1 worker per tenant, jobs serialized).
 */
export async function deductCreditsAndStamp(
  tenantId: string,
  successCount: number,
): Promise<{ bonusUsed: number; paidUsed: number }> {
  if (successCount <= 0) {
    // Defensive: still bump lastRunAt so the dashboard "Último run" stays
    // honest even on zero-success runs.
    await db.tenant.update({
      where: { id: tenantId },
      data: { lastRunAt: new Date() },
    });
    return { bonusUsed: 0, paidUsed: 0 };
  }

  const result = await db.$transaction(async (tx) => {
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      // labelsTotal is read here so we can detect "this is the tenant's
      // very first successful shipment" — used to fire #11
      // first_shipment_created exactly once per tenant lifetime. A read
      // BEFORE the increment is the canonical "first-time?" check.
      select: {
        referralBonusCredits: true,
        shipmentCredits: true,
        labelsTotal: true,
      },
    });
    // Tenant must exist if we got this far (job referenced it). If somehow
    // gone, fall through with zeros — the calling job will log the failure
    // via its own error path.
    if (!t) return { bonusUsed: 0, paidUsed: 0, wasFirstShipment: false };

    const bonusUsed = Math.min(successCount, t.referralBonusCredits);
    const paidUsed = successCount - bonusUsed;
    const wasFirstShipment = t.labelsTotal === 0;

    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        // Both decrements clamped via the read above so we never go negative.
        // shipmentCredits CAN technically go negative if a tenant runs out
        // mid-job — that's fine, the gate at job-start prevents it from
        // being scheduled and any overrun is cheap to forgive.
        referralBonusCredits: { decrement: bonusUsed },
        shipmentCredits: { decrement: paidUsed },
        creditsConsumed: { increment: successCount },
        labelsThisMonth: { increment: successCount },
        labelsTotal: { increment: successCount },
        lastRunAt: new Date(),
      },
    });

    return { bonusUsed, paidUsed, wasFirstShipment };
  });

  // Fire #11 outside the transaction so a PostHog hiccup never rolls
  // back the credit deduction. Idempotency: `wasFirstShipment` was
  // computed from `labelsTotal === 0` BEFORE the increment, so a
  // concurrent run that landed first would see labelsTotal > 0 and
  // skip — only one of them fires the event.
  if (result.wasFirstShipment) {
    trackWorker(tenantId, 'first_shipment_created', {
      // No PII — just the count for funnel context.
      shipments_in_first_run: result.bonusUsed + result.paidUsed,
    });
  }

  return { bonusUsed: result.bonusUsed, paidUsed: result.paidUsed };
}
