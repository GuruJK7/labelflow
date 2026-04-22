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

function makeSlog() {
  return createStepLogger('test-job', TENANT);
}

describe('assertNoPriorSubmit — 2026-04-22 audit: RESOLVED rows no longer block reprocess', () => {
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

  it('deletes the RESOLVED row and allows reprocess (does NOT throw)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date('2026-04-22T08:00:00Z'),
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

  it('does NOT throw if the RESOLVED row vanished concurrently (P2025)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date('2026-04-22T08:00:00Z'),
    });
    // Simulate Prisma P2025 — row was deleted by a concurrent reprocess.
    const prismaError = Object.assign(new Error('Record to delete not found'), {
      code: 'P2025',
      clientVersion: '5.x',
    });
    // Force instanceof check to pass by setting the prototype to match
    // Prisma.PrismaClientKnownRequestError (imported in shipment.ts).
    const { Prisma } = await import('@prisma/client');
    Object.setPrototypeOf(prismaError, Prisma.PrismaClientKnownRequestError.prototype);
    mockDelete.mockRejectedValue(prismaError);

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-P2025 errors from delete (don\'t swallow unknown failures)', async () => {
    mockFindUnique.mockResolvedValue({
      status: 'RESOLVED',
      resolvedGuia: '8821122926412',
      submitAttemptedAt: new Date('2026-04-22T08:00:00Z'),
    });
    mockDelete.mockRejectedValue(new Error('connection lost'));

    await expect(
      assertNoPriorSubmit(TENANT, ORDER_ID, makeSlog()),
    ).rejects.toThrow('connection lost');
  });

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

  it('DuplicateSubmitError carries the prior status and guía for audit', async () => {
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
