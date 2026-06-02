/**
 * Pure liveness decision for the reconcile job's stale-RUNNING sweep.
 *
 * Kept dependency-free (no Prisma, no logger) so it can be unit-tested in
 * isolation and reused without dragging the worker's DB layer into a test.
 *
 * Background (2026-06-02 audit): the sweep used to FAIL any job that had been
 * RUNNING longer than an absolute threshold (10 min). But a full
 * PROCESS_ORDERS cycle legitimately ships up to `maxOrdersPerRun` orders
 * serially through DAC's slow form (20 x ~90 s ~= 30 min), so healthy long
 * runs were mislabeled FAILED — corrupting dashboard stats and draining
 * credits early while the job was still happily shipping. The fix: only treat
 * a job as dead when it ALSO shows no sign of life.
 */

export interface JobLivenessSignals {
  /** Wall-clock "now" as a ms epoch. */
  now: number;
  /**
   * Expiry (ms epoch) of a DAC processing lease whose `jobId` matches this
   * job, or null when no lease points at it. A worker bumps this expiry via a
   * heartbeat every couple of minutes while it actively drives DAC for the
   * job, so a future value means the worker is alive and working.
   */
  leaseExpiresAt: number | null;
  /**
   * Timestamp (ms epoch) of this job's most recent RunLog, or null when it has
   * written none. Every job type that reaches RUNNING emits logs as it
   * progresses, so this is the universal "sign of life" signal.
   */
  lastRunLogAt: number | null;
  /** How long a job may go with NO new log before it's considered silent (ms). */
  noProgressMs: number;
}

/**
 * Returns true when a RUNNING job (already older than the sweep's age floor)
 * still shows a sign of life and must NOT be auto-failed. Two independent
 * signals, OR'd so a single healthy signal is enough to spare the job:
 *
 *   1. A DAC lease for this exact job is still in the future — the worker is
 *      heartbeating it (covers the PROCESS_ORDERS path, which always holds a
 *      lease for the whole run).
 *   2. A RunLog landed within `noProgressMs` — universal across every job type
 *      that reaches RUNNING (PROCESS_ORDERS, bulk, test-dac), including the
 *      ones that never take a DAC lease.
 *
 * Strict `>` comparisons: a lease expiring exactly at `now`, or a log exactly
 * at the edge of the window, counts as NOT alive — the conservative,
 * deterministic choice at the boundary.
 */
export function isJobStillAlive(signals: JobLivenessSignals): boolean {
  const { now, leaseExpiresAt, lastRunLogAt, noProgressMs } = signals;

  if (leaseExpiresAt !== null && leaseExpiresAt > now) {
    return true;
  }

  if (lastRunLogAt !== null && lastRunLogAt > now - noProgressMs) {
    return true;
  }

  return false;
}
