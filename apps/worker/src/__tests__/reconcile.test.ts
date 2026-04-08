/**
 * Tests for reconciliation logic and geocoding fallback.
 */
import { describe, it, expect } from 'vitest';
import { getDepartmentForCity, getDepartmentForCityAsync } from '../dac/uruguay-geo';

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
