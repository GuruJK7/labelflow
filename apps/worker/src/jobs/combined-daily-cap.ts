import { db } from '../db';

/**
 * Combined per-day shipment cap shared across a GROUP of tenants.
 *
 * Business need (2026-06-09): Kinevia + Todo a Mano must not exceed a combined
 * 120 shipments per local calendar day, while the headroom is shared/reallocated
 * between them (if one store is quiet, the other can use the rest). The existing
 * scheduler only has per-slot, per-tenant caps and no notion of a shared daily
 * ceiling, so this module adds one.
 *
 * Design:
 *  - Stateless: the running total is derived by counting COMPLETED labels for
 *    the group since local-midnight today (no extra table / counter to drift).
 *  - Flag-gated by two env vars (DAC_COMBINED_DAILY_CAP + DAC_COMBINED_CAP_TENANTS).
 *    When either is unset/invalid the whole thing is OFF and decideCombinedCap()
 *    is a pure no-op, so the scheduler keeps its exact current behaviour.
 *  - Reallocating: each capped run is shrunk to the remaining headroom, so the
 *    two stores fill up to the cap in whatever order they run overnight.
 *
 * NOTE on the "0 = unlimited" sentinel: the scheduler treats slotMaxOrders === 0
 * as "process every pending order". This module NEVER returns 0 as a cap — when
 * the headroom is exhausted it returns skip=true instead, and when there is
 * headroom it returns a strictly-positive number. That keeps the unlimited
 * sentinel from ever being confused with "ship nothing".
 */

export interface CombinedCapConfig {
  cap: number; // strictly positive
  cappedTenantIds: string[]; // non-empty
  timezone: string; // IANA tz for the calendar-day boundary
}

/**
 * Parse the env config, or return null when the feature is OFF (so the caller
 * can treat null as "do nothing"). OFF when the cap is not a positive integer
 * or the tenant list is empty.
 */
export function parseCombinedCapEnv(
  capEnv: string | undefined,
  tenantsEnv: string | undefined,
  timezone: string,
): CombinedCapConfig | null {
  const cap = Number.parseInt((capEnv ?? '').trim(), 10);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const cappedTenantIds = (tenantsEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cappedTenantIds.length === 0) return null;
  return { cap, cappedTenantIds, timezone };
}

/**
 * Count COMPLETED labels for the capped group since local-midnight today. The
 * day boundary is computed by Postgres in the configured timezone so it is
 * correct regardless of the worker's own clock/zone.
 */
export async function combinedShippedToday(cfg: CombinedCapConfig): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM "Label"
    WHERE "tenantId" = ANY(${cfg.cappedTenantIds})
      AND "status"::text = 'COMPLETED'
      AND "createdAt" >= (date_trunc('day', (now() AT TIME ZONE ${cfg.timezone})) AT TIME ZONE ${cfg.timezone})
  `;
  return Number(rows[0]?.n ?? 0);
}

export interface CombinedCapDecision {
  /** The cap applies to this tenant (feature on AND tenant in the group). */
  applies: boolean;
  /** Headroom exhausted → the scheduled run should be skipped entirely. */
  skip: boolean;
  /** The capped maxOrders to use for this run (only when applies && !skip). */
  maxOrders?: number;
  shippedToday?: number;
  remaining?: number;
}

/**
 * Decide the effective maxOrders for a (possibly) capped tenant's scheduled run.
 *
 * slotMaxOrders semantics (must match the scheduler):
 *   undefined → no slot matched (would fall back to tenant.maxOrdersPerRun)
 *   0         → "unlimited" (process all pending)
 *   N > 0     → cap at N
 *
 * Returns { applies:false } (a no-op) when the feature is OFF or the tenant is
 * not in the capped group; the caller then uses slotMaxOrders unchanged.
 */
export async function decideCombinedCap(args: {
  cfg: CombinedCapConfig | null;
  tenantId: string;
  slotMaxOrders: number | undefined;
  fallbackMaxOrders: number;
}): Promise<CombinedCapDecision> {
  const { cfg, tenantId, slotMaxOrders, fallbackMaxOrders } = args;
  if (!cfg || !cfg.cappedTenantIds.includes(tenantId)) {
    return { applies: false, skip: false };
  }

  const shippedToday = await combinedShippedToday(cfg);
  const remaining = cfg.cap - shippedToday;
  if (remaining <= 0) {
    return { applies: true, skip: true, shippedToday, remaining: 0 };
  }

  // What this run WOULD process before the cap is applied.
  const base =
    slotMaxOrders === undefined
      ? fallbackMaxOrders
      : slotMaxOrders === 0
        ? remaining // "unlimited" → bounded by the remaining headroom
        : slotMaxOrders;

  // Strictly positive (remaining > 0 here) so we never emit the 0 sentinel.
  const maxOrders = Math.max(1, Math.min(base, remaining));
  return { applies: true, skip: false, maxOrders, shippedToday, remaining };
}
