/**
 * Tests for the orphan-PendingShipment auto-reconcile (2026-05-12).
 *
 * Production trigger: tenant cmn86ab6i0003do10kx8s8cwh had 10 orders sitting
 * in ORPHANED state for hours (oldest 46.8h) because the in-line rescue
 * inside shipment.ts didn't find them in historial during the original
 * silent-reject path (timing/pagination missed the row), and after that the
 * C-4 filter blocks re-submission forever. These tests pin down the exact
 * three outcomes — recovered / reset-for-retry / skipped — so the function
 * can never regress into the kind of false positive that caused the
 * Noelia Osorio poisoning incident.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────
//
// We mock both ../db (Prisma) and the findRecentGuiaForRecipient export
// from ../dac/shipment so the test stays a pure unit. The historial scan
// requires Playwright + a real DAC session; mocking lets us simulate every
// outcome (found / not found / threw) deterministically.

const mockOrphansFindMany = vi.fn();
const mockLabelsFindMany = vi.fn();
const mockLabelUpdate = vi.fn();
const mockPendingShipmentUpdate = vi.fn();
const mockPendingShipmentDelete = vi.fn();
const mockTransaction = vi.fn();
const mockRunLogCreate = vi.fn().mockResolvedValue({});

vi.mock('../db', () => ({
  db: {
    pendingShipment: {
      findMany: (...a: unknown[]) => mockOrphansFindMany(...a),
      update: (...a: unknown[]) => mockPendingShipmentUpdate(...a),
      delete: (...a: unknown[]) => mockPendingShipmentDelete(...a),
    },
    label: {
      findMany: (...a: unknown[]) => mockLabelsFindMany(...a),
      update: (...a: unknown[]) => mockLabelUpdate(...a),
    },
    runLog: {
      create: (...a: unknown[]) => mockRunLogCreate(...a),
    },
    // The transaction mock just runs each thunk in order, returning the
    // last result. Good enough for our usage which passes already-promises.
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

const mockFindRecentGuia = vi.fn();
vi.mock('../dac/shipment', () => ({
  findRecentGuiaForRecipient: (...a: unknown[]) => mockFindRecentGuia(...a),
}));

import { reconcileOrphansForTenant } from '../dac/orphan-reconcile';
import { createStepLogger } from '../logger';

const TENANT = 'tenant-xyz';

function makeSlog() {
  return createStepLogger('test-job', TENANT);
}

function fakePage() {
  // The Page is opaque to this module — it just gets forwarded to
  // findRecentGuiaForRecipient (which we mocked). Any object is fine.
  return {} as Parameters<typeof reconcileOrphansForTenant>[0];
}

beforeEach(() => {
  mockOrphansFindMany.mockReset();
  mockLabelsFindMany.mockReset();
  mockLabelUpdate.mockReset();
  mockPendingShipmentUpdate.mockReset();
  mockPendingShipmentDelete.mockReset();
  mockTransaction.mockReset();
  mockFindRecentGuia.mockReset();

  // Default: transaction just resolves with an array of resolved promises.
  // Most callers pass already-promises (db operations return promises), so
  // the test mock just awaits + returns them as-is.
  mockTransaction.mockImplementation(async (ops: Promise<unknown>[]) => {
    return Promise.all(ops);
  });
});

describe('reconcileOrphansForTenant — empty backlog', () => {
  it('returns a zero summary when no orphans exist', async () => {
    mockOrphansFindMany.mockResolvedValue([]);

    const result = await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(result.total).toBe(0);
    expect(result.recovered).toBe(0);
    expect(result.resetForRetry).toBe(0);
    expect(mockFindRecentGuia).not.toHaveBeenCalled();
  });
});

describe('reconcileOrphansForTenant — recovered case', () => {
  it('updates Label.dacGuia + flips PendingShipment to RESOLVED when historial returns a match', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps1', tenantId: TENANT, shopifyOrderId: 'shop-1', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockImplementation(async (args: any) => {
      // First call: orphan-label join. Second call: existing guias for exclude list.
      if (args.where.shopifyOrderId) {
        return [
          {
            id: 'lbl1',
            shopifyOrderId: 'shop-1',
            shopifyOrderName: '#12050',
            customerName: 'Maria Garcia',
            city: 'Montevideo',
            department: 'Montevideo',
          },
        ];
      }
      // exclude list: no guías currently linked
      return [];
    });
    mockFindRecentGuia.mockResolvedValue({
      guia: '8821111111111',
      trackingUrl: 'https://www.dac.com.uy/envios/rastreo/Codigo_Rastreo/8821111111111',
    });

    const result = await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(result.recovered).toBe(1);
    expect(result.resetForRetry).toBe(0);
    expect(result.details[0]).toEqual({
      orderName: '#12050',
      outcome: { kind: 'recovered', guia: '8821111111111' },
    });
    // The transaction was called once with both updates inside it.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not adopt the same guía twice within a single pass', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps1', tenantId: TENANT, shopifyOrderId: 'shop-1', submitAttemptedAt: new Date() },
      { id: 'ps2', tenantId: TENANT, shopifyOrderId: 'shop-2', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockImplementation(async (args: any) => {
      if (args.where.shopifyOrderId) {
        return [
          {
            id: 'lbl1', shopifyOrderId: 'shop-1', shopifyOrderName: '#A',
            customerName: 'Pedro Lopez', city: 'Salto', department: 'Salto',
          },
          {
            id: 'lbl2', shopifyOrderId: 'shop-2', shopifyOrderName: '#B',
            customerName: 'Pedro Lopez', city: 'Salto', department: 'Salto',
          },
        ];
      }
      return [];
    });
    // The historial scan returns the same guía for both orders (would-be
    // bug). The orphan-reconcile must add the first one to excludeGuias
    // so the second call passes a list that includes it.
    mockFindRecentGuia.mockResolvedValue({ guia: 'SAME-GUIA-FOR-BOTH' });

    await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(mockFindRecentGuia).toHaveBeenCalledTimes(2);
    // Second call's excludeGuias must contain the first recovery's guía.
    const secondCall = mockFindRecentGuia.mock.calls[1];
    const excludeArg = secondCall[2] as string[];
    expect(excludeArg).toContain('SAME-GUIA-FOR-BOTH');
  });
});

describe('reconcileOrphansForTenant — reset-for-retry case', () => {
  it('deletes PendingShipment + resets Label to PENDING when historial scan returns null', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps9', tenantId: TENANT, shopifyOrderId: 'shop-9', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockImplementation(async (args: any) => {
      if (args.where.shopifyOrderId) {
        return [
          {
            id: 'lbl9', shopifyOrderId: 'shop-9', shopifyOrderName: '#11928',
            customerName: 'Ana Fernandez', city: 'Maldonado', department: 'Maldonado',
          },
        ];
      }
      return [];
    });
    mockFindRecentGuia.mockResolvedValue(null);

    const result = await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(result.recovered).toBe(0);
    expect(result.resetForRetry).toBe(1);
    expect(result.details[0]).toEqual({
      orderName: '#11928',
      outcome: { kind: 'reset-for-retry' },
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileOrphansForTenant — skip / safety cases', () => {
  it('skips orphan with no matching Label row, deletes the dangling PendingShipment', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps0', tenantId: TENANT, shopifyOrderId: 'shop-orphan', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockResolvedValue([]); // no Label exists
    mockPendingShipmentDelete.mockResolvedValue({});

    const result = await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(result.skipped).toBe(1);
    expect(result.recovered).toBe(0);
    expect(mockFindRecentGuia).not.toHaveBeenCalled();
    expect(mockPendingShipmentDelete).toHaveBeenCalledWith({ where: { id: 'ps0' } });
  });

  it('skips orphan with recipient name shorter than 3 chars (poisoning defense)', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps5', tenantId: TENANT, shopifyOrderId: 'shop-5', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockImplementation(async (args: any) => {
      if (args.where.shopifyOrderId) {
        return [
          {
            id: 'lbl5', shopifyOrderId: 'shop-5', shopifyOrderName: '#12001',
            customerName: 'P',     // single-letter (Esmeralda P case)
            city: 'Montevideo', department: 'Montevideo',
          },
        ];
      }
      return [];
    });

    const result = await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(result.skipped).toBe(1);
    expect(result.details[0].outcome).toMatchObject({ kind: 'skipped' });
    expect(mockFindRecentGuia).not.toHaveBeenCalled();
  });

  it('does not crash when historial scan throws — leaves orphan untouched', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps7', tenantId: TENANT, shopifyOrderId: 'shop-7', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockImplementation(async (args: any) => {
      if (args.where.shopifyOrderId) {
        return [
          {
            id: 'lbl7', shopifyOrderId: 'shop-7', shopifyOrderName: '#X',
            customerName: 'Juan Perez', city: 'Salto', department: 'Salto',
          },
        ];
      }
      return [];
    });
    mockFindRecentGuia.mockRejectedValue(new Error('historial navigation failed'));

    const result = await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    expect(result.errored).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.resetForRetry).toBe(0);
    // No DB mutation should have happened for this orphan.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPendingShipmentDelete).not.toHaveBeenCalled();
  });
});

describe('reconcileOrphansForTenant — excludes already-linked guías', () => {
  it('passes the tenant`s existing real guías to findRecentGuiaForRecipient as excludeGuias', async () => {
    mockOrphansFindMany.mockResolvedValue([
      { id: 'ps1', tenantId: TENANT, shopifyOrderId: 'shop-1', submitAttemptedAt: new Date() },
    ]);
    mockLabelsFindMany.mockImplementation(async (args: any) => {
      if (args.where.shopifyOrderId) {
        return [
          {
            id: 'lbl1', shopifyOrderId: 'shop-1', shopifyOrderName: '#X',
            customerName: 'Sofia Mendez', city: 'Canelones', department: 'Canelones',
          },
        ];
      }
      // exclude-list call: tenant already has these real guías linked elsewhere
      return [
        { dacGuia: '8000000000001' },
        { dacGuia: '8000000000002' },
        { dacGuia: 'PENDING-foo' },  // placeholder — must NOT be excluded
        { dacGuia: 'TEST-abc' },     // test guía — must NOT be excluded
      ];
    });
    mockFindRecentGuia.mockResolvedValue(null);

    await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    const passedExclude = mockFindRecentGuia.mock.calls[0][2] as string[];
    expect(passedExclude).toContain('8000000000001');
    expect(passedExclude).toContain('8000000000002');
    expect(passedExclude).not.toContain('PENDING-foo');
    expect(passedExclude).not.toContain('TEST-abc');
  });
});

describe('reconcileOrphansForTenant — options', () => {
  it('respects maxOrphans cap', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `ps${i}`, tenantId: TENANT,
      shopifyOrderId: `shop-${i}`, submitAttemptedAt: new Date(),
    }));
    mockOrphansFindMany.mockResolvedValue(many.slice(0, 3)); // simulate `take: 3`
    mockLabelsFindMany.mockResolvedValue([]);

    await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog(), {
      maxOrphans: 3,
    });

    // The findMany was called with `take: 3`.
    const call = mockOrphansFindMany.mock.calls[0][0] as { take: number };
    expect(call.take).toBe(3);
  });

  it('uses default 30-min minAgeMs threshold when not overridden', async () => {
    mockOrphansFindMany.mockResolvedValue([]);
    mockLabelsFindMany.mockResolvedValue([]);
    const before = Date.now();
    await reconcileOrphansForTenant(fakePage(), TENANT, makeSlog());

    const call = mockOrphansFindMany.mock.calls[0][0] as {
      where: { submitAttemptedAt: { lt: Date } };
    };
    const cutoff = call.where.submitAttemptedAt.lt.getTime();
    // Cutoff is "now - 30min" — assert it falls in the 30-min window.
    const elapsedFromBefore = before - cutoff;
    expect(elapsedFromBefore).toBeGreaterThan(29 * 60 * 1000);
    expect(elapsedFromBefore).toBeLessThan(31 * 60 * 1000);
  });
});
