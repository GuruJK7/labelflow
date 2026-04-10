/**
 * Regression tests for the null-safety helper that protects Label upserts.
 *
 * These tests exist because of a real production bug where Shopify orders with
 * empty city and null province caused Prisma to throw a misleading
 * "Argument `tenant` is missing" error. The real cause was that Label.city and
 * Label.department are non-null in the schema, and the code was passing null.
 *
 * Each failed upsert left a DAC guia dangling (already charged) because the cron
 * would retry the order next tick, hit DAC again, and fail again at the DB save.
 * At 4 retries/hour × 3 orders × ~24 hours = ~288 duplicate guias/day on one
 * affected tenant. Never let this regress.
 */

import { describe, it, expect } from 'vitest';
import { buildSafeLabelGeoFields } from '../jobs/label-safe-fields';

describe('buildSafeLabelGeoFields — null safety for Label.city and Label.department', () => {
  it('happy path: all fields populated', () => {
    const result = buildSafeLabelGeoFields({
      city: 'Pocitos',
      province: 'Montevideo',
      resolvedDepartment: 'Montevideo',
    });
    expect(result.safeCity).toBe('Pocitos');
    expect(result.safeDepartment).toBe('Montevideo');
  });

  it('resolvedDepartment wins over province when both are set', () => {
    const result = buildSafeLabelGeoFields({
      city: 'Pocitos',
      province: 'Ciudad de la Costa', // wrong — Shopify often fills this incorrectly
      resolvedDepartment: 'Montevideo',
    });
    expect(result.safeDepartment).toBe('Montevideo');
  });

  it('falls back to province when resolvedDepartment is null', () => {
    const result = buildSafeLabelGeoFields({
      city: 'SomeSmallTown',
      province: 'Canelones',
      resolvedDepartment: null,
    });
    expect(result.safeDepartment).toBe('Canelones');
  });

  it('falls back to province when resolvedDepartment is undefined', () => {
    const result = buildSafeLabelGeoFields({
      city: 'SomeSmallTown',
      province: 'Canelones',
      resolvedDepartment: undefined,
    });
    expect(result.safeDepartment).toBe('Canelones');
  });

  it('CRITICAL REGRESSION: empty city + null province + null resolvedDepartment produces empty strings, never null', () => {
    // This is the exact pattern that caused the nexomediaservices bug.
    // Order #2774 William Rosadilla / "Jb de almenera esq julio vilamajo Lagomar"
    // had city="" and province=null, which made both legacy fallbacks resolve to null.
    const result = buildSafeLabelGeoFields({
      city: '',
      province: null,
      resolvedDepartment: null,
    });
    expect(result.safeCity).toBe('');
    expect(result.safeDepartment).toBe('');
    // Explicitly verify they are strings, not null — this is the non-null
    // guarantee that Prisma requires.
    expect(typeof result.safeCity).toBe('string');
    expect(typeof result.safeDepartment).toBe('string');
    expect(result.safeCity).not.toBeNull();
    expect(result.safeDepartment).not.toBeNull();
  });

  it('null city is coerced to empty string', () => {
    const result = buildSafeLabelGeoFields({
      city: null,
      province: 'Montevideo',
      resolvedDepartment: 'Montevideo',
    });
    expect(result.safeCity).toBe('');
  });

  it('undefined city is coerced to empty string', () => {
    const result = buildSafeLabelGeoFields({
      city: undefined,
      province: 'Montevideo',
      resolvedDepartment: 'Montevideo',
    });
    expect(result.safeCity).toBe('');
  });

  it('all inputs null → both outputs are empty strings (never null)', () => {
    const result = buildSafeLabelGeoFields({
      city: null,
      province: null,
      resolvedDepartment: null,
    });
    expect(result.safeCity).toBe('');
    expect(result.safeDepartment).toBe('');
  });

  it('all inputs undefined → both outputs are empty strings (never undefined)', () => {
    const result = buildSafeLabelGeoFields({
      city: undefined,
      province: undefined,
      resolvedDepartment: undefined,
    });
    expect(result.safeCity).toBe('');
    expect(result.safeDepartment).toBe('');
  });

  it('empty strings are preserved as empty strings (not coerced further)', () => {
    const result = buildSafeLabelGeoFields({
      city: '',
      province: '',
      resolvedDepartment: '',
    });
    // Note: the `??` operator only falls back on null/undefined, not empty string.
    // This is intentional — an explicit empty string is a valid value for these
    // fields and should not be replaced.
    expect(result.safeCity).toBe('');
    expect(result.safeDepartment).toBe('');
  });

  it('output type is always { safeCity: string, safeDepartment: string } — no nulls allowed', () => {
    // Exhaustive null/undefined combinations
    const inputs: Array<{ city: any; province: any; resolvedDepartment: any }> = [
      { city: null, province: null, resolvedDepartment: null },
      { city: undefined, province: undefined, resolvedDepartment: undefined },
      { city: '', province: '', resolvedDepartment: '' },
      { city: 'X', province: null, resolvedDepartment: undefined },
      { city: null, province: 'Y', resolvedDepartment: '' },
      { city: undefined, province: '', resolvedDepartment: 'Z' },
    ];
    for (const input of inputs) {
      const result = buildSafeLabelGeoFields(input);
      expect(typeof result.safeCity).toBe('string');
      expect(typeof result.safeDepartment).toBe('string');
      expect(result.safeCity).not.toBeNull();
      expect(result.safeDepartment).not.toBeNull();
      expect(result.safeCity).not.toBeUndefined();
      expect(result.safeDepartment).not.toBeUndefined();
    }
  });

  it('real-world nexomediaservices regression cases (3 orders that were looping)', () => {
    // Order #2774 — William Rosadilla — empty city, province null
    expect(
      buildSafeLabelGeoFields({
        city: '',
        province: null,
        resolvedDepartment: null,
      }).safeDepartment,
    ).toBe('');

    // Order #2739 — Carolina Segovia — empty city, province null
    expect(
      buildSafeLabelGeoFields({
        city: '',
        province: null,
        resolvedDepartment: null,
      }).safeDepartment,
    ).toBe('');

    // Order #2513 — Monica Kodera — "dac lussich" (DAC pickup code, not a city),
    // empty city, province null
    expect(
      buildSafeLabelGeoFields({
        city: '',
        province: null,
        resolvedDepartment: null,
      }).safeDepartment,
    ).toBe('');
  });
});
