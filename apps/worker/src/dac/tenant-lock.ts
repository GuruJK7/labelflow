/**
 * Per-tenant DAC processing lease (Fase 3, 2026-04-21 audit).
 *
 * Serializes DAC work for a given tenant across multiple worker processes.
 * C-6 already serializes at the Job row level (FOR UPDATE SKIP LOCKED), but
 * the scheduler can still race into creating two PENDING jobs for the same
 * tenant in the same minute (its "no pending job exists" check is not
 * transactional). With two valid PENDING rows, two workers happily claim
 * one each and both try to drive DAC for the same credentials — DAC only
 * allows one active session per user, so the second login kicks the first
 * out mid-form. The result is half-submitted forms, orphan PENDING-*
 * guías, and occasionally a real duplicate shipment.
 *
 * The lease is a row in DacProcessingLease keyed on tenantId:
 *
 *   - acquire: INSERT (first writer wins) OR conditional UPDATE when the
 *     existing row is expired (previous holder crashed without releasing).
 *   - heartbeat: bump expiresAt every HEARTBEAT_MS so a live holder never
 *     looks expired.
 *   - release: DELETE WHERE holderId = mine in `finally`.
 *
 * On acquire failure, `DacLockHeldError` is thrown; the caller re-queues
 * the Job to PENDING and lets the next poll cycle re-pick it.
 */
import { Prisma } from '@prisma/client';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { db } from '../db';
import logger from '../logger';

// Lease must outlive the longest DAC flow we expect. A YELLOW-path order
// with AI resolver + captcha + Plexo + historial probe tops out around
// 90 s; a whole cycle of up to `maxOrdersPerRun` orders runs sequentially,
// so a tenant with 20 orders × 90 s = ~30 min. Pick TTL=10 min and rely on
// the heartbeat to keep it alive during long runs. If the heartbeat can't
// run (worker frozen or partitioned from DB), the lease expires and a
// different worker can take over — we'd rather trade that rare duplicate
// work risk than have the lease expire mid-cycle and let a second worker
// collide on DAC.
const LEASE_TTL_MS = 10 * 60 * 1000;

// Heartbeat cadence — has to comfortably beat the TTL. 2 min leaves 5×
// headroom before the TTL fires, so a single missed heartbeat doesn't
// release the lock.
const HEARTBEAT_MS = 2 * 60 * 1000;

// Unique per-process identifier. Combines hostname + pid + random so two
// workers on the same host (unlikely with Render's one-container-per-svc
// model, but possible on a dev machine) can't collide. Stable for the
// lifetime of the process — every acquire call uses the same holderId.
const HOLDER_ID = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;

export class DacLockHeldError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly holderId: string,
    public readonly expiresAt: Date,
  ) {
    super(
      `DAC processing lease for tenant ${tenantId} is held by ${holderId} until ${expiresAt.toISOString()}`,
    );
    this.name = 'DacLockHeldError';
  }
}

/**
 * Attempt to acquire the lease. Returns true on success.
 *
 * Two-step because Prisma doesn't expose Postgres's "ON CONFLICT DO UPDATE
 * WHERE" directly:
 *   1. Try INSERT. If no row exists yet, we win immediately.
 *   2. On P2002 (unique constraint violation), try a conditional UPDATE
 *      that only succeeds when the existing row is expired. If the UPDATE
 *      touches a row, we took over from a dead holder.
 *
 * Race note: between steps 1 and 2 another worker could insert the same
 * tenant. Step 2's `expiresAt < NOW()` predicate handles that — if the new
 * holder just inserted with a future expiresAt, our UPDATE's WHERE clause
 * won't match and count stays at 0.
 */
async function acquireLease(
  tenantId: string,
  jobId: string,
  expiresAt: Date,
): Promise<boolean> {
  try {
    await db.dacProcessingLease.create({
      data: { tenantId, holderId: HOLDER_ID, jobId, expiresAt },
    });
    return true;
  } catch (err) {
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError) ||
      err.code !== 'P2002'
    ) {
      throw err;
    }
  }

  // Row exists. Take over only if expired.
  const result = await db.dacProcessingLease.updateMany({
    where: { tenantId, expiresAt: { lt: new Date() } },
    data: {
      holderId: HOLDER_ID,
      jobId,
      acquiredAt: new Date(),
      expiresAt,
    },
  });
  return result.count > 0;
}

/**
 * Run `fn` while holding the per-tenant DAC processing lease.
 *
 * Throws `DacLockHeldError` if the lease is currently held by another
 * worker (and its TTL hasn't expired). All other errors from `fn`
 * propagate; the lease is released in `finally` regardless.
 */
export async function withTenantDacLock<T>(
  tenantId: string,
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS);
  const claimed = await acquireLease(tenantId, jobId, expiresAt);

  if (!claimed) {
    // Read who holds it for the error message — best-effort, not part of
    // the lock protocol. If the row disappears between our failed acquire
    // and this read, we just report unknown; the caller only needs to
    // know the error type to decide how to retry.
    const existing = await db.dacProcessingLease
      .findUnique({
        where: { tenantId },
        select: { holderId: true, expiresAt: true },
      })
      .catch(() => null);
    throw new DacLockHeldError(
      tenantId,
      existing?.holderId ?? 'unknown',
      existing?.expiresAt ?? new Date(),
    );
  }

  logger.info(
    { tenantId, holderId: HOLDER_ID, jobId, expiresAt },
    '[TenantLock] DAC processing lease acquired',
  );

  // Heartbeat during the run so long cycles don't expire. Fire-and-forget
  // per tick — if a single heartbeat fails (DB blip), we log and keep
  // going; the TTL tolerance is ~5 missed beats before the lock dies.
  const heartbeat = setInterval(() => {
    const nextExpiry = new Date(Date.now() + LEASE_TTL_MS);
    db.dacProcessingLease
      .updateMany({
        where: { tenantId, holderId: HOLDER_ID },
        data: { expiresAt: nextExpiry },
      })
      .then((res) => {
        if (res.count === 0) {
          // Our row is gone or no longer ours — another worker took over,
          // which only happens if our previous heartbeat streak lapsed
          // long enough for the TTL to fire. This is recoverable only by
          // the caller catching a downstream error; we log loudly so ops
          // can correlate.
          logger.error(
            { tenantId, holderId: HOLDER_ID },
            '[TenantLock] Heartbeat found no matching lease row — lock lost mid-run',
          );
        }
      })
      .catch((err) => {
        logger.warn(
          { tenantId, error: (err as Error).message },
          '[TenantLock] Heartbeat update failed (will retry next tick)',
        );
      });
  }, HEARTBEAT_MS);
  // Don't keep the process alive just for the heartbeat; the lock holder
  // is the foreground task.
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      const res = await db.dacProcessingLease.deleteMany({
        where: { tenantId, holderId: HOLDER_ID },
      });
      if (res.count === 0) {
        logger.warn(
          { tenantId, holderId: HOLDER_ID },
          '[TenantLock] Release deleted 0 rows — lease was already taken over or swept',
        );
      } else {
        logger.info(
          { tenantId, holderId: HOLDER_ID, jobId },
          '[TenantLock] DAC processing lease released',
        );
      }
    } catch (releaseErr) {
      // Release failure is non-fatal — the lease will expire via TTL. Log
      // loudly and move on so we don't mask the caller's original error
      // (if any) with a release-path exception.
      logger.error(
        { tenantId, error: (releaseErr as Error).message },
        '[TenantLock] Failed to release DAC processing lease (will expire via TTL)',
      );
    }
  }
}

/**
 * Read-only: returns the current holder ID for this process. Primarily
 * useful for tests and for log correlation from other modules.
 */
export function getLocalHolderId(): string {
  return HOLDER_ID;
}
