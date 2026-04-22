import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma client BEFORE importing the module under test, so the
// imported `db` inside shipment.ts resolves to our mock.
const mockFindUnique = vi.fn();
const mockDelete = vi.fn();

vi.mock('../db', () => ({
  db: {
    pendingShipment: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
    // runLog.create is invoked by the StepLogger; we stub it so logging
    // doesn't crash the test. .catch(() => {}) on the caller swallows errors
    // but the call itself must return a thenable.
    runLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// The real logger is fine — tests don't assert on log output, just behavior.
import { assertNoPriorSubmit, DuplicateSubmitError } from '../dac/shipment';
import { createStepLogger } from '../logger';

const TENANT = 'tenant-abc';
const ORDER_ID = '7288284610870';

// Must be kept in sync with RESOLVED_TTL_MS in shipment.ts. If that
// constant changes, these tests need to reflect the new boundary.
const RESOLVED_TTL_MS = 72 * 60 * 60 * 1000;

function makeSlog() {
  return createStepLogger('test-job', TENANT);
}

describe('assertNoPriorSubmit — 2026-04-22 HOTFIX: RESOLVED rows block recent reprocess', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockDelete.mockReset();
  });

  it('returns cleanly when no PendingShipment row exists (fresh order)', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).resolves.toBeUndefined();

    expect(mockFindUnique).toHaveBeenCalledOnce();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  // ── 2026-04-22 HOTFIX: the double-shipping incident ────────────────────
  // Prior design auto-deleted RESOLVED rows. In prod, Shopify fulfillment
  // fails silently → order stays unfulfilled → every cron tick re-picks
  // it → every tick minted a new DAC guía. These tests lock in the new
  // block-then-allow-after-TTL behavior.

  it('REJECTS reprocess when RESOLVED row is recent (<72h) — throws DuplicateSubmitError', async () => {
    // 5 minutes ago — very recent, definitely within the failure window.
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).rejects.toBeInstanceOf(DuplicateSubmitError);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('REJECTS reprocess at the boundary (just under 72h)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date(Date.now() - (RESOLVED_TTL_MS - 1000)),
    });

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).rejects.toBeInstanceOf(DuplicateSubmitError);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('DuplicateSubmitError carries the prior guía for audit on recent-RESOLVED blocks', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date(Date.now() - 60 * 1000),
    });

    await assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()).catch((err) => {
      expect(err).toBeInstanceOf(DuplicateSubmitError);
      expect((err as DuplicateSubmitError).existingStatus).toBe('RESOLVED');
      expect((err as DuplicateSubmitError).existingGuia).toBe('8821122926412');
    });
  });

  it('ALLOWS reprocess when RESOLVED row is stale (>72h) — deletes and returns', async () => {
    // 72h + 1 minute ago — past the TTL, safe escape hatch for legitimate
    // operator redos long after any Shopify-fulfill-failure window.
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date(Date.now() - (RESOLVED_TTL_MS + 60 * 1000)),
    });
    mockDelete.mockResolvedValue({});

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).resolves.toBeUndefined();

    expect(mockDelete).toHaveBeenCalledOnce();
    expect(mockDelete).toHaveBeenCalledWith({
      where: {
        tenantId_shopifyOrderId: { tenantId: TENANT, shopifyOrderId: ORDER_ID },
      },
    });
  });

  it('does NOT throw if the stale RESOLVED row vanished concurrently (P2025)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date(Date.now() - (RESOLVED_TTL_MS + 60 * 1000)),
    });
    const prismaError = Object.assign(new Error('Record to delete not found'), {
      code: 'P2025',
      clientVersion: '5.x',
    });
    const { Prisma } = await import('@prisma/client');
    Object.setPrototypeOf(prismaError, Prisma.PrismaClientKnownRequestError.prototype);
    mockDelete.mockRejectedValue(prismaError);

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-P2025 errors from delete on the stale-RESOLVED path', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date(Date.now() - (RESOLVED_TTL_MS + 60 * 1000)),
    });
    mockDelete.mockRejectedValue(new Error('connection lost'));

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).rejects.toThrow('connection lost');
  });

  // ── PENDING / ORPHANED still always block (pre-existing contract) ──────

  it('throws DuplicateSubmitError when prior row is PENDING (still blocks — needs reconciliation)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'PENDING',
      resolvedGuia: null,
      submitAttemptedAt: new Date('2026-04-22T08:00:00Z'),
    });

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).rejects.toBeInstanceOf(DuplicateSubmitError);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('throws DuplicateSubmitError when prior row is ORPHANED (still blocks — needs reconciliation)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'ORPHANED',
      resolvedGuia: null,
      submitAttemptedAt: new Date('2026-04-22T07:00:00Z'),
    });

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).rejects.toBeInstanceOf(DuplicateSubmitError);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('DuplicateSubmitError carries the prior status and guía for audit (ORPHANED)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'ORPHANED',
      resolvedGuia: '8821999999999',
      submitAttemptedAt: new Date('2026-04-22T07:00:00Z'),
    });

    await assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()).catch((err) => {
      expect(err).toBeInstanceOf(DuplicateSubmitError);
      expect((err as DuplicateSubmitError).existingStatus).toBe('ORPHANED');
      expect((err as DuplicateSubmitError).existingGuia).toBe('8821999999999');
    });
  });
});
