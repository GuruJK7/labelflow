import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma client BEFORE importing the module under test, so the
// imported `db` inside credits.ts resolves to our mock.
//
// The function under test runs a `db.$transaction(async (tx) => {...})` block
// when successCount > 0, and a plain `db.tenant.update` when successCount = 0.
// Our mock satisfies both shapes: `$transaction` invokes the callback with a
// `tx` object that exposes the same `tenant.findUnique` / `tenant.update` we
// expose at the top level. Whatever data flows through `update` is captured
// in `lastUpdate` so each test can assert on the exact decrement payload.

let lastFindResult: {
  referralBonusCredits: number;
  shipmentCredits: number;
} | null = null;
let lastUpdate: { where: unknown; data: unknown } | null = null;
let updateCallCount = 0;

const mockTenantFindUnique = vi.fn(async () => lastFindResult);
const mockTenantUpdate = vi.fn(async (args: { where: unknown; data: unknown }) => {
  updateCallCount += 1;
  lastUpdate = args;
  return {};
});

vi.mock('../db', () => ({
  db: {
    tenant: {
      findUnique: (...args: unknown[]) => mockTenantFindUnique(...(args as [])),
      update: (...args: unknown[]) => mockTenantUpdate(...(args as [{ where: unknown; data: unknown }])),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tenant: {
          findUnique: (...args: unknown[]) => mockTenantFindUnique(...(args as [])),
          update: (...args: unknown[]) => mockTenantUpdate(...(args as [{ where: unknown; data: unknown }])),
        },
      }),
  },
}));

import { deductCreditsAndStamp } from '../credits';

const TENANT = 'tenant-abc';

beforeEach(() => {
  mockTenantFindUnique.mockClear();
  mockTenantUpdate.mockClear();
  lastFindResult = null;
  lastUpdate = null;
  updateCallCount = 0;
});

describe('deductCreditsAndStamp — billing fairness contract', () => {
  it('successCount=0 short-circuits: bumps lastRunAt only, does NOT touch credits', async () => {
    const result = await deductCreditsAndStamp(TENANT, 0);

    expect(result).toEqual({ bonusUsed: 0, paidUsed: 0 });
    expect(mockTenantFindUnique).not.toHaveBeenCalled();
    expect(updateCallCount).toBe(1);
    const data = lastUpdate?.data as Record<string, unknown>;
    // No decrement / increment — only lastRunAt.
    expect(data).toHaveProperty('lastRunAt');
    expect(data).not.toHaveProperty('shipmentCredits');
    expect(data).not.toHaveProperty('referralBonusCredits');
    expect(data).not.toHaveProperty('creditsConsumed');
    expect(data).not.toHaveProperty('labelsThisMonth');
  });

  it('successCount=0 with negative argument: still no-op (defensive)', async () => {
    const result = await deductCreditsAndStamp(TENANT, -5);

    expect(result).toEqual({ bonusUsed: 0, paidUsed: 0 });
    expect(mockTenantFindUnique).not.toHaveBeenCalled();
  });

  it('drains referralBonusCredits FIRST when bonus covers the whole batch', async () => {
    lastFindResult = { referralBonusCredits: 10, shipmentCredits: 20 };

    const result = await deductCreditsAndStamp(TENANT, 5);

    expect(result).toEqual({ bonusUsed: 5, paidUsed: 0 });
    const data = lastUpdate?.data as Record<string, { decrement?: number; increment?: number } | unknown>;
    expect(data.referralBonusCredits).toEqual({ decrement: 5 });
    expect(data.shipmentCredits).toEqual({ decrement: 0 });
    expect(data.creditsConsumed).toEqual({ increment: 5 });
    expect(data.labelsThisMonth).toEqual({ increment: 5 });
    expect(data.labelsTotal).toEqual({ increment: 5 });
  });

  it('splits across bonus and paid when batch exceeds bonus', async () => {
    lastFindResult = { referralBonusCredits: 3, shipmentCredits: 20 };

    const result = await deductCreditsAndStamp(TENANT, 8);

    expect(result).toEqual({ bonusUsed: 3, paidUsed: 5 });
    const data = lastUpdate?.data as Record<string, { decrement?: number; increment?: number } | unknown>;
    expect(data.referralBonusCredits).toEqual({ decrement: 3 });
    expect(data.shipmentCredits).toEqual({ decrement: 5 });
    expect(data.creditsConsumed).toEqual({ increment: 8 });
    expect(data.labelsThisMonth).toEqual({ increment: 8 });
    expect(data.labelsTotal).toEqual({ increment: 8 });
  });

  it('drains paid only when bonus is empty', async () => {
    lastFindResult = { referralBonusCredits: 0, shipmentCredits: 50 };

    const result = await deductCreditsAndStamp(TENANT, 7);

    expect(result).toEqual({ bonusUsed: 0, paidUsed: 7 });
    const data = lastUpdate?.data as Record<string, { decrement?: number; increment?: number } | unknown>;
    expect(data.referralBonusCredits).toEqual({ decrement: 0 });
    expect(data.shipmentCredits).toEqual({ decrement: 7 });
  });

  it('audit columns track REAL usage (full count) regardless of which pool funded it', async () => {
    lastFindResult = { referralBonusCredits: 100, shipmentCredits: 0 };

    await deductCreditsAndStamp(TENANT, 12);

    const data = lastUpdate?.data as Record<string, { increment?: number } | unknown>;
    // creditsConsumed/labelsThisMonth/labelsTotal must reflect the 12 real
    // shipments processed, not the 0 paid credits used. This is the contract
    // for analytics dashboards and admin reports.
    expect(data.creditsConsumed).toEqual({ increment: 12 });
    expect(data.labelsThisMonth).toEqual({ increment: 12 });
    expect(data.labelsTotal).toEqual({ increment: 12 });
  });

  it('tolerates underflow on paid pool — overrun does NOT throw', async () => {
    // Tenant has 0 bonus + 2 paid, but the job somehow processed 5 successes.
    // The gate at scheduler.ts:189 should prevent this in practice (it filters
    // `shipmentCredits > 0`), but if it slips through we must not crash —
    // a Prisma-side decrement would let shipmentCredits go to -3, and that's
    // intentional per the comment in credits.ts: "shipmentCredits CAN
    // technically go negative if a tenant runs out mid-job — that's fine,
    // the gate at job-start prevents it from being scheduled and any overrun
    // is cheap to forgive."
    lastFindResult = { referralBonusCredits: 0, shipmentCredits: 2 };

    const result = await deductCreditsAndStamp(TENANT, 5);

    expect(result).toEqual({ bonusUsed: 0, paidUsed: 5 });
    const data = lastUpdate?.data as Record<string, { decrement?: number; increment?: number } | unknown>;
    expect(data.shipmentCredits).toEqual({ decrement: 5 });
  });

  it('returns zeros without throwing if tenant disappeared mid-job', async () => {
    lastFindResult = null; // simulate tenant deleted between job-start and end

    const result = await deductCreditsAndStamp(TENANT, 4);

    expect(result).toEqual({ bonusUsed: 0, paidUsed: 0 });
    // findUnique was called, but no update.
    expect(mockTenantFindUnique).toHaveBeenCalledTimes(1);
    expect(mockTenantUpdate).not.toHaveBeenCalled();
  });

  it('always stamps lastRunAt, even on the credit-decrement path', async () => {
    lastFindResult = { referralBonusCredits: 0, shipmentCredits: 10 };

    await deductCreditsAndStamp(TENANT, 1);

    const data = lastUpdate?.data as Record<string, unknown>;
    expect(data.lastRunAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PENDING- guia and PDF-upload-failure scenarios are guarded INSIDE the two
// job files (process-orders.job.ts and agent-bulk-upload.job.ts) before
// successCount is incremented. The contract those guards uphold is:
//
//   - guia.startsWith('PENDING-')      → label = NEEDS_REVIEW, no successCount++
//   - pdfUploaded === false (after retries) → label = NEEDS_REVIEW, no successCount++
//   - all gates pass                   → successCount++ → flows into deductCreditsAndStamp
//
// Those guards are integration-shaped (they depend on DAC + S3 + Shopify
// branches), so the regression here is at the unit boundary: as long as
// successCount stays at 0 for any failure path, deductCreditsAndStamp behaves
// as a no-op — verified by the first two tests above. The job-level
// integration tests live in process-orders / agent-bulk-upload coverage and
// will be exercised end-to-end against a staging DAC if/when that env exists.
// ─────────────────────────────────────────────────────────────────────────
