/**
 * Geocoding fallback for unknown cities using OpenStreetMap Nominatim API.
 * Free, no API key required. Rate limited to 1 request/second.
 *
 * When getDepartmentForCity() returns undefined (city not in our 530+ entry DB),
 * this module queries Nominatim to resolve the city to a Uruguay department.
 * Results are cached in-memory AND in the DB (geo_cache table) to avoid repeated API calls.
 *
 * This replaces a human operator who would "Google it" when they don't recognize a city.
 */
import logger from '../logger';

// In-memory cache to avoid hitting Nominatim repeatedly in the same run
const memoryCache = new Map<string, string | null>();

// Rate limit: Nominatim requires max 1 request per second
let lastRequestTime = 0;

function normalize(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Known Uruguay department names in various forms → canonical name.
 * Nominatim returns department names in Spanish with accents.
 */
const DEPT_NORMALIZE: Record<string, string> = {
  'artigas': 'Artigas',
  'canelones': 'Canelones',
  'cerro largo': 'Cerro Largo',
  'colonia': 'Colonia',
  'durazno': 'Durazno',
  'flores': 'Flores',
  'florida': 'Florida',
  'lavalleja': 'Lavalleja',
  'maldonado': 'Maldonado',
  'montevideo': 'Montevideo',
  'paysandu': 'Paysandu',
  'rio negro': 'Rio Negro',
  'rivera': 'Rivera',
  'rocha': 'Rocha',
  'salto': 'Salto',
  'san jose': 'San Jose',
  'soriano': 'Soriano',
  'tacuarembo': 'Tacuarembo',
  'treinta y tres': 'Treinta y Tres',
  // With accents (Nominatim returns these)
  'paysandú': 'Paysandu',
  'tacuarembó': 'Tacuarembo',
  'río negro': 'Rio Negro',
  'san josé': 'San Jose',
  'departamento de artigas': 'Artigas',
  'departamento de canelones': 'Canelones',
  'departamento de cerro largo': 'Cerro Largo',
  'departamento de colonia': 'Colonia',
  'departamento de durazno': 'Durazno',
  'departamento de flores': 'Flores',
  'departamento de florida': 'Florida',
  'departamento de lavalleja': 'Lavalleja',
  'departamento de maldonado': 'Maldonado',
  'departamento de montevideo': 'Montevideo',
  'departamento de paysandú': 'Paysandu',
  'departamento de paysandu': 'Paysandu',
  'departamento de río negro': 'Rio Negro',
  'departamento de rio negro': 'Rio Negro',
  'departamento de rivera': 'Rivera',
  'departamento de rocha': 'Rocha',
  'departamento de salto': 'Salto',
  'departamento de san josé': 'San Jose',
  'departamento de san jose': 'San Jose',
  'departamento de soriano': 'Soriano',
  'departamento de tacuarembó': 'Tacuarembo',
  'departamento de tacuarembo': 'Tacuarembo',
  'departamento de treinta y tres': 'Treinta y Tres',
};

function normalizeDeptName(raw: string): string | null {
  const n = raw.trim().toLowerCase();
  if (DEPT_NORMALIZE[n]) return DEPT_NORMALIZE[n];
  // Try after stripping accents
  const stripped = normalize(n);
  if (DEPT_NORMALIZE[stripped]) return DEPT_NORMALIZE[stripped];
  return null;
}

/**
 * Query Nominatim for a city in Uruguay and return the department.
 * Returns null if not found or on error.
 */
export async function geocodeCityToDepartment(cityName: string): Promise<string | null> {
  const key = normalize(cityName);
  if (!key || key.length < 2) return null;

  // Check memory cache
  if (memoryCache.has(key)) {
    const cached = memoryCache.get(key)!;
    logger.info({ city: cityName, cached, source: 'memory' }, '[Geocode] Cache hit');
    return cached;
  }

  // Rate limit: wait if needed
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1100) {
    await new Promise(resolve => setTimeout(resolve, 1100 - elapsed));
  }
  lastRequestTime = Date.now();

  try {
    // Use dynamic import for fetch (Node 18+ has native fetch)
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName + ', Uruguay')}&format=json&addressdetails=1&limit=3&countrycodes=uy`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'LabelFlow/1.0 (shipping automation)',
        'Accept-Language': 'es',
      },
    });

    if (!response.ok) {
      logger.warn({ city: cityName, status: response.status }, '[Geocode] Nominatim HTTP error');
      memoryCache.set(key, null);
      return null;
    }

    const results = await response.json() as Array<{
      display_name: string;
      address?: {
        state?: string;
        county?: string;
        city?: string;
        town?: string;
        village?: string;
        hamlet?: string;
      };
    }>;

    if (!results || results.length === 0) {
      logger.info({ city: cityName }, '[Geocode] No results from Nominatim');
      memoryCache.set(key, null);
      return null;
    }

    // Extract department from the best result
    for (const r of results) {
      const state = r.address?.state;
      if (state) {
        const dept = normalizeDeptName(state);
        if (dept) {
          logger.info({ city: cityName, department: dept, raw: state }, '[Geocode] Resolved via Nominatim');
          memoryCache.set(key, dept);
          return dept;
        }
      }
    }

    // If state field not found, try parsing display_name
    const display = results[0].display_name;
    if (display) {
      const parts = display.split(',').map(p => p.trim());
      for (const part of parts) {
        const dept = normalizeDeptName(part);
        if (dept) {
          logger.info({ city: cityName, department: dept, from: 'display_name' }, '[Geocode] Resolved from display_name');
          memoryCache.set(key, dept);
          return dept;
        }
      }
    }

    logger.warn({ city: cityName, display: results[0]?.display_name }, '[Geocode] Found results but could not extract department');
    memoryCache.set(key, null);
    return null;

  } catch (err) {
    logger.error({ city: cityName, error: (err as Error).message }, '[Geocode] Nominatim request failed');
    memoryCache.set(key, null);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Full-address geocoding — richer signal than city alone
// ───────────────────────────────────────────────────────────────────────────
//
// When the city field is wrong (the classic "Shopify autofilled 'Montevideo'
// but the customer actually lives in the interior") we cannot trust any single
// field. Feeding Nominatim the FULL address string gives it much more signal:
// it parses street names, locality mentions in address2, and returns the
// geographic state (= Uruguay department) based on the actual map location.
//
// Returns { department, city } because Nominatim also tells us the locality
// name, which we can cross-check against DAC's canonical city list upstream.
// Cached by a hash of the full address tuple — different tuples query
// independently but the same tuple is resolved from cache.

interface AddressQuery {
  city?: string;
  address1?: string;
  address2?: string;
  zip?: string;
}

export interface AddressGeocodeResult {
  department: string;
  /** Nominatim's best guess at the locality (town / village / city field). */
  locality: string | null;
  /** The raw display_name Nominatim returned — useful for audit/debugging. */
  displayName: string;
  /**
   * Precise point coordinates Nominatim resolved for this address (WGS84).
   * Nominatim always returns these at the top level of each result; we used
   * to discard them. They power the DAC Step-3 "real coords" experiment
   * (see shipment.ts — DAC_STEP3_REAL_GEOCODE_TENANTS): instead of injecting
   * the department CENTROID into DAC's hidden lat/lng fields (which can be
   * 50-100 km from a real interior address and makes DAC silently refuse to
   * mint the guía), we inject the address's actual point. Null when Nominatim
   * omitted them or they failed to parse as finite numbers.
   */
  lat: number | null;
  lon: number | null;
  /**
   * Nominatim `place_rank`: how specific the matched feature is. Building/house
   * ~30, road ~26-27, suburb/neighbourhood ~20-22, village ~19, town ~18, city
   * ~16, county/admin ~10-12 (lower = coarser / larger area). A real street-level
   * hit is >=24; a coarse AREA-centroid fallback (e.g. Nominatim couldn't find the
   * street and returned the locality/department center) is <24. We used to discard
   * this and accept ANY point in the right department as "precise" — the root cause
   * of interior silent-rejects like #5587 (Tacuarembó got -32.17,-55.5, ~50 km off
   * the real city, logged as "PRECISE"). isCoarseGeocode() reads this. Null if absent.
   */
  placeRank: number | null;
  /** Nominatim `addresstype` (e.g. "house","road","city","administrative"). Audit only. */
  addressType: string | null;
}

/**
 * Build a compact query string from an address tuple. We deliberately DROP
 * obviously-invalid city values like "Montevideo" when the address1 clearly
 * points elsewhere, because including them would poison the geocoder.
 * Rule: trust address1 most, then address2, then city (only if non-empty and
 * not an obvious default value).
 */
function buildQuery(input: AddressQuery): string {
  const parts: string[] = [];
  if (input.address1) parts.push(input.address1);
  if (input.address2 && input.address2.trim()) parts.push(input.address2);
  if (input.city && input.city.trim()) parts.push(input.city);
  if (input.zip && input.zip.trim()) parts.push(input.zip);
  parts.push('Uruguay');
  // Collapse redundant whitespace and commas to keep the URL short.
  return parts.join(', ').replace(/\s+/g, ' ').trim();
}

const addressCache = new Map<string, AddressGeocodeResult | null>();

/**
 * Geocode a full Shopify address tuple to a Uruguay department. Uses
 * OpenStreetMap Nominatim, which is free and has global address coverage.
 *
 * Rate-limited to 1 req/s (shared with geocodeCityToDepartment). Cached
 * in-memory by the normalized address tuple.
 *
 * Returns null when:
 *  - Nominatim returns no results for the query
 *  - Nominatim returns results but none are in Uruguay
 *  - The department name in the response doesn't match our canonical list
 */
export async function geocodeAddressToDepartment(
  input: AddressQuery,
  opts?: { preferSettlement?: boolean },
): Promise<AddressGeocodeResult | null> {
  const preferSettlement = opts?.preferSettlement ?? false;
  const query = buildQuery(input);
  if (query.length < 5) return null;

  // preferSettlement changes which result we pick, so it must vary the cache key.
  const cacheKey = normalize(query) + (preferSettlement ? '|s' : '');
  if (addressCache.has(cacheKey)) {
    const cached = addressCache.get(cacheKey)!;
    logger.info({ query, cached: !!cached }, '[GeocodeAddr] Cache hit');
    return cached;
  }

  // Shared rate limiter with geocodeCityToDepartment — Nominatim's public
  // instance requires max 1 req/s across the whole process.
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1100) {
    await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
  }
  lastRequestTime = Date.now();

  try {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}` +
      `&format=json&addressdetails=1&limit=3&countrycodes=uy`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'LabelFlow/1.0 (shipping automation)',
        'Accept-Language': 'es',
      },
    });

    if (!response.ok) {
      logger.warn({ query, status: response.status }, '[GeocodeAddr] Nominatim HTTP error');
      addressCache.set(cacheKey, null);
      return null;
    }

    const results = (await response.json()) as Array<{
      display_name: string;
      // Nominatim returns the resolved point as top-level lat/lon strings.
      lat?: string;
      lon?: string;
      // place_rank (number) + addresstype (string): how specific the match is.
      // Used to tell a real street hit from a coarse area-centroid fallback.
      place_rank?: number;
      addresstype?: string;
      address?: {
        state?: string;
        country_code?: string;
        city?: string;
        town?: string;
        village?: string;
        hamlet?: string;
        county?: string;
        suburb?: string;
      };
    }>;

    if (!results || results.length === 0) {
      logger.info({ query }, '[GeocodeAddr] No results');
      addressCache.set(cacheKey, null);
      return null;
    }

    // Dept-capital fix (2026-06-07): when preferSettlement is on, sort
    // settlement-level results (city/town/village/street, place_rank >= 14)
    // AHEAD of coarser state/county polygons, so the picker below chooses the
    // real CITY node instead of the DEPARTMENT centroid Nominatim returns first
    // for the 7 capitals whose name == their department (Tacuarembó, Durazno,
    // Rocha, Canelones, Florida, Artigas, Treinta y Tres). Array.sort is stable,
    // so same-class order is preserved and a non-settlement result is still used
    // as fallback when no settlement-level result exists.
    const ordered = preferSettlement
      ? [...results].sort(
          (a, b) =>
            (isSettlementResult(b.place_rank ?? null) ? 1 : 0) -
            (isSettlementResult(a.place_rank ?? null) ? 1 : 0),
        )
      : results;

    // Pick the first result that is in Uruguay and has a recognizable state.
    for (const r of ordered) {
      if (r.address?.country_code && r.address.country_code.toLowerCase() !== 'uy') continue;
      const state = r.address?.state;
      if (!state) continue;
      const dept = normalizeDeptName(state);
      if (!dept) continue;

      const locality =
        r.address?.city ||
        r.address?.town ||
        r.address?.village ||
        r.address?.hamlet ||
        r.address?.suburb ||
        null;

      // Parse the point coordinates. Guard against NaN / Infinity so callers
      // can trust a non-null lat/lon is a usable finite number.
      const latNum = r.lat != null ? Number.parseFloat(r.lat) : NaN;
      const lonNum = r.lon != null ? Number.parseFloat(r.lon) : NaN;

      const result: AddressGeocodeResult = {
        department: dept,
        locality,
        displayName: r.display_name,
        lat: Number.isFinite(latNum) ? latNum : null,
        lon: Number.isFinite(lonNum) ? lonNum : null,
        placeRank: typeof r.place_rank === 'number' && Number.isFinite(r.place_rank) ? r.place_rank : null,
        addressType: typeof r.addresstype === 'string' && r.addresstype ? r.addresstype : null,
      };
      logger.info(
        { query, dept, locality, lat: result.lat, lon: result.lon, placeRank: result.placeRank, addressType: result.addressType, display: r.display_name },
        '[GeocodeAddr] Resolved',
      );
      addressCache.set(cacheKey, result);
      return result;
    }

    logger.warn(
      { query, first: results[0]?.display_name },
      '[GeocodeAddr] Results found but no recognizable UY state',
    );
    addressCache.set(cacheKey, null);
    return null;
  } catch (err) {
    logger.error(
      { query, error: (err as Error).message },
      '[GeocodeAddr] Nominatim request failed',
    );
    addressCache.set(cacheKey, null);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// DAC Step-3 "real coordinates" decision (experiment — env-gated)
// ───────────────────────────────────────────────────────────────────────────
//
// Context (2026-06-04 investigation): when the worker reaches DAC's Step 3 it
// UNCONDITIONALLY skips the "Siguiente" button and injects the DEPARTMENT
// CENTROID into DAC's hidden latitude/longitude fields. DAC's backend uses
// those coords as the authoritative destination. For Montevideo addresses the
// centroid is fine (the whole department is one city). For interior addresses
// the centroid can be 50-100 km from the real address, and the data shows DAC
// then SILENTLY refuses to mint the guía in ~72% of interior failures (no
// validation error, no redirect, no guía ever appears in historial). This is
// the dominant cause of the MVD 97% vs Interior 86% success gap.
//
// The experiment: for gated tenants, geocode the REAL address (Nominatim) and
// inject that precise point instead of the centroid. This is purely additive
// and OFF by default — with no DAC_STEP3_REAL_GEOCODE_TENANTS env var the
// decision below always returns { use:false }, so behaviour is byte-identical
// to today (centroid path). We can turn it on for ONE tenant (TAM) and measure
// the create-rate from RunLog before any wider rollout.

// Uruguay bounding box (deliberately generous). Rejects a geocode that
// resolved to a same-named place outside the country.
const UY_LAT_MIN = -35.5;
const UY_LAT_MAX = -29.5;
const UY_LON_MIN = -59.5;
const UY_LON_MAX = -52.5;

export type Step3CoordsDecision =
  | { use: false; reason: string }
  | { use: true; lat: number; lon: number; reason: string };

/**
 * Single source of truth for the Lever-B tenant gate. Parses the
 * comma-separated DAC_STEP3_REAL_GEOCODE_TENANTS env value (tolerating spaces
 * and empty entries) and reports whether `tenantId` is enabled.
 *
 * Used in BOTH places that gate the experiment — the caller's early-exit guard
 * in shipment.ts (which avoids the expensive geocoder network call for
 * non-gated tenants) and decideStep3Coords below — so the two can never drift
 * apart. With the env var unset this returns false, preserving the byte-
 * identical default-OFF behaviour.
 */
export function isStep3GeoTenantEnabled(
  enabledTenantsEnv: string | undefined,
  tenantId: string,
): boolean {
  const entries = (enabledTenantsEnv ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  // "*" enables Lever B for ALL tenants (platform-wide rollout, future tenants
  // included). Explicit tenant ids still work — alone, or alongside the
  // wildcard. With the env var unset/empty this stays false (default-OFF).
  if (entries.includes('*')) return true;
  return entries.includes(tenantId);
}

/**
 * Coarse-geocode detector (PURE, unit-tested). True when a full-address geocode
 * result is NOT street-level — i.e. Nominatim fell back to an AREA centroid
 * (city / town / department / administrative boundary) instead of pinning the
 * actual street. Those points can be 50-100 km from the real address and make
 * DAC silently reject the guía (root cause of #5587: Tacuarembó got a region
 * centroid -32.17,-55.5 ~50 km off the city, accepted as "PRECISE").
 *
 * Threshold: Nominatim place_rank >= 24 is street/building level (road ~26,
 * house ~30); < 24 is an area centroid (suburb ~22, town ~18, city ~16,
 * county/admin ~10-12). When place_rank is ABSENT (null) we return false —
 * we do not downgrade a result we cannot classify, preserving today's behaviour.
 */
export const STREET_LEVEL_PLACE_RANK = 24;
export function isCoarseGeocode(placeRank: number | null | undefined): boolean {
  return typeof placeRank === 'number' && Number.isFinite(placeRank) && placeRank < STREET_LEVEL_PLACE_RANK;
}

/**
 * Settlement-or-finer detector (PURE, unit-tested). True when a Nominatim
 * result is at city/town/village/suburb/street/building level (place_rank >= 14)
 * rather than a STATE / COUNTY / region polygon (place_rank <= 12).
 *
 * Root cause it fixes (2026-06-07, real data): for the 7 Uruguay capitals whose
 * name == their department name (Tacuarembó, Durazno, Rocha, Canelones, Florida,
 * Artigas, Treinta y Tres), Nominatim returns the DEPARTMENT polygon FIRST
 * (place_rank 8, its centroid ~50 km from the capital) and the actual CITY node
 * SECOND. Taking the first result injected that dept centroid into DAC's hidden
 * lat/lng → DAC silently rejected every interior order in those departments
 * (confirmed: #1967/#5587 Tacuarembó both got -32.166667,-55.5). The fix sorts
 * settlement-level results ahead of state/county polygons so we pick the real
 * city node (which Nominatim DOES return, just not first). Cities that already
 * resolve correctly (Salto, Maldonado, Mercedes…) are unaffected (their first
 * result is already a city, rank 16).
 */
export const SETTLEMENT_PLACE_RANK = 14;
export function isSettlementResult(placeRank: number | null | undefined): boolean {
  return typeof placeRank === 'number' && Number.isFinite(placeRank) && placeRank >= SETTLEMENT_PLACE_RANK;
}

/**
 * PURE decision (network-free, fully unit-testable): given the env gate, the
 * department we already committed to on the DAC form (`resolvedDept`), and a
 * geocode result, decide whether to inject the geocoded point into DAC's
 * hidden lat/lng fields instead of the department centroid.
 *
 * We REFUSE the precise coords (caller falls back to the centroid) when ANY of:
 *   - the tenant is NOT in DAC_STEP3_REAL_GEOCODE_TENANTS (experiment off)
 *   - the geocoder returned nothing / no usable finite coords
 *   - the point is outside Uruguay's bounding box
 *   - the geocoded department disagrees with `resolvedDept`. This is the
 *     #11865 misclassification guard: if Nominatim places the address in a
 *     different department than the one we selected on the form, we do NOT
 *     trust its point — better the centroid of the department we DID select
 *     than a point that would route the parcel to the wrong department.
 */
export function decideStep3Coords(params: {
  tenantId: string;
  enabledTenantsEnv: string | undefined;
  resolvedDept: string;
  geo: { department: string; lat: number | null; lon: number | null } | null;
}): Step3CoordsDecision {
  const { tenantId, enabledTenantsEnv, resolvedDept, geo } = params;

  if (!isStep3GeoTenantEnabled(enabledTenantsEnv, tenantId)) {
    return { use: false, reason: 'tenant-not-gated' };
  }
  if (!geo) return { use: false, reason: 'geocode-no-result' };
  if (
    geo.lat == null ||
    geo.lon == null ||
    !Number.isFinite(geo.lat) ||
    !Number.isFinite(geo.lon)
  ) {
    return { use: false, reason: 'geocode-no-coords' };
  }
  if (
    geo.lat < UY_LAT_MIN ||
    geo.lat > UY_LAT_MAX ||
    geo.lon < UY_LON_MIN ||
    geo.lon > UY_LON_MAX
  ) {
    return { use: false, reason: `coords-out-of-uy-bounds(${geo.lat},${geo.lon})` };
  }
  // Department sanity check — normalize both sides to canonical dept names.
  const geoDept = normalizeDeptName(geo.department) ?? geo.department;
  const wantDept = normalizeDeptName(resolvedDept) ?? resolvedDept;
  if (normalize(geoDept) !== normalize(wantDept)) {
    return { use: false, reason: `geo-dept-mismatch(${geoDept}!=${wantDept})` };
  }
  return { use: true, lat: geo.lat, lon: geo.lon, reason: 'precise-geocode' };
}

/**
 * Should we try a BARRIO-level geocode fallback (before the city fallback)?
 *
 * MONTEVIDEO ONLY. For the interior the CITY is the granular unit and the
 * city-centroid fallback already lands a few km from the address (proven in
 * prod 2026-06-16: Mercedes, Aguas Dulces, Chuy now mint guías). Montevideo is
 * different: it is one huge "city", so the city centroid (~-34.906,-56.191) is
 * generic and DAC silently rejects it for addresses in barrios several km away
 * — confirmed 2026-06-16, three MVD silent-rejects (#2378 Ciudad Vieja, #5962
 * Punta Carretas, #2377) all carrying that exact centroid. The barrio is
 * already resolved on the form (K_Barrio), so on a full-address miss/coarse we
 * geocode "<barrio>, Montevideo" first — a barrio-level point DAC accepts.
 *
 * Pure + network-free so it is unit-testable. The caller still gates it behind
 * its own env flag (DAC_STEP3_BARRIO_FALLBACK) and runs decideStep3Coords'
 * dept-match + UY-bounds guards on the result, so a bad barrio point falls
 * through to the city/department centroid (today's behaviour).
 */
export function shouldTryBarrioFallback(params: {
  /** The full-address geocode missed entirely or came back coarse. */
  geoMissedOrCoarse: boolean;
  /** The barrio resolved for this order (K_Barrio), if any. */
  barrio: string | null | undefined;
  /** The department resolved for this order. */
  dept: string | null | undefined;
}): boolean {
  return (
    params.geoMissedOrCoarse &&
    !!params.barrio &&
    params.barrio.trim().length > 0 &&
    /montevideo/i.test(params.dept ?? '')
  );
}
