import { db } from './db';

/**
 * Multi-store credit pool — "credit holder" pattern.
 *
 * Audit 2026-05-08 — context.
 *
 * Credits live on `Tenant.shipmentCredits` / `Tenant.referralBonusCredits`.
 * The original 1:1 User⟷Tenant schema made this fine. After multi-store
 * landed (2026-05-01), users started owning multiple Tenants — and the
 * design intent for credits became "per-user, per-lifetime, NOT per-store"
 * (so a user can't mine free credits by creating stores). The new-tenant
 * creation path (`POST /api/v1/tenants`) already sets `shipmentCredits: 0`
 * to enforce that — but the READ and DEDUCT paths still operate on
 * whichever Tenant happens to be the request's "current" one. That meant:
 *
 *   - User opens their newly-created store → dashboard shows 0 credits
 *     even though their other stores have plenty.
 *   - Worker tries to ship from the new store → scheduler gate blocks
 *     because the Tenant's balance is 0.
 *
 * The fix: designate ONE tenant per user as the "credit holder" — the
 * oldest one (deterministic across requests). All credit reads and writes
 * route through the holder. Non-holder tenants still exist and are
 * processed normally; they just don't store the user's wallet.
 *
 * This is a behavioral fix only — no schema change, no data migration
 * required for new users. A separate one-shot script consolidates
 * existing multi-tenant users' credits onto the holder.
 *
 * For single-tenant users (the vast majority), behavior is unchanged
 * because the only tenant is also the holder.
 */

/**
 * Given any tenant id, return the credit-holder tenant id for the user
 * that owns it. The holder is the OLDEST tenant of the user (ordered by
 * createdAt asc, with id as tiebreaker for determinism).
 *
 * Returns the input tenantId itself if (a) it's already the oldest, or
 * (b) the lookup fails — defensive default keeps the caller working with
 * the best information available.
 */
export async function getCreditHolderTenantId(tenantId: string): Promise<string> {
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { userId: true },
  });
  if (!t) return tenantId;
  const holder = await db.tenant.findFirst({
    where: { userId: t.userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return holder?.id ?? tenantId;
}

/**
 * Variant for callers that already have the userId in hand (e.g. signup,
 * tenant-list endpoints). Saves one round-trip vs the tenantId variant.
 */
export async function getCreditHolderTenantIdForUser(userId: string): Promise<string | null> {
  const holder = await db.tenant.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return holder?.id ?? null;
}
