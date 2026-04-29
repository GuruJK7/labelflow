import { db } from './db';

/**
 * Web-side equivalent of `apps/worker/src/credits.ts:deductCreditsAndStamp`.
 *
 * Used by operator-initiated paths (e.g. manual PDF upload retry on a label
 * that was parked NEEDS_REVIEW because S3 upload failed during the original
 * worker run). Same drain order: referralBonusCredits FIRST, then
 * shipmentCredits — keeps the UX promise that bonus credits are spent before
 * the user's paid wallet is touched.
 *
 * Audit columns (creditsConsumed, labelsThisMonth, labelsTotal) ALWAYS
 * increment by the full count regardless of which pool funded it. Mirror of
 * the worker contract, kept in lockstep so analytics on the dashboard
 * (`/admin`, `/settings/billing`) read consistent numbers no matter which
 * code path billed the shipment.
 *
 * Why duplicate the worker helper instead of importing it: the worker is a
 * separate app with its own tsconfig/build (Docker image on Render); pulling
 * its src into the Next.js bundle would either require a workspace-wide TS
 * project reference or a package extraction. For a 30-line function whose
 * surface is one DB call, the duplication is cheaper. The unit test in
 * `apps/web/lib/__tests__/credits.test.ts` (added alongside this file) is
 * the contract that keeps the two in sync — if anyone ever changes the
 * worker version, that test surfaces the divergence.
 */
export async function deductCreditsAndStamp(
  tenantId: string,
  successCount: number,
): Promise<{ bonusUsed: number; paidUsed: number }> {
  if (successCount <= 0) {
    await db.tenant.update({
      where: { id: tenantId },
      data: { lastRunAt: new Date() },
    });
    return { bonusUsed: 0, paidUsed: 0 };
  }

  return db.$transaction(async (tx) => {
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { referralBonusCredits: true, shipmentCredits: true },
    });
    if (!t) return { bonusUsed: 0, paidUsed: 0 };

    const bonusUsed = Math.min(successCount, t.referralBonusCredits);
    const paidUsed = successCount - bonusUsed;

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

    return { bonusUsed, paidUsed };
  });
}
