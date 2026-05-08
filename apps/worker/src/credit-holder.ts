import { db } from './db';

/**
 * Worker mirror of apps/web/lib/credit-holder.ts.
 *
 * Same contract: given any tenantId, return the user's "credit holder"
 * tenant — the oldest tenant of the user (ordered by createdAt asc,
 * with id as tiebreaker). All credit reads and writes route through
 * the holder so multi-store users share a single credit pool.
 *
 * Worker can't import from web (separate Docker image, different
 * tsconfig/build). Contract is kept in lockstep with the web side via
 * a unit test in __tests__/credit-holder.test.ts.
 *
 * Audit 2026-05-08 — see apps/web/lib/credit-holder.ts for the full
 * background.
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
