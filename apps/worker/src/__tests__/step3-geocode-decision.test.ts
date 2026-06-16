import { describe, it, expect } from 'vitest';
import {
  decideStep3Coords,
  isStep3GeoTenantEnabled,
  isCoarseGeocode,
  STREET_LEVEL_PLACE_RANK,
  isSettlementResult,
  SETTLEMENT_PLACE_RANK,
  shouldTryBarrioFallback,
} from '../dac/geocode-fallback';

/**
 * Unit tests for the DAC Step-3 "real coordinates" decision (Lever B).
 *
 * Context (2026-06-04 investigation): the worker injects the DEPARTMENT
 * CENTROID into DAC's hidden lat/lng fields. For interior addresses the
 * centroid can be 50-100 km off, and the data shows DAC then silently refuses
 * to mint the guía in ~72% of interior failures. The experiment geocodes the
 * REAL address and injects that point instead — but only behind an env gate,
 * inside Uruguay's bounding box, and only when Nominatim agrees on the
 * department (the #11865 misclassification guard). decideStep3Coords() is the
 * pure, network-free core of that policy; these tests pin every branch.
 */

const TAM = 'cmpxa32fh0001cmbwt8yabi79';

// A real, in-Uruguay point (somewhere in Canelones) used by the happy-path tests.
const CANELONES_POINT = { lat: -34.7, lon: -55.9 };

describe('isStep3GeoTenantEnabled — shared gate (single source of truth)', () => {
  it('is OFF when the env var is undefined (default)', () => {
    expect(isStep3GeoTenantEnabled(undefined, TAM)).toBe(false);
  });

  it('is OFF when the env var is empty or only separators', () => {
    expect(isStep3GeoTenantEnabled('', TAM)).toBe(false);
    expect(isStep3GeoTenantEnabled(' , , ', TAM)).toBe(false);
  });

  it('is OFF when the list contains only other tenants', () => {
    expect(isStep3GeoTenantEnabled('tenant-aaa,tenant-bbb', TAM)).toBe(false);
  });

  it('is ON for an exact single-entry match', () => {
    expect(isStep3GeoTenantEnabled(TAM, TAM)).toBe(true);
  });

  it('is ON for a tenant sitting in a spaced, multi-entry list', () => {
    expect(isStep3GeoTenantEnabled(`  tenant-aaa , ${TAM} , tenant-ccc `, TAM)).toBe(true);
  });

  it('is ON for ANY tenant when the wildcard "*" is present (platform-wide)', () => {
    expect(isStep3GeoTenantEnabled('*', 'any-unknown-tenant')).toBe(true);
    expect(isStep3GeoTenantEnabled('*', TAM)).toBe(true);
  });

  it('treats "*" alongside other entries and spaces as all-on', () => {
    expect(isStep3GeoTenantEnabled(' tenant-aaa , * ', 'whatever-tenant')).toBe(true);
  });

  it('agrees with decideStep3Coords on the gate (no drift)', () => {
    // The decision must refuse with tenant-not-gated EXACTLY when the helper is off.
    const offEnv = 'tenant-aaa';
    expect(isStep3GeoTenantEnabled(offEnv, TAM)).toBe(false);
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: offEnv,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', ...CANELONES_POINT },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toBe('tenant-not-gated');
  });
});

describe('decideStep3Coords — env gate', () => {
  it('refuses when the env var is undefined (experiment off by default)', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: undefined,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', ...CANELONES_POINT },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toBe('tenant-not-gated');
  });

  it('refuses when the env var lists OTHER tenants only', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: 'tenant-aaa,tenant-bbb',
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', ...CANELONES_POINT },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toBe('tenant-not-gated');
  });

  it('accepts a gated tenant even when it sits in the middle of a spaced list', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: `  tenant-aaa , ${TAM} , tenant-ccc `,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', ...CANELONES_POINT },
    });
    expect(d.use).toBe(true);
  });

  it('accepts ANY tenant under the "*" wildcard (still subject to geo guards)', () => {
    const d = decideStep3Coords({
      tenantId: 'some-other-tenant-not-listed',
      enabledTenantsEnv: '*',
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', ...CANELONES_POINT },
    });
    expect(d.use).toBe(true);
  });
});

describe('decideStep3Coords — geocode quality gates', () => {
  it('refuses when the geocoder returned nothing', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Canelones',
      geo: null,
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toBe('geocode-no-result');
  });

  it('refuses when lat/lon are missing', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', lat: null, lon: null },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toBe('geocode-no-coords');
  });

  it('refuses when lat/lon are non-finite (NaN/Infinity)', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', lat: NaN, lon: Infinity },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toBe('geocode-no-coords');
  });

  it('refuses a point outside Uruguay (e.g. resolved to NYC)', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', lat: 40.7128, lon: -74.006 },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toMatch(/out-of-uy-bounds/);
  });

  it('refuses a point just across the border (lon west of Uruguay)', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', lat: -34.6, lon: -70.0 },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toMatch(/out-of-uy-bounds/);
  });
});

describe('decideStep3Coords — #11865 department sanity guard', () => {
  it('refuses when Nominatim places the address in a DIFFERENT department', () => {
    // The order was resolved to Tacuarembó on the form, but Nominatim thinks
    // the point is in Montevideo. Adopting that point would route the parcel
    // to the wrong department (exactly the #11865 bug). Fall back to centroid.
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Tacuarembó',
      geo: { department: 'Montevideo', lat: -34.9011, lon: -56.1645 },
    });
    expect(d.use).toBe(false);
    if (!d.use) expect(d.reason).toMatch(/geo-dept-mismatch/);
  });

  it('accepts when departments match despite accent/case differences', () => {
    // resolvedDept carries the accent ("Tacuarembó"), Nominatim's canonical
    // name does not ("Tacuarembo"). Normalization must treat them as equal.
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Tacuarembó',
      geo: { department: 'Tacuarembo', lat: -31.71, lon: -55.98 },
    });
    expect(d.use).toBe(true);
    if (d.use) {
      expect(d.lat).toBeCloseTo(-31.71, 5);
      expect(d.lon).toBeCloseTo(-55.98, 5);
      expect(d.reason).toBe('precise-geocode');
    }
  });
});

describe('decideStep3Coords — happy path', () => {
  it('returns the precise point when gated, in-bounds, and department matches', () => {
    const d = decideStep3Coords({
      tenantId: TAM,
      enabledTenantsEnv: TAM,
      resolvedDept: 'Canelones',
      geo: { department: 'Canelones', ...CANELONES_POINT },
    });
    expect(d.use).toBe(true);
    if (d.use) {
      expect(d.lat).toBe(CANELONES_POINT.lat);
      expect(d.lon).toBe(CANELONES_POINT.lon);
      expect(d.reason).toBe('precise-geocode');
    }
  });
});

describe('isCoarseGeocode — area-centroid detector (#5587 root cause)', () => {
  it('treats street/building level (>= STREET_LEVEL_PLACE_RANK) as precise', () => {
    expect(isCoarseGeocode(30)).toBe(false); // house / building
    expect(isCoarseGeocode(27)).toBe(false); // road
    expect(isCoarseGeocode(STREET_LEVEL_PLACE_RANK)).toBe(false); // exactly street level
  });

  it('treats area centroids (city / town / county / admin) as coarse', () => {
    expect(isCoarseGeocode(16)).toBe(true); // city
    expect(isCoarseGeocode(18)).toBe(true); // town
    expect(isCoarseGeocode(12)).toBe(true); // county/admin — the #5587 region centroid
    expect(isCoarseGeocode(STREET_LEVEL_PLACE_RANK - 1)).toBe(true); // just below street level
  });

  it('does NOT downgrade a result it cannot classify (preserves today behaviour)', () => {
    // Null/undefined/NaN place_rank → not coarse → no city-fallback trigger.
    expect(isCoarseGeocode(null)).toBe(false);
    expect(isCoarseGeocode(undefined)).toBe(false);
    expect(isCoarseGeocode(NaN)).toBe(false);
  });
});

describe('isSettlementResult — dept-capital city-node picker (#1967/#5587 root cause)', () => {
  it('true for city / town / village / street / building (place_rank >= 14)', () => {
    expect(isSettlementResult(16)).toBe(true); // city — e.g. the real Tacuarembó city node
    expect(isSettlementResult(18)).toBe(true); // town
    expect(isSettlementResult(26)).toBe(true); // road
    expect(isSettlementResult(SETTLEMENT_PLACE_RANK)).toBe(true); // exactly settlement level
  });

  it('false for STATE / COUNTY / region polygons (place_rank <= 12)', () => {
    expect(isSettlementResult(8)).toBe(false); // state — the dept polygon Nominatim returns FIRST
    expect(isSettlementResult(10)).toBe(false); // county
    expect(isSettlementResult(SETTLEMENT_PLACE_RANK - 1)).toBe(false);
  });

  it('false when place_rank is absent (cannot classify)', () => {
    expect(isSettlementResult(null)).toBe(false);
    expect(isSettlementResult(undefined)).toBe(false);
    expect(isSettlementResult(NaN)).toBe(false);
  });
});

describe('shouldTryBarrioFallback — Montevideo barrio-level fallback (2026-06-16 MVD silent-rejects)', () => {
  it('fires for Montevideo + a known barrio + a full-address miss/coarse', () => {
    expect(
      shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: 'Punta Carretas', dept: 'Montevideo' }),
    ).toBe(true);
  });

  it('is case-insensitive on the department name', () => {
    expect(
      shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: 'Ciudad Vieja', dept: 'montevideo' }),
    ).toBe(true);
  });

  it('does NOT fire for the interior, even with a barrio + a miss (city-fallback handles those)', () => {
    // Mercedes/Aguas Dulces/Chuy already mint guías via the city-centroid fallback;
    // the barrio fallback is Montevideo-only on purpose to keep the blast radius tiny.
    expect(
      shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: 'Centro', dept: 'Soriano' }),
    ).toBe(false);
    expect(
      shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: 'Centro', dept: 'Canelones' }),
    ).toBe(false);
  });

  it('does NOT fire when the full address geocoded fine (no miss/coarse)', () => {
    expect(
      shouldTryBarrioFallback({ geoMissedOrCoarse: false, barrio: 'Punta Carretas', dept: 'Montevideo' }),
    ).toBe(false);
  });

  it('does NOT fire without a barrio (nothing more specific than the city to try)', () => {
    expect(shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: null, dept: 'Montevideo' })).toBe(false);
    expect(shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: undefined, dept: 'Montevideo' })).toBe(false);
    expect(shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: '   ', dept: 'Montevideo' })).toBe(false);
  });

  it('does NOT fire when the department is missing', () => {
    expect(shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: 'Pocitos', dept: null })).toBe(false);
    expect(shouldTryBarrioFallback({ geoMissedOrCoarse: true, barrio: 'Pocitos', dept: '' })).toBe(false);
  });
});
