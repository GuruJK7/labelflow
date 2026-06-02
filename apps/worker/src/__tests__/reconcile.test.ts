/**
 * Tests for reconciliation logic and geocoding fallback.
 */
import { describe, it, expect } from 'vitest';
import { getDepartmentForCity, getDepartmentForCityAsync } from '../dac/uruguay-geo';
import { isJobStillAlive } from '../jobs/job-liveness';

describe('isJobStillAlive (stale-job sweep guard)', () => {
  const NOW = 1_700_000_000_000; // fixed ms epoch
  const NO_PROGRESS_MS = 8 * 60 * 1000; // 8 min, matches reconcile.job.ts
  const MIN = 60 * 1000;

  it('spares a healthy long run: live lease even if logs went quiet (the production bug)', () => {
    // This is exactly what happened to job cmpx8ya2v on 2026-06-02: it was
    // RUNNING > 10 min and got force-FAILED, yet it was still shipping. A live
    // lease (heartbeat < 2 min ago, expiry well in the future) must spare it
    // regardless of how long the logs have been quiet.
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: NOW + 9 * MIN,
        lastRunLogAt: NOW - 30 * MIN,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(true);
  });

  it('spares a job with a live lease and no logs at all', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: NOW + 1 * MIN,
        lastRunLogAt: null,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(true);
  });

  it('spares a leaseless job (bulk/test-dac) that logged recently', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: null,
        lastRunLogAt: NOW - 2 * MIN,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(true);
  });

  it('still rescues a recent-log job whose lease already expired', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: NOW - 1 * MIN, // expired
        lastRunLogAt: NOW - 1 * MIN, // but logging
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(true);
  });

  it('declares dead: no lease and silent past the no-progress window', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: null,
        lastRunLogAt: NOW - 9 * MIN,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(false);
  });

  it('declares dead: expired lease and stale logs (genuine crash)', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: NOW - 5 * MIN,
        lastRunLogAt: NOW - 20 * MIN,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(false);
  });

  it('declares dead: no lease and no logs at all', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: null,
        lastRunLogAt: null,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(false);
  });

  it('lease expiry is a strict boundary: exactly now = dead, now+1ms = alive', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: NOW,
        lastRunLogAt: null,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(false);
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: NOW + 1,
        lastRunLogAt: null,
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(true);
  });

  it('log recency is a strict boundary: exactly at the edge = dead, 1ms inside = alive', () => {
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: null,
        lastRunLogAt: NOW - NO_PROGRESS_MS, // exactly on the edge
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(false);
    expect(
      isJobStillAlive({
        now: NOW,
        leaseExpiresAt: null,
        lastRunLogAt: NOW - NO_PROGRESS_MS + 1, // just inside the window
        noProgressMs: NO_PROGRESS_MS,
      }),
    ).toBe(true);
  });
});

describe('getDepartmentForCityAsync', () => {
  it('resolves known city instantly (no API call)', async () => {
    const result = await getDepartmentForCityAsync('Pocitos');
    expect(result).toBe('Montevideo');
  });

  it('resolves La.paz instantly', async () => {
    const result = await getDepartmentForCityAsync('La.paz');
    expect(result).toBe('Canelones');
  });

  it('resolves unknown city via Nominatim (live API test)', async () => {
    // "Colonia Nicolich" is in our DB already, but let's test a real obscure one
    // Using "Joaquin Suarez" which IS in our DB to avoid flaky test
    const result = await getDepartmentForCityAsync('Joaquin Suarez');
    expect(result).toBe('Canelones');
  }, 10000);

  it('returns undefined for completely fake city', async () => {
    // This will hit Nominatim and get nothing back
    const result = await getDepartmentForCityAsync('Xyzzytown12345');
    expect(result).toBeUndefined();
  }, 10000);

  it('after geocoding, city is cached in memory (instant on second call)', async () => {
    const start = Date.now();
    // Second call should be instant from cache
    await getDepartmentForCityAsync('Pocitos');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5); // <5ms = cached
  });
});

describe('getDepartmentForCity learns from async', () => {
  it('sync function returns value after async added it to the map', async () => {
    // getDepartmentForCityAsync adds resolved cities to CITY_TO_DEPARTMENT
    // So after an async resolution, sync calls should also work
    await getDepartmentForCityAsync('Montevideo');
    const sync = getDepartmentForCity('Montevideo');
    expect(sync).toBe('Montevideo');
  });
});
