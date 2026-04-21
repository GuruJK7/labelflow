/**
 * Deterministic city resolver for interior (non-Montevideo) departments.
 *
 * Runs AFTER the department has been fixed by `resolveDepartmentDeterministic`.
 * Its job is to pick the DAC canonical city name (the exact string that
 * appears in DAC's "ciudad" dropdown) for the given department, using only
 * the customer's own input — no AI.
 *
 * Decision order:
 *   1. `canonicalizeCityName(dept, input.city)` — exact-after-normalize.
 *      Handles the 95% case where Shopify's city already matches DAC
 *      (modulo accents/casing). "Colonia del Sacramento" → "Colonia Del
 *      Sacramento", "Paysandú" → "Paysandu", etc.
 *
 *   2. Scan every address field (address1, address2, orderNotes) for any
 *      DAC canonical city in the target department. Picks the LONGEST
 *      match, so "San Jose de Mayo" wins over "San Jose" if both appear.
 *      This catches customers who typed the department name in `city`
 *      (e.g. city="Colonia") but the real locality in address2
 *      (e.g. address2="Juan Lacaze").
 *
 *   3. Return null → caller falls back to AI or leaves the field blank.
 *
 * Montevideo is handled by the caller (there is only one "city" in DAC for
 * dept=Montevideo, which is "Montevideo" itself). This module never returns
 * a Montevideo result.
 */

import {
  DAC_DEPT_TO_CITY_NAMES,
  canonicalizeCityName,
  normalizeDacName,
} from './dac-city-constraints';

// ─── types ─────────────────────────────────────────────────────────────

export interface CityInput {
  city: string;
  address1: string;
  address2: string;
  orderNotes?: string;
}

export interface CityResolution {
  /** DAC canonical city name (exact spelling from the DAC dropdown). */
  city: string;
  confidence: 'high' | 'medium' | 'low';
  matchedVia: 'city-exact' | 'address-scan';
  /** Which field or value yielded the match. Useful for audit + debugging. */
  reason: string;
}

// ─── address-scan index (built once per module load) ───────────────────
//
// Flattens DAC_DEPT_TO_CITY_NAMES into a per-dept list of
// { normalized-name, canonical-name } pairs, sorted by length DESC. This
// lets us scan a haystack field with a "prefer the longest match" rule:
// "San Jose de Mayo" is picked over "San Jose" whenever both match.

interface ScanEntry {
  norm: string;
  canonical: string;
}
const DEPT_SCAN_INDEX: Record<string, ScanEntry[]> = (() => {
  const out: Record<string, ScanEntry[]> = {};
  for (const [dept, cities] of Object.entries(DAC_DEPT_TO_CITY_NAMES)) {
    const entries = cities
      .map((name) => ({ norm: normalizeDacName(name), canonical: name }))
      .filter((e) => e.norm.length >= 3); // drop noise like "" or single chars
    // Longest first so "san jose de mayo" wins over "san jose" inside scan.
    entries.sort((a, b) => b.norm.length - a.norm.length);
    out[dept] = entries;
  }
  return out;
})();

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Word-boundary contains check on a pre-normalized haystack. Padding the
 * haystack and needle with spaces guarantees we only match on full word
 * boundaries — "colonia" does NOT match "colonial", "pan" does NOT match
 * "panama", etc.
 */
function containsAsWord(haystackNorm: string, needleNorm: string): boolean {
  if (!needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}

// ─── main entry ─────────────────────────────────────────────────────────

/**
 * Resolve the DAC canonical city name for an order, given that the
 * department has already been fixed. Returns null when neither the `city`
 * field nor any address field contains a recognizable DAC city for that
 * department.
 */
export function resolveCityDeterministic(
  department: string,
  input: CityInput,
): CityResolution | null {
  if (!department || department === 'Montevideo') {
    // Montevideo has a single DAC "city" (itself). The caller is expected
    // to set city="Montevideo" directly. We don't handle it here because
    // the interesting work for MVD is barrio resolution, not city.
    return null;
  }

  // Rule 1: exact-after-normalize on the Shopify city field.
  const canon = canonicalizeCityName(department, input.city ?? '');
  if (canon) {
    return {
      city: canon,
      confidence: 'high',
      matchedVia: 'city-exact',
      reason: `city="${input.city}" matches DAC "${canon}" in ${department}`,
    };
  }

  // Rule 2: scan address fields for any DAC city in this dept.
  const scanList = DEPT_SCAN_INDEX[department];
  if (!scanList || scanList.length === 0) {
    return null;
  }

  const fields: Array<{ name: string; value: string }> = [
    { name: 'city', value: input.city ?? '' },
    { name: 'address1', value: input.address1 ?? '' },
    { name: 'address2', value: input.address2 ?? '' },
    { name: 'orderNotes', value: input.orderNotes ?? '' },
  ];

  for (const f of fields) {
    if (!f.value) continue;
    const hayNorm = normalizeDacName(f.value);
    if (!hayNorm) continue;
    // scanList is pre-sorted longest-first, so the first hit is the best.
    for (const entry of scanList) {
      if (containsAsWord(hayNorm, entry.norm)) {
        return {
          city: entry.canonical,
          confidence: f.name === 'city' ? 'high' : 'medium',
          matchedVia: 'address-scan',
          reason: `DAC city "${entry.canonical}" found in ${f.name}`,
        };
      }
    }
  }

  return null;
}
