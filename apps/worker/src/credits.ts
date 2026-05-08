import { db } from './db';
import { trackWorker } from './analytics';
import { getCreditHolderTenantId } from './credit-holder';

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
    // honest even on zero-success runs. Short-circuit BEFORE the holder
    // lookup so the no-op path doesn't waste DB queries.
    await db.tenant.update({
      where: { id: tenantId },
      data: { lastRunAt: new Date() },
    });
    return { bonusUsed: 0, paidUsed: 0 };
  }

  // Audit 2026-05-08 — multi-store credit pool. The wallet (paid +
  // bonus credits) lives on the user's CREDIT-HOLDER tenant (oldest
  // one), so all of the user's stores share a single balance. Per-store
  // metrics (labelsThisMonth, labelsTotal, lastRunAt) stay on the
  // ORIGINATING tenant — they're meaningful per-store ("how many labels
  // did Aura process this month?"). For single-tenant users (the common
  // case) holderId === tenantId, so we collapse the two updates into one.
  const holderId = await getCreditHolderTenantId(tenantId);

  const result = await db.$transaction(async (tx) => {
    const holder = await tx.tenant.findUnique({
      where: { id: holderId },
      // labelsTotal is read here so we can detect "this is the tenant's
      // very first successful shipment" — used to fire #11
      // first_shipment_created exactly once per tenant lifetime. Only
      // meaningful when holderId === tenantId; for non-holders we read
      // it separately below.
      select: {
        referralBonusCredits: true,
        shipmentCredits: true,
        labelsTotal: true,
      },
    });

    if (!holder) return { bonusUsed: 0, paidUsed: 0, wasFirstShipment: false };

    const bonusUsed = Math.min(successCount, holder.referralBonusCredits);
    const paidUsed = successCount - bonusUsed;

    if (holderId === tenantId) {
      // Single-tenant user (or the originating tenant IS the holder) —
      // one update covers wallet + per-store metrics. This is the
      // common case and matches the pre-multi-store behavior.
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          referralBonusCredits: { decrement: bonusUsed },
          shipmentCredits: { decrement: paidUsed },
          creditsConsumed: { increment: successCount },
          labelsThisMonth: { increment: successCount },
          labelsTotal: { increment: successCount },
          lastRunAt: new Date(),
        },
      });
      return { bonusUsed, paidUsed, wasFirstShipment: holder.labelsTotal === 0 };
    }

    // Multi-tenant non-holder path: wallet on the holder, per-store
    // metrics on the originating tenant. Two updates inside the same
    // transaction so they're atomic.
    const originating = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { labelsTotal: true },
    });

    await tx.tenant.update({
      where: { id: holderId },
      data: {
        referralBonusCredits: { decrement: bonusUsed },
        shipmentCredits: { decrement: paidUsed },
        creditsConsumed: { increment: successCount },
      },
    });

    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        labelsThisMonth: { increment: successCount },
        labelsTotal: { increment: successCount },
        lastRunAt: new Date(),
      },
    });

    return {
      bonusUsed,
      paidUsed,
      wasFirstShipment: (originating?.labelsTotal ?? 0) === 0,
    };
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
