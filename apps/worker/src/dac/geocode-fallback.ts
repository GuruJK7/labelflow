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
