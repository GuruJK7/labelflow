/**
 * Deterministic department resolver.
 *
 * Decides the correct UY department from a Shopify address tuple using
 * nothing but rules — no AI, no API calls. Runs as the first step of the
 * new resolution pipeline, before the AI ever gets invoked.
 *
 * Rationale: the AI gets confused when it has to juggle many signals
 * (city field, address2, street names, cheat-sheets). Most real orders
 * have ONE strong signal that decides the department — the goal of this
 * module is to find that signal and stop. The AI only runs on genuinely
 * ambiguous cases (typically interior balneario + empty city field).
 *
 * Decision order (first hit wins):
 *   1. ZIP code prefix — most reliable when present (Uruguay ZIPs encode dept)
 *   2. Address fields (address1, address2, orderNotes) contain an
 *      unambiguous capital or major non-MVD city → that department
 *   3. Exact match of the `city` field against a DAC canonical city of
 *      ONE unique department (most cities map to exactly one dept)
 *   4. Ambiguous names (Las Piedras, Toledo, Santa Catalina, etc.) with
 *      tie-breakers (province field, ZIP, or fall through to AI)
 *   5. Fallback: only return a decision if city="Montevideo" AND no
 *      interior signal was found → dept = Montevideo
 *   6. Otherwise return null → caller falls back to AI
 */

import dacGeoMap from './dac-geo-map.json';

// ─── types ─────────────────────────────────────────────────────────────

export interface DeptInput {
  city: string;
  address1: string;
  address2: string;
  zip?: string;
  province?: string;
  orderNotes?: string;
}

export interface DeptResolution {
  department: string;
  confidence: 'high' | 'medium' | 'low';
  /** Which rule fired. Useful for audit + debugging. */
  matchedVia:
    | 'zip'
    | 'address-capital'
    | 'address-major-city'
    | 'city-exact-unique'
    | 'city-exact-mvd'
    | 'province'
    | 'default-mvd';
  reason: string;
}

// ─── normalization ─────────────────────────────────────────────────────

function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── ZIP prefix → department ───────────────────────────────────────────
//
// Uruguay's CP postal code spans 00000-99999 but only a subset is used, and
// many Shopify customers leave it blank or enter "00000". We therefore keep
// this table conservative: ONLY prefixes we can verify with high confidence,
// so a false positive doesn't poison the downstream pipeline. When the prefix
// is ambiguous or we're unsure, we skip it and let the next rule (address
// capital / major city / province) decide — those signals are at least as
// strong and far more common in real orders.

// Complete Uruguay CP prefix table — covers all 19 departments per official
// Correo Uruguayo documentation. "CONFIRMED" = verified against at least one
// real production shipment from the 2026-04-21 30-order audit. "OFFICIAL" =
// verified against correo.com.uy / Uruguay's ISO 3166-2 postal scheme only
// (no production sample yet but the scheme is systematic: first two digits
// always indicate department).
//
// Do NOT modify a prefix without cross-checking both production data and
// Correo Uruguayo — a wrong prefix silently misroutes every order in that
// range to the wrong department.
const ZIP_PREFIX_TO_DEPT: Record<string, string> = {
  '11': 'Montevideo',      // CONFIRMED — Montevideo proper (universal)
  '15': 'Canelones',       // CONFIRMED — Canelones east (Pando, Las Piedras, Las Toscas, Neptunia)
  '20': 'Maldonado',       // CONFIRMED — Maldonado / Punta del Este / San Carlos / Piriápolis / Portezuelo
  '27': 'Rocha',           // CONFIRMED — Rocha / Chuy / La Paloma (zip=27000 → Rocha)
  '30': 'Lavalleja',       // OFFICIAL  — Minas (capital=30000), José Batlle y Ordóñez, José Pedro Varela
  '33': 'Treinta y Tres',  // CONFIRMED — Treinta y Tres capital (zip=33000)
  '37': 'Cerro Largo',     // CONFIRMED — Melo / Río Branco / Fraile Muerto (zip=37000 → Melo)
  '40': 'Rivera',          // OFFICIAL  — Rivera capital (=40000), Tranqueras, Vichadero, Minas de Corrales
  '45': 'Tacuarembo',      // OFFICIAL  — Tacuarembó capital (=45000), Paso de los Toros, San Gregorio de Polanco
  '50': 'Salto',           // CONFIRMED — Salto capital / Constitución / Belén (zip=50000)
  '55': 'Artigas',         // OFFICIAL  — Artigas capital (=55000), Bella Unión, Tomás Gomensoro
  '60': 'Paysandu',        // CONFIRMED — Paysandú / Guichón / Quebracho (zip=60000)
  '65': 'Rio Negro',       // OFFICIAL  — Fray Bentos (=65000), Young (=65100), Nuevo Berlín
  '70': 'Colonia',         // CONFIRMED — Colonia del Sacramento / Carmelo / Juan Lacaze / Rosario
  '75': 'Soriano',         // CONFIRMED — Mercedes / Dolores / Cardona / Palmitas (zip=75500 → Palmitas)
  '80': 'San Jose',        // CONFIRMED — San José de Mayo / Libertad / Ciudad del Plata (zip=80100 → Libertad)
  '85': 'Flores',          // CONFIRMED — Trinidad (zip=85000 → Trinidad)
  '90': 'Canelones',       // CONFIRMED — Ciudad de la Costa, Solymar, Lagomar, Atlántida coast
  '91': 'Canelones',       // CONFIRMED — Canelones suburbs / Canelones city
  '94': 'Florida',         // CONFIRMED — Florida capital / Sarandí Grande (zip=94000, 94100)
  '97': 'Durazno',         // OFFICIAL  — Durazno capital (=97000), Sarandí del Yí, Villa del Carmen
};

// ─── department capitals ───────────────────────────────────────────────
//
// For interior departments, the capital city name IS a strong signal. If
// we see "Tacuarembó" anywhere in the address, we're 99% sure the depto
// is Tacuarembó. Exceptions are rare and usually caught by other rules.
//
// Each entry maps a normalized name → department. Aliases are included
// (eg. "colonia del sacramento" AND "colonia" both map to Colonia, but
// "colonia" alone is ambiguous because several departments contain a
// locality called "Colonia X" — we handle that below).

// Capitals are non-ambiguous when they appear as a full token — no other
// UY department shares the capital name (except Rocha-Rocha and
// Florida-Florida which are still unambiguous: if you see "Florida" in
// an address, you're in dept. Florida).
const DEPT_CAPITALS: Array<{ aliases: string[]; dept: string }> = [
  { aliases: ['artigas'],                                            dept: 'Artigas' },
  { aliases: ['canelones'],                                          dept: 'Canelones' },
  { aliases: ['melo'],                                               dept: 'Cerro Largo' },
  { aliases: ['colonia del sacramento'],                             dept: 'Colonia' },
  { aliases: ['durazno'],                                            dept: 'Durazno' },
  { aliases: ['trinidad'],                                           dept: 'Flores' },
  { aliases: ['florida'],                                            dept: 'Florida' },
  { aliases: ['minas'],                                              dept: 'Lavalleja' },
  { aliases: ['maldonado'],                                          dept: 'Maldonado' },
  { aliases: ['paysandu'],                                           dept: 'Paysandu' },
  { aliases: ['fray bentos'],                                        dept: 'Rio Negro' },
  { aliases: ['rivera'],                                             dept: 'Rivera' },
  { aliases: ['rocha'],                                              dept: 'Rocha' },
  { aliases: ['salto'],                                              dept: 'Salto' },
  { aliases: ['san jose de mayo', 'san jose'],                       dept: 'San Jose' },
  { aliases: ['mercedes'],                                           dept: 'Soriano' },
  { aliases: ['tacuarembo'],                                         dept: 'Tacuarembo' },
  { aliases: ['treinta y tres'],                                     dept: 'Treinta y Tres' },
];

// Major non-capital cities that are still strong, unambiguous signals.
const MAJOR_NON_CAPITAL_CITIES: Array<{ aliases: string[]; dept: string }> = [
  { aliases: ['punta del este'],             dept: 'Maldonado' },
  { aliases: ['san carlos'],                 dept: 'Maldonado' },
  { aliases: ['piriapolis'],                 dept: 'Maldonado' },
  { aliases: ['pan de azucar'],              dept: 'Maldonado' },
  { aliases: ['aigua'],                      dept: 'Maldonado' },
  { aliases: ['punta ballena'],              dept: 'Maldonado' },
  { aliases: ['la barra'],                   dept: 'Maldonado' },
  { aliases: ['manantiales'],                dept: 'Maldonado' },
  { aliases: ['jose ignacio'],               dept: 'Maldonado' },
  { aliases: ['young'],                      dept: 'Rio Negro' },
  { aliases: ['juan lacaze', 'juan l lacaze'], dept: 'Colonia' },
  { aliases: ['carmelo'],                    dept: 'Colonia' },
  { aliases: ['nueva palmira'],              dept: 'Colonia' },
  { aliases: ['nueva helvecia'],             dept: 'Colonia' },
  { aliases: ['tarariras'],                  dept: 'Colonia' },
  { aliases: ['rosario'],                    dept: 'Colonia' },
  { aliases: ['dolores'],                    dept: 'Soriano' },
  { aliases: ['cardona'],                    dept: 'Soriano' },
  { aliases: ['bella union'],                dept: 'Artigas' },
  { aliases: ['tomas gomensoro'],            dept: 'Artigas' },
  { aliases: ['paso de los toros'],          dept: 'Tacuarembo' },
  { aliases: ['san gregorio de polanco'],    dept: 'Tacuarembo' },
  { aliases: ['chuy'],                       dept: 'Rocha' },
  { aliases: ['la paloma', 'la pedrera', 'barra de valizas', 'punta del diablo', 'castillos', 'lascano'],
                                             dept: 'Rocha' },
  { aliases: ['guichon', 'quebracho'],       dept: 'Paysandu' },
  { aliases: ['tambores'],                   dept: 'Paysandu' },
  { aliases: ['tranqueras', 'vichadero', 'minas de corrales'],
                                             dept: 'Rivera' },
  { aliases: ['jose batlle y ordonez', 'jose pedro varela', 'solis de mataojo'],
                                             dept: 'Lavalleja' },
  { aliases: ['sarandi del yi', 'villa del carmen'],
                                             dept: 'Durazno' },
  { aliases: ['sarandi grande', 'casupa', '25 de agosto', '25 de mayo'],
                                             dept: 'Florida' },
  { aliases: ['vergara', 'santa clara de olimar'],
                                             dept: 'Treinta y Tres' },
  { aliases: ['isidoro noblia', 'fraile muerto', 'rio branco'],
                                             dept: 'Cerro Largo' },
  { aliases: ['constitucion', 'belen'],      dept: 'Salto' },
  // Canelones — big list because city autofill often hides these.
  // Ambiguous names (las piedras, la paz, toledo, las toscas) are deliberately
  // omitted because they also exist in other depts; AMBIGUOUS_LOCALITIES defers
  // those to the AI.
  { aliases: ['ciudad de la costa', 'pando', 'progreso',
              'barros blancos', 'joaquin suarez', 'sauce', 'santa lucia',
              'empalme olmos', 'tala', 'san ramon', 'san bautista', 'migues',
              'atlantida', 'solymar', 'lagomar', 'el pinar', 'neptunia', 'salinas',
              'parque del plata', 'la floresta', 'cuchilla alta',
              'marindia', 'pinamar', 'san luis', 'san jacinto', 'barra de carrasco',
              'paso carrasco', 'shangrila', 'paso de carrasco'],
                                             dept: 'Canelones' },
  // San José — same autofill problem. Ciudad del Plata lives HERE, not in Canelones.
  { aliases: ['ciudad del plata', 'delta del tigre', 'playa pascual',
              'rincon de la bolsa', 'libertad', 'rodriguez', 'ecilda paullier',
              'mal abrigo'],
                                             dept: 'San Jose' },
];

// ─── capitals that are ALSO common UY street names ─────────────────────
//
// Uruguay names its most important streets after national heroes and
// department capitals. Every town has an "Artigas" street (José Artigas,
// national hero), most have "Rivera" (Fructuoso Rivera), "Florida", "Salto",
// etc. If we scan address1 for these capitals we get a stampede of false
// positives because address1 is the STREET field ("Artigas 1234" = José
// Artigas street, not the department of Artigas).
//
// We still want these names to count when they appear in `city`, `address2`,
// or `orderNotes` — those fields are much more likely to carry a real locality
// mention. The `scanFieldsForUnambiguousCity` function filters this set out
// when scanning the address1 field specifically.
const CAPITALS_COMMON_AS_STREETS = new Set<string>([
  'artigas',          // national hero — EVERY town has an Artigas street
  'rivera',           // Fructuoso Rivera — very common street name
  'florida',          // also a common street name
  'rocha',            // family name + common street
  'salto',            // also "salto" can appear in addresses generically
  'durazno',          // generic word ("peach tree") + common street
  'maldonado',        // common street name in MVD (Calle Maldonado)
  'paysandu',         // common street name in Canelones / Colonia
  'melo',             // common street + surname (Juan Zorrilla de San Martín wrote "Melo") — regression H08
  'treinta y tres',   // the 33 Orientales liberated UY in 1825; every town has a Treinta y Tres street — regression D09
  'canelones',        // Calle Canelones is one of MVD's most central streets (barrio Centro / Cordón) — caught in real prod sample
  // Historical dates that are ALSO real town names in small depts but
  // overwhelmingly appear as street names in every UY city:
  '25 de agosto',     // Independence Day 1825 — street in every town; also a small Florida locality
  '25 de mayo',       // May Revolution — street + also a small Florida locality
  '19 de abril',      // Landing of the 33 Orientales — common street
  '18 de julio',      // Constitution Day — THE main avenue in MVD
]);

// ─── ambiguous names ────────────────────────────────────────────────────
//
// These names exist in 2+ departments. We DO NOT want the rules above to
// claim them — if we see one of these alone, we defer to AI.
const AMBIGUOUS_LOCALITIES = new Set<string>([
  'las piedras',         // Canelones (big) OR Artigas (small)
  'toledo',              // Canelones OR Cerro Largo
  'santa catalina',      // barrio MVD OR Soriano
  'la paz',              // Canelones OR Colonia
  'ituzaingo',           // barrio MVD OR San Jose
  'la paloma',           // Rocha (common) OR Durazno
  'cerro chato',         // Durazno, Florida, Paysandu, Treinta y Tres (4 depts!)
  'san antonio',         // Canelones, Rocha, Salto
  'bella vista',         // Maldonado OR Paysandu
  'agraciada',           // Colonia OR Soriano
  'las toscas',          // Canelones OR Tacuarembo
  'colonia',             // Colonia (dept capital suffix) OR Canelones prefixes (Colonia Nicolich, Colonia Lamas)
  'cerro pelado',        // Maldonado OR Rivera OR Artigas
  'villa maria',         // Rio Negro OR Paysandu
  'santa monica',        // Maldonado OR San Jose
  'algorta',             // Paysandu OR Rio Negro
  'merinos',             // Paysandu OR Rio Negro
  'arbolito',            // Cerro Largo OR Paysandu
  'laureles',            // Salto OR Tacuarembo
  'piedra sola',         // Paysandu OR Tacuarembo
  'quebracho',           // Cerro Largo OR Paysandu
  'castillos',           // Rocha (common) OR Soriano
  'cerrillada',          // Rivera OR other
]);

// ─── DAC city → dept index (built once) ────────────────────────────────

interface GeoDept { name: string; cities: Array<{ name: string }>; }
interface GeoData { departments: Record<string, GeoDept>; }

/**
 * Build an index: normalized city name → set of departments that contain it.
 * We only claim an "exact city match" decision when the name appears in
 * exactly ONE department.
 */
const CITY_TO_DEPTS: Map<string, Set<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const dept of Object.values((dacGeoMap as unknown as GeoData).departments)) {
    for (const c of dept.cities) {
      const k = norm(c.name);
      if (!k) continue;
      if (!out.has(k)) out.set(k, new Set());
      out.get(k)!.add(dept.name);
    }
  }
  return out;
})();

// ─── internal helpers ──────────────────────────────────────────────────

/**
 * Looks for a word-boundary match of any alias in the haystack.
 * Uses boundaries so "la paz" inside "mariano la paz" doesn't match, but
 * "vivo en la paz 123" does.
 */
function containsAnyAlias(haystack: string, aliases: string[]): string | null {
  const h = ` ${norm(haystack)} `;
  for (const a of aliases) {
    const pattern = ` ${a} `;
    if (h.includes(pattern)) return a;
  }
  return null;
}

/**
 * Check every address-like field for a capital-or-major-city match.
 * Skips ambiguous names. When scanning address1 (the street field), also
 * skips capitals that double as common UY street names (Artigas, Rivera,
 * etc.) to avoid "Artigas 1234" being read as the department of Artigas.
 *
 * Field order: [city, address1, address2, orderNotes]. We scan in this
 * order so the most locality-specific field wins first.
 */
function scanFieldsForUnambiguousCity(
  fields: string[],
  table: Array<{ aliases: string[]; dept: string }>,
): { dept: string; matched: string; field: string } | null {
  const FIELD_NAMES = ['city', 'address1', 'address2', 'orderNotes'];
  for (const [idx, field] of fields.entries()) {
    if (!field) continue;
    const fieldName = FIELD_NAMES[idx] ?? 'field';
    for (const entry of table) {
      const safeAliases = entry.aliases.filter((a) => {
        if (AMBIGUOUS_LOCALITIES.has(a)) return false;
        // Drop street-name capitals from address1 scan (see
        // CAPITALS_COMMON_AS_STREETS for rationale).
        if (fieldName === 'address1' && CAPITALS_COMMON_AS_STREETS.has(a)) return false;
        return true;
      });
      const hit = containsAnyAlias(field, safeAliases);
      if (hit) {
        return { dept: entry.dept, matched: hit, field: fieldName };
      }
    }
  }
  return null;
}

// ─── main entry ─────────────────────────────────────────────────────────

/**
 * Attempt to resolve the department from deterministic rules alone.
 * Returns null when the rules can't decide — the caller should then fall
 * back to the AI resolver.
 */
export function resolveDepartmentDeterministic(input: DeptInput): DeptResolution | null {
  const zip = (input.zip ?? '').trim();
  const fields = [input.city, input.address1, input.address2, input.orderNotes ?? ''];

  // Rule 1: ZIP prefix (strongest when present + well-formed)
  if (zip.length >= 4) {
    const prefix = zip.slice(0, 2);
    const zipDept = ZIP_PREFIX_TO_DEPT[prefix];
    if (zipDept) {
      // Don't claim high confidence on ZIP alone if one of the address
      // fields contradicts it — e.g. ZIP says MVD but address2 says
      // "Tacuarembó". In that case let rule 2 override.
      const capitalHit = scanFieldsForUnambiguousCity(fields, DEPT_CAPITALS);
      if (capitalHit && capitalHit.dept !== zipDept) {
        // contradiction — fall through and let the address-scan rule win
      } else {
        return {
          department: zipDept,
          confidence: 'high',
          matchedVia: 'zip',
          reason: `ZIP prefix ${prefix}xxx → ${zipDept}`,
        };
      }
    }
  }

  // Rule 2: capital-department city name anywhere in address (includes orderNotes)
  const capitalHit = scanFieldsForUnambiguousCity(fields, DEPT_CAPITALS);
  if (capitalHit) {
    return {
      department: capitalHit.dept,
      confidence: 'high',
      matchedVia: 'address-capital',
      reason: `Capital "${capitalHit.matched}" found in ${capitalHit.field}`,
    };
  }

  // Rule 3: major non-capital city (Punta del Este, Young, Ciudad de la Costa, etc.)
  const majorHit = scanFieldsForUnambiguousCity(fields, MAJOR_NON_CAPITAL_CITIES);
  if (majorHit) {
    return {
      department: majorHit.dept,
      confidence: 'high',
      matchedVia: 'address-major-city',
      reason: `Major city "${majorHit.matched}" found in ${majorHit.field}`,
    };
  }

  // Rule 4: exact match of city field against DAC city list (single-dept only)
  const cityNorm = norm(input.city);
  if (cityNorm) {
    if (cityNorm === 'montevideo') {
      return {
        department: 'Montevideo',
        confidence: 'high',
        matchedVia: 'city-exact-mvd',
        reason: 'city="Montevideo" and no interior signal',
      };
    }
    const ambiguous = AMBIGUOUS_LOCALITIES.has(cityNorm);
    if (!ambiguous) {
      const depts = CITY_TO_DEPTS.get(cityNorm);
      if (depts && depts.size === 1) {
        const only = [...depts][0];
        return {
          department: only,
          confidence: 'high',
          matchedVia: 'city-exact-unique',
          reason: `city="${input.city}" maps uniquely to ${only} in DAC`,
        };
      }
    }
  }

  // Rule 5: province field (Shopify province) — last-resort tie-breaker.
  // Shopify uses dept names in the province field, so a direct match is reliable.
  const provNorm = norm(input.province);
  if (provNorm) {
    for (const dept of Object.values((dacGeoMap as unknown as GeoData).departments)) {
      if (norm(dept.name) === provNorm) {
        return {
          department: dept.name,
          confidence: 'medium',
          matchedVia: 'province',
          reason: `Shopify province field = "${input.province}"`,
        };
      }
    }
  }

  // Rule 6: bail — caller falls back to AI
  return null;
}
