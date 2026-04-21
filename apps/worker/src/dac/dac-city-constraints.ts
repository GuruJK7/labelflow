/**
 * DAC city-name constraints for the AI resolver.
 *
 * Builds three artifacts from dac-geo-map.json:
 *
 *   1. `DAC_CITIES_PROMPT_BLOCK` — a compact "Department: city1, city2, …"
 *      listing that we inject into the Claude system prompt so the model
 *      only ever picks a `city` value that exists in DAC's dropdown.
 *
 *   2. `canonicalizeCityName(dept, city)` — post-validation helper that
 *      returns the DAC canonical spelling of a city if it matches (exact or
 *      close-fuzzy), or null. Lets the resolver normalize "Colonia del
 *      Sacramento" → "Colonia Del Sacramento" to match DAC's dropdown
 *      exactly, and catch outright hallucinations.
 *
 *   3. `DAC_DEPT_TO_CITY_NAMES` — raw name lists per department for callers
 *      that want to do their own matching (tests, tooling).
 *
 * Rationale: the AI was occasionally inventing city names that DAC's UI
 * doesn't recognise, which would make the later DAC-IDs resolution fail and
 * force a manual review. By constraining the model up-front with the real
 * dropdown options we push accuracy toward 100%.
 */

import dacGeoMap from './dac-geo-map.json';

// ─── types ─────────────────────────────────────────────────────────────

interface GeoCity {
  id: string;
  name: string;
  oficinas?: Array<{ id: string; name: string }>;
}
interface GeoDept {
  name: string;
  cities: GeoCity[];
}
interface GeoData {
  departments: Record<string, GeoDept>;
}

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Normalize a name for fuzzy matching: strip accents + parenthesized
 * clarifications, lowercase, collapse whitespace, drop non-alphanumeric.
 * "Colonia Del Sacramento" ≡ "colonia del sacramento"
 * "Salinas (Balneario)"    ≡ "salinas"
 */
export function normalizeDacName(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── build the indexes ────────────────────────────────────────────────

const DATA = dacGeoMap as unknown as GeoData;

/**
 * Map: department name (DAC casing) → array of city names (DAC casing).
 * Keeps original spelling because we want to round-trip it back into the
 * AI response so downstream DAC-ID resolution gets an exact match.
 */
export const DAC_DEPT_TO_CITY_NAMES: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  const depts = Object.keys(DATA.departments)
    .map((id) => ({ id: parseInt(id, 10), dept: DATA.departments[id] }))
    .sort((a, b) => a.id - b.id);
  for (const { dept } of depts) {
    out[dept.name] = dept.cities.map((c) => c.name);
  }
  return out;
})();

/**
 * Map: department name → map of normalized-city → DAC-canonical-city.
 * Allows O(1) lookup for exact-after-normalize matches.
 */
const DAC_DEPT_NORM_INDEX: Record<string, Map<string, string>> = (() => {
  const out: Record<string, Map<string, string>> = {};
  for (const [dept, names] of Object.entries(DAC_DEPT_TO_CITY_NAMES)) {
    const m = new Map<string, string>();
    for (const n of names) m.set(normalizeDacName(n), n);
    out[dept] = m;
  }
  return out;
})();

// ─── public API ────────────────────────────────────────────────────────

/**
 * Return DAC's canonical spelling of a city within a department if it can
 * be matched by exact-after-normalize, or null.
 *
 * We intentionally DO NOT do substring fallback here — in early testing a
 * substring match would silently pick "Colonia T.tres Orientales" for an
 * input of "Colonia" in department Canelones, which is absurdly wrong. The
 * system prompt already pushes the model toward an exact DAC spelling, and
 * when it misses, the fuzzy resolver in dac-geo-resolver.ts still gets a
 * chance. Better to return null here and let the caller downgrade
 * confidence than to silently normalize to the wrong thing.
 *
 * Matches "Colonia del Sacramento" → "Colonia Del Sacramento" (case + accent
 * fold). Matches "Paysandú" → "Paysandu" (accent fold). Rejects "Colonia"
 * when the dept isn't Colonia.
 */
export function canonicalizeCityName(
  department: string,
  city: string,
): string | null {
  if (!city) return null;
  const idx = DAC_DEPT_NORM_INDEX[department];
  if (!idx) return null;
  const n = normalizeDacName(city);
  if (!n) return null;
  return idx.get(n) ?? null;
}

/**
 * Compact per-department listing of valid DAC cities, formatted for
 * insertion into the Claude system prompt. Montevideo is omitted because
 * MVD uses barrios (handled elsewhere in the prompt) and its only "city"
 * in the DAC map is "Montevideo" itself — there is nothing for the model
 * to pick between.
 */
export const DAC_CITIES_PROMPT_BLOCK: string = (() => {
  const lines: string[] = [];
  const depts = Object.keys(DATA.departments)
    .map((id) => ({ id: parseInt(id, 10), dept: DATA.departments[id] }))
    .sort((a, b) => a.id - b.id);
  for (const { dept } of depts) {
    if (dept.name === 'Montevideo') continue;
    const names = dept.cities.map((c) => c.name);
    // Stable alpha sort within the dept so prompt-cache keys stay deterministic
    names.sort((a, b) => a.localeCompare(b));
    lines.push(`- ${dept.name}: ${names.join(', ')}`);
  }
  return lines.join('\n');
})();
