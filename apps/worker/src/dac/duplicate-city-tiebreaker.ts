/**
 * Duplicate-city disambiguation table for Uruguay.
 *
 * 34 DAC canonical city names appear in more than one department. When
 * Shopify gives us just a bare `city` (no province, no ZIP, no address2),
 * Nominatim picks ONE of those possibilities at random — often the tiny
 * pueblo instead of the major city of the same name.
 *
 * Classic real-world failure: `city="La Paz"` → Nominatim picks "La Paz,
 * Colonia" (a 500-person pueblo in an abandoned corner of Colonia) when
 * the customer almost certainly means "La Paz, Canelones" (a 20,000-
 * person city 15km from Montevideo).
 *
 * This table encodes the "most likely" department for each duplicate name
 * based on population + shipping volume in Uruguay. When every other
 * signal is missing OR when Nominatim's guess contradicts the population
 * ranking by a wide margin, we prefer the ranked-first dept.
 *
 * Source: INE Uruguay 2011 census + DAC historical shipment volume.
 * Rankings are ORDERED — index 0 is the primary choice.
 *
 * Usage contract:
 *   - `preferredDeptFor(cityName)` returns the primary-choice dept when
 *     the name is duplicated, or null when the city is unambiguous.
 *   - Callers should ONLY use this when no stronger signal (ZIP, province,
 *     address2, customer history) exists.
 */

import { normalizeDacName } from './dac-city-constraints';

// ─── tiebreaker table ───────────────────────────────────────────────────
//
// Keys are normalized (lowercase, no accents). Values are ORDERED dept
// rankings — [0] is the preferred default. Populations are rough INE 2011
// figures; what matters for our purposes is the ORDINAL ordering, not the
// exact numbers.
//
// The comment on each line explains WHY that ordering — usually the
// population gap is 10x+, but in a few cases (bella vista, castillos)
// the two candidates are comparable and we fall back to which one has
// more shipping volume historically.

export const DUPLICATE_CITY_TIEBREAKER: Record<string, readonly string[]> = {
  // city-name: [preferred, ...alternates]
  'la paz': ['Canelones', 'Colonia'],                 // Canelones ~20k vs Colonia ~500
  'las piedras': ['Canelones', 'Artigas'],            // Canelones ~70k vs Artigas ~1k
  'toledo': ['Canelones', 'Cerro Largo'],             // Canelones ~17k vs Cerro Largo ~1k
  'chamizo': ['Florida', 'Canelones'],                // Florida (pueblo principal) vs Canelones (anexo)
  'cruz de los caminos': ['Canelones', 'Tacuarembo'], // Canelones more volume
  'fray marcos': ['Florida', 'Canelones'],            // Florida is where the actual Fray Marcos town is
  'las toscas': ['Canelones', 'Tacuarembo'],          // Canelones (balneario Costa de Oro) >> Tacuarembo
  'los pinos': ['Canelones', 'Colonia'],              // Canelones (balneario) main
  'santa ana': ['Canelones', 'Colonia'],              // Canelones (pueblo mayor)
  'san antonio': ['Canelones', 'Salto', 'Rocha'],     // Canelones (San Antonio de Dios) main
  'arachania': ['Rocha', 'Cerro Largo'],              // Rocha (Arachania balneario) main
  'arbolito': ['Paysandu', 'Cerro Largo'],            // Paysandu main
  'esperanza': ['Paysandu', 'Cerro Largo'],           // Paysandu (Colonia Esperanza) main
  'quebracho': ['Paysandu', 'Cerro Largo'],           // Paysandu (Quebracho pueblo) main
  'mangrullo': ['San Jose', 'Cerro Largo'],           // San Jose (near Libertad) main
  'la pedrera': ['Rocha', 'Tacuarembo', 'Rivera', 'Cerro Largo'], // Rocha balneario famoso
  'agraciada': ['Soriano', 'Colonia'],                // Soriano (Villa Agraciada) main
  'cerro chato': ['Treinta y Tres', 'Florida', 'Durazno', 'Paysandu'], // T y T main
  'la paloma': ['Rocha', 'Durazno'],                  // Rocha (La Paloma balneario famoso)
  'cerro colorado': ['Florida', 'Flores'],            // Florida (pueblo con población) main
  'illescas': ['Lavalleja', 'Florida'],               // Lavalleja main
  'nico perez': ['Lavalleja', 'Florida'],             // Lavalleja (José Batlle y Ordóñez area)
  'valentines': ['Treinta y Tres', 'Lavalleja'],      // T y T main
  'bella vista': ['Paysandu', 'Maldonado'],           // Paysandu (pueblo) main vs MLD (barrio chico)
  'cerro pelado': ['Maldonado', 'Rivera'],            // Maldonado (barrio de Maldonado) more volume
  'las flores': ['Maldonado', 'Salto', 'Rivera'],     // Maldonado (balneario) main
  'santa monica': ['San Jose', 'Maldonado'],          // San Jose main
  'algorta': ['Rio Negro', 'Paysandu'],               // Rio Negro (Villa Algorta) main
  'merinos': ['Rio Negro', 'Paysandu'],               // Rio Negro main
  'piedra sola': ['Tacuarembo', 'Paysandu'],          // Tacuarembo main
  'tambores': ['Tacuarembo', 'Paysandu'],             // Tacuarembo main
  'villa maria': ['San Jose', 'Rio Negro'],           // San Jose main
  'castillos': ['Rocha', 'Soriano'],                  // Rocha (Castillos) is a 7k-person city
  'laureles': ['Tacuarembo', 'Salto'],                // Tacuarembo main
};

// ─── public API ─────────────────────────────────────────────────────────

/**
 * Return the preferred department for an ambiguous city name, or null if
 * the name does not appear in the duplicate table.
 *
 * The returned dept is what we would bet on when NO other signal is
 * available. Callers MUST still honour stronger signals (ZIP, explicit
 * province, address2 with a known locality) before falling back to this.
 */
export function preferredDeptFor(cityName: string): string | null {
  const n = normalizeDacName(cityName);
  if (!n) return null;
  const ranked = DUPLICATE_CITY_TIEBREAKER[n];
  return ranked?.[0] ?? null;
}

/**
 * Return every known department for a given city name (preferred first),
 * or null if the city is not duplicated. Useful when the caller wants
 * to check whether their current guess is even in the candidate set.
 */
export function candidateDeptsFor(cityName: string): readonly string[] | null {
  const n = normalizeDacName(cityName);
  if (!n) return null;
  return DUPLICATE_CITY_TIEBREAKER[n] ?? null;
}

/**
 * Check whether a (city, dept) pair is the NON-preferred choice for a
 * duplicated city. Returns the preferred alternative dept, or null if
 * either the city is not duplicated OR the dept is already the preferred
 * one. The caller can use this to flag "Nominatim probably picked the
 * wrong La Paz" situations for correction.
 */
export function nonPreferredConflict(
  cityName: string,
  currentDept: string,
): string | null {
  const ranked = candidateDeptsFor(cityName);
  if (!ranked) return null;
  if (ranked[0] === currentDept) return null;
  // Only flag when the current dept IS one of the candidates — otherwise
  // the mismatch is probably because we're looking at a different city
  // that happens to share a name, and we should not interfere.
  if (!ranked.includes(currentDept)) return null;
  return ranked[0];
}
