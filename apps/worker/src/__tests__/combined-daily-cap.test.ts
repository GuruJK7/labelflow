/**
 * Tests for the combined per-day shipment cap (Kinevia + Todo a Mano share a
 * 120/day ceiling). The DB count is mocked so no real DB is touched.
 *
 * Critical invariants under test:
 *   - OFF by default → pure no-op (the scheduler keeps its exact behaviour).
 *   - Reallocating: a capped run is shrunk to the REMAINING shared headroom.
 *   - The run is SKIPPED once the group hits the cap (never returns maxOrders=0,
 *     because 0 means "unlimited" downstream).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { $queryRaw: vi.fn() } }));

import {
  parseCombinedCapEnv,
  decideCombinedCap,
  combinedShippedToday,
} from '../jobs/combined-daily-cap';
import { db } from '../db';

const TZ = 'America/Montevideo';
const KIN = 'cmpvjrj8j000112ak1fp6fm09';
const TAM = 'cmpxa32fh0001cmbwt8yabi79';

function mockShipped(n: number) {
  (db.$queryRaw as any).mockResolvedValue([{ n }]);
}

beforeEach(() => vi.clearAllMocks());

describe('parseCombinedCapEnv — gate', () => {
  it('OFF when the cap env is missing', () => {
    expect(parseCombinedCapEnv(undefined, `${KIN},${TAM}`, TZ)).toBeNull();
  });
  it('OFF when the cap is 0, negative, or not a number', () => {
    expect(parseCombinedCapEnv('0', KIN, TZ)).toBeNull();
    expect(parseCombinedCapEnv('-5', KIN, TZ)).toBeNull();
    expect(parseCombinedCapEnv('abc', KIN, TZ)).toBeNull();
  });
  it('OFF when the tenant list is empty / only separators', () => {
    expect(parseCombinedCapEnv('120', '', TZ)).toBeNull();
    expect(parseCombinedCapEnv('120', ' , ', TZ)).toBeNull();
  });
  it('ON when both are valid (trims + splits the list)', () => {
    expect(parseCombinedCapEnv('120', ` ${KIN} , ${TAM} `, TZ)).toEqual({
      cap: 120,
      cappedTenantIds: [KIN, TAM],
      timezone: TZ,
    });
  });
});

describe('decideCombinedCap — no-op cases (never reads the DB)', () => {
  it('applies=false when the feature is OFF (cfg null)', async () => {
    const d = await decideCombinedCap({ cfg: null, tenantId: KIN, slotMaxOrders: 0, fallbackMaxOrders: 20 });
    expect(d).toEqual({ applies: false, skip: false });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('applies=false when the tenant is not in the capped group', async () => {
    const cfg = parseCombinedCapEnv('120', `${KIN},${TAM}`, TZ)!;
    const d = await decideCombinedCap({ cfg, tenantId: 'curva-store', slotMaxOrders: 0, fallbackMaxOrders: 20 });
    expect(d.applies).toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('decideCombinedCap — capping math', () => {
  const cfg = () => parseCombinedCapEnv('120', `${KIN},${TAM}`, TZ)!;

  it('SKIPS the run when the group already hit the cap', async () => {
    mockShipped(120);
    const d = await decideCombinedCap({ cfg: cfg(), tenantId: TAM, slotMaxOrders: 0, fallbackMaxOrders: 20 });
    expect(d).toMatchObject({ applies: true, skip: true, remaining: 0 });
    expect(d.maxOrders).toBeUndefined();
  });

  it('SKIPS defensively when somehow over the cap', async () => {
    mockShipped(130);
    const d = await decideCombinedCap({ cfg: cfg(), tenantId: TAM, slotMaxOrders: 0, fallbackMaxOrders: 20 });
    expect(d.skip).toBe(true);
  });

  it('slot=0 (unlimited) → caps to the REMAINING shared headroom', async () => {
    mockShipped(47); // Kinevia already did 47 → 73 left for the pair
    const d = await decideCombinedCap({ cfg: cfg(), tenantId: TAM, slotMaxOrders: 0, fallbackMaxOrders: 20 });
    expect(d).toMatchObject({ applies: true, skip: false, maxOrders: 73, remaining: 73 });
  });

  it('slot=N → caps to min(N, remaining)', async () => {
    mockShipped(100); // 20 left
    const a = await decideCombinedCap({ cfg: cfg(), tenantId: KIN, slotMaxOrders: 50, fallbackMaxOrders: 20 });
    expect(a.maxOrders).toBe(20); // min(50, 20)

    mockShipped(50); // 70 left
    const b = await decideCombinedCap({ cfg: cfg(), tenantId: KIN, slotMaxOrders: 30, fallbackMaxOrders: 20 });
    expect(b.maxOrders).toBe(30); // min(30, 70)
  });

  it('slot=undefined → caps to min(fallback, remaining)', async () => {
    mockShipped(115); // 5 left
    const d = await decideCombinedCap({ cfg: cfg(), tenantId: KIN, slotMaxOrders: undefined, fallbackMaxOrders: 20 });
    expect(d.maxOrders).toBe(5);
  });

  it('NEVER returns 0 at the exact boundary (remaining=1 → maxOrders=1)', async () => {
    mockShipped(119);
    const d = await decideCombinedCap({ cfg: cfg(), tenantId: TAM, slotMaxOrders: 0, fallbackMaxOrders: 20 });
    expect(d.skip).toBe(false);
    expect(d.maxOrders).toBe(1);
  });
});

describe('combinedShippedToday', () => {
  it('returns the count from the query', async () => {
    mockShipped(42);
    expect(await combinedShippedToday(parseCombinedCapEnv('120', `${KIN},${TAM}`, TZ)!)).toBe(42);
  });
  it('defaults to 0 when the query returns no rows', async () => {
    (db.$queryRaw as any).mockResolvedValue([]);
    expect(await combinedShippedToday(parseCombinedCapEnv('120', `${KIN},${TAM}`, TZ)!)).toBe(0);
  });
});
