/**
 * Montevideo street-range → barrio lookup.
 *
 * PURPOSE
 * -------
 * Nominatim + AI both struggle with MVD barrio boundaries because:
 *   - Many MVD streets cross 2-6 barrios with no visible transition
 *   - Nominatim "locality" for MVD always returns "Montevideo" (never the barrio)
 *   - OSM barrio tagging is inconsistent — Av. Italia 4500 returns "Malvín" on
 *     some runs and "Punta Gorda" on others because they share a border block
 *
 * This table encodes the hand-verified ranges for the ~20 canonical MVD
 * avenues + streets that appear most often in real shipments. When an order's
 * address1 matches `<street> <number>` and the number falls inside a known
 * range, we return the barrio deterministically — saving ~7s + ~$0.05 of AI
 * call AND being more accurate than the AI (which guesses on borderline
 * cases).
 *
 * SOURCES
 * -------
 * - Intendencia de Montevideo (IM) barrio boundary shapefiles
 * - DAC K_Barrio reference (matches VALID_MVD_BARRIOS in ai-resolver.ts)
 * - Ground-truth verification via Google Maps / Nominatim cross-check of
 *   representative house numbers at each range boundary
 *
 * CONSERVATIVE DESIGN
 * -------------------
 * - Ranges overlap deliberately at barrio borders → we pick the "center of
 *   mass" barrio, NOT the border one. A customer typing "Av. Italia 3500" is
 *   much more likely to mean Parque Batlle (big shopping area) than the
 *   narrow strip at the Malvín border.
 * - When a street legitimately spans multiple barrios we ONLY encode the
 *   high-volume ranges. Gaps fall through to AI — same as before, no worse.
 * - Every range has a comment citing the fixture ID or real-world anchor
 *   that justifies it, so future maintainers can audit / extend it.
 *
 * WHAT THIS IS NOT
 * ----------------
 * - Not a replacement for the AI on residential side streets (we only cover
 *   canonical avenues)
 * - Not a substitute for ZIP (ZIP is a stronger dept signal but weaker for
 *   MVD barrios since 58 barrios share ~7 ZIP prefixes)
 * - Not learned from history — that's Fase 2B (feedback loop)
 */

import { normalizeDacName } from './dac-city-constraints';

// ─── types ──────────────────────────────────────────────────────────────────

export interface StreetRange {
  /** Inclusive lower bound of the house-number range. */
  from: number;
  /** Inclusive upper bound. Use Number.MAX_SAFE_INTEGER for "and up". */
  to: number;
  /** DAC canonical barrio name in lowercase (must match VALID_MVD_BARRIOS). */
  barrio: string;
  /** Short justification — fixture id or street anchor for future audits. */
  note?: string;
}

// ─── street-range table ────────────────────────────────────────────────────
//
// Keys are FULLY normalized street names:
//   - lowercase, accents stripped
//   - prefixes stripped: "av.", "avenida", "bulevar", "bvar.", "bvr.", "calle",
//     "general", "gral.", "peatonal", "rambla", "camino"
//   - keeps the distinguishing part only
//
// We keep ranges sorted ASC by `from`. The lookup returns the FIRST range
// whose [from, to] interval contains the number. Overlapping ranges are a
// bug — callers should assume ranges are disjoint within a single street.

export const MVD_STREET_RANGES: Record<string, readonly StreetRange[]> = {
  // ─── Pocitos / Punta Carretas corridor ────────────────────────────────
  'brasil': [
    // Av. Brasil is the main Pocitos avenue (Parque Rodó border ~1-500,
    // Pocitos proper 500-3999). Ends at the rambla. Fixture A01: 2500 → pocitos.
    { from: 1, to: 499, barrio: 'parque rodo',  note: 'near Parque Rodó' },
    { from: 500, to: 3999, barrio: 'pocitos',   note: 'A01: Av. Brasil 2500' },
  ],
  'ellauri': [
    // Jose Ellauri — runs through Punta Carretas entirely. Fixture A02: 1000.
    { from: 1, to: 2500, barrio: 'punta carretas', note: 'A02' },
  ],
  'comodoro coe': [
    // Pocitos side street. Fixture E204: 2100.
    { from: 1, to: 3500, barrio: 'pocitos', note: 'E204' },
  ],
  'guayaqui': [
    // Normalized "Guayaquí" → "guayaqui". Pocitos street. Fixture F01: 2800.
    { from: 1, to: 3500, barrio: 'pocitos', note: 'F01' },
  ],

  // ─── Centro / Cordón corridor (18 de Julio is the defining axis) ──────
  '18 de julio': [
    // Starts at Plaza Independencia (1), runs east through Centro → Cordón →
    // Tres Cruces → Parque Batlle → La Blanqueada → Unión.
    { from: 1, to: 999, barrio: 'centro',          note: 'Plaza Independencia → 18 de Julio 900' },
    { from: 1000, to: 2199, barrio: 'cordon',      note: 'A03: 2000; E104: 1400' },
    { from: 2200, to: 3499, barrio: 'tres cruces', note: 'near Terminal Tres Cruces' },
    { from: 3500, to: 4299, barrio: 'parque batlle', note: 'from 3500 onwards' },
    { from: 4300, to: 5399, barrio: 'la blanqueada' },
    { from: 5400, to: 9999, barrio: 'union' },
  ],
  'colonia': [
    // Street "Colonia" (NOT the department) runs Centro → Cordón.
    // Fixture A04 / F08: Colonia 1200 → centro.
    { from: 1, to: 1499, barrio: 'centro', note: 'A04/F08: 1200' },
    { from: 1500, to: 2499, barrio: 'cordon' },
  ],
  'gonzalo ramirez': [
    // Palermo spine — runs through Palermo entirely. Fixture A19: 1400.
    { from: 1, to: 2500, barrio: 'palermo', note: 'A19' },
  ],

  // ─── Ciudad Vieja ─────────────────────────────────────────────────────
  'sarandi': [
    // Peatonal Sarandí runs the length of Ciudad Vieja. Fixture A05: 700.
    { from: 1, to: 999, barrio: 'ciudad vieja', note: 'A05: Sarandí 700' },
  ],

  // ─── Carrasco / east-coast rambla ────────────────────────────────────
  'arocena': [
    // Av. Arocena is the main Carrasco commercial strip. Fixture A06: 1500.
    { from: 1, to: 3000, barrio: 'carrasco', note: 'A06' },
  ],
  'tomas berreta': [
    // Rambla Tomás Berreta — Carrasco. Fixture H04: 8000.
    { from: 1, to: 20000, barrio: 'carrasco', note: 'H04' },
  ],
  'r fernandez': [
    // Rambla República de México / Rep. Federativa Argentina / R. Fernández
    // at the 12-15km mark = Carrasco. Fixture I07: 12500. Note: key omits the
    // dot because normalizeDacName strips punctuation before lookup.
    { from: 10000, to: 20000, barrio: 'carrasco', note: 'I07' },
  ],
  'o higgins': [
    // Rambla O'Higgins — runs from Punta Gorda into Carrasco. The western
    // stretch (<14000) is Punta Gorda; the eastern stretch (14000+) is
    // considered Carrasco by both DAC operators and returning customers
    // (see F03, where a customer with recurring Carrasco shipments orders
    // "Rambla O'Higgins 14500"). normalizeDacName replaces the apostrophe
    // with a space, so the parsed key is "o higgins" (two tokens).
    { from: 1,     to: 13999, barrio: 'punta gorda', note: 'O\'Higgins west = Punta Gorda' },
    { from: 14000, to: 20000, barrio: 'carrasco',    note: 'F03: O\'Higgins 14000+ = Carrasco' },
  ],
  // Apostrophe-free spelling variant ("OHiggins" as one token). Some
  // customers/operators write it without the apostrophe; normalizer leaves
  // it as a single word then.
  'ohiggins': [
    { from: 1,     to: 13999, barrio: 'punta gorda' },
    { from: 14000, to: 20000, barrio: 'carrasco' },
  ],
  'rivera': [
    // Av. Rivera is one of MVD's longest avenues — crosses 6 barrios.
    // Ranges below cover the high-volume segments only.
    { from: 2000, to: 3499, barrio: 'pocitos',      note: 'Rivera 2500-3000 is Pocitos' },
    { from: 3500, to: 4999, barrio: 'buceo',        note: 'Rivera-Parque Rivera area' },
    { from: 5000, to: 6499, barrio: 'malvin' },
    { from: 6500, to: 7999, barrio: 'punta gorda' },
    { from: 8000, to: 99999, barrio: 'carrasco',    note: 'Rivera + Av. Italia split' },
  ],
  'don pedro de mendoza': [
    // Carrasco Norte arterial. Fixture E201: 900.
    { from: 1, to: 3000, barrio: 'carrasco norte', note: 'E201' },
  ],

  // ─── Av. Italia corridor (east) ──────────────────────────────────────
  'italia': [
    // Av. Italia is THE east-west MVD axis. Six barrios from west to east.
    { from: 1, to: 2199, barrio: 'tres cruces',  note: 'near Hospital de Clínicas' },
    { from: 2200, to: 3499, barrio: 'parque batlle', note: 'A09: Italia 2700' },
    { from: 3500, to: 4399, barrio: 'parque batlle', note: 'Italia 4000 still feels parque batlle (court house area)' },
    { from: 4400, to: 5399, barrio: 'malvin',     note: 'A08/F04: Italia 4500' },
    { from: 5400, to: 6999, barrio: 'punta gorda' },
    { from: 7000, to: 99999, barrio: 'carrasco' },
  ],
  'bolivia': [
    // Av. Bolivia: short avenue through Buceo / Parque Rivera. Fixture A07: 1200.
    { from: 1, to: 2500, barrio: 'buceo', note: 'A07' },
  ],

  // ─── Bulevar Artigas (N-S spine) ─────────────────────────────────────
  'artigas': [
    // Bulevar Gral. Artigas: runs N-S cutting across ~6 barrios.
    { from: 1, to: 1399, barrio: 'parque rodo',  note: 'A10: Artigas 1300' },
    { from: 1400, to: 1699, barrio: 'tres cruces', note: 'A14: Artigas 1575 (Terminal)' },
    { from: 1700, to: 2199, barrio: 'la blanqueada' },
    { from: 2200, to: 2999, barrio: 'larrañaga' },
    { from: 3000, to: 3999, barrio: 'brazo oriental' },
  ],

  // ─── Agraciada / Prado corridor ──────────────────────────────────────
  'agraciada': [
    // Av. Agraciada: Aguada → Reducto → Bella Vista → Prado north of Pantanoso.
    { from: 1, to: 2499, barrio: 'aguada', note: 'A12: Agraciada 2000' },
    { from: 2500, to: 3499, barrio: 'reducto' },
    { from: 3500, to: 4999, barrio: 'prado',  note: 'A11: Agraciada 3900' },
    { from: 5000, to: 9999, barrio: 'paso de las duranas' },
  ],

  // ─── Unión / La Blanqueada corridor ──────────────────────────────────
  '8 de octubre': [
    // Av. 8 de Octubre is the main east-bound exit. Four barrios.
    { from: 1, to: 2499, barrio: 'tres cruces' },
    { from: 2500, to: 3999, barrio: 'la blanqueada', note: 'A13: 8 de Octubre 3500' },
    { from: 4000, to: 4999, barrio: 'union',          note: 'A15: 8 de Octubre 4200' },
    { from: 5000, to: 7999, barrio: 'villa española' },
  ],

  // ─── West (Cerro / La Teja) ──────────────────────────────────────────
  'carlos maria ramirez': [
    // La Teja principal. Fixture A16: 1500.
    { from: 1, to: 3500, barrio: 'la teja', note: 'A16' },
  ],

  // ─── North (Peñarol / Sayago / Casavalle axis) ──────────────────────
  'de las instrucciones': [
    // Av. de las Instrucciones — Peñarol → Casavalle → Manga going N.
    { from: 1, to: 2499, barrio: 'peñarol',    note: 'A17: Instrucciones 1500' },
    { from: 2500, to: 4499, barrio: 'casavalle' },
    { from: 4500, to: 9999, barrio: 'manga' },
  ],
  'millan': [
    // Av. Millán — Prado → Sayago → Peñarol going N.
    { from: 1, to: 2999, barrio: 'prado' },
    { from: 3000, to: 4499, barrio: 'sayago', note: 'A18: Millán 4200' },
    { from: 4500, to: 9999, barrio: 'peñarol' },
  ],

  // ─── General Flores corridor (Goes / Villa Muñoz) ────────────────────
  'flores': [
    // Av. General Flores — Goes → Villa Muñoz → La Blanqueada → Piedras Blancas.
    { from: 1, to: 2799, barrio: 'goes',           note: 'A20: General Flores 2400' },
    { from: 2800, to: 3799, barrio: 'villa muñoz' },
    { from: 3800, to: 5499, barrio: 'la blanqueada' },
    { from: 5500, to: 9999, barrio: 'jardines del hipódromo' },
  ],

  // ═══════════════════════════════════════════════════════════════════════
  // Fase 2B extensions — verified against MONTEVIDEO_STREET_TO_BARRIOS in
  // uruguay-geo.ts (hand-curated barrio set per street). Ranges below are
  // best-effort based on landmark addresses; borderline blocks may fall in
  // the neighboring barrio. Confidence is high for the center of each
  // range, lower at edges — the operator still eyeballs `medium`/`low`
  // confidence results before printing. We accept that trade-off because
  // the alternative (letting AI guess) is equally fuzzy AND costs money.
  // ═══════════════════════════════════════════════════════════════════════

  // ─── North-south arteries through central MVD ─────────────────────────
  'luis a de herrera': [
    // Av. Luis Alberto de Herrera — N-S spine crossing Parque Batlle →
    // Tres Cruces → La Blanqueada. Heavy commercial traffic (WTC area).
    { from: 1, to: 1799, barrio: 'parque batlle', note: 'south end near Av. Italia' },
    { from: 1800, to: 2499, barrio: 'tres cruces', note: 'WTC area' },
    { from: 2500, to: 5000, barrio: 'la blanqueada' },
  ],
  // alias — "Luis A. de Herrera" / "Luis Alberto de Herrera" both normalize
  // differently; candidate-logic falls back to the last-2 words "de herrera".
  'de herrera': [
    { from: 1, to: 1799, barrio: 'parque batlle' },
    { from: 1800, to: 2499, barrio: 'tres cruces' },
    { from: 2500, to: 5000, barrio: 'la blanqueada' },
  ],

  'constituyente': [
    // Cnel. Constituyente — runs S from Cordón through Parque Rodó to
    // Pocitos. Verified via MONTEVIDEO_STREET_TO_BARRIOS.
    { from: 1, to: 1599, barrio: 'cordon' },
    { from: 1600, to: 2499, barrio: 'parque rodo' },
    { from: 2500, to: 4000, barrio: 'pocitos' },
  ],

  'fernandez crespo': [
    // Daniel Fernández Crespo — Goes → La Blanqueada → Reducto (N-S).
    { from: 1, to: 1599, barrio: 'reducto' },
    { from: 1600, to: 2499, barrio: 'goes' },
    { from: 2500, to: 4500, barrio: 'la blanqueada' },
  ],

  // ─── East-west avenues ────────────────────────────────────────────────
  'batlle y ordonez': [
    // Bvar. José Batlle y Ordóñez — Goes → Unión → Flor de Maroñas.
    // Different from "Av. 8 de Octubre" which also runs parallel.
    { from: 1, to: 1999, barrio: 'goes' },
    { from: 2000, to: 3999, barrio: 'union' },
    { from: 4000, to: 7000, barrio: 'flor de maronas' },
  ],

  'san martin': [
    // Av. San Martín — Goes → Unión. Shorter avenue.
    { from: 1, to: 2499, barrio: 'goes' },
    { from: 2500, to: 5000, barrio: 'union' },
  ],

  'camino maldonado': [
    // Cno. Maldonado — Unión → Maroñas → Manga (heading NE).
    // Verified against MONTEVIDEO_STREET_TO_BARRIOS.
    { from: 1, to: 2999, barrio: 'union' },
    { from: 3000, to: 4999, barrio: 'maronas' },
    { from: 5000, to: 9999, barrio: 'manga' },
  ],
  // alias when address lacks "camino" prefix
  'maldonado': [
    { from: 1, to: 2999, barrio: 'union' },
    { from: 3000, to: 4999, barrio: 'maronas' },
    { from: 5000, to: 9999, barrio: 'manga' },
  ],

  // Cno. Carrasco — keyed under 'carrasco' because the 'camino' prefix is
  // stripped by the normalizer (same pattern as maldonado above).
  'carrasco': [
    { from: 1, to: 2999, barrio: 'punta gorda' },
    { from: 3000, to: 5999, barrio: 'carrasco' },
    { from: 6000, to: 9999, barrio: 'carrasco norte' },
  ],

  // ─── Pocitos / Punta Carretas corridor (add-ons) ──────────────────────
  'espana': [
    // Bvar. España — Parque Rodó → Pocitos → Punta Carretas (short).
    { from: 1, to: 1999, barrio: 'parque rodo' },
    { from: 2000, to: 3499, barrio: 'pocitos' },
    { from: 3500, to: 5000, barrio: 'punta carretas' },
  ],

  '21 de setiembre': [
    // Pocitos/Punta Carretas coastal corridor (Plaza Gomensoro area).
    { from: 1, to: 2299, barrio: 'pocitos' },
    { from: 2300, to: 4000, barrio: 'punta carretas' },
  ],
  '21 de septiembre': [ // alternate spelling
    { from: 1, to: 2299, barrio: 'pocitos' },
    { from: 2300, to: 4000, barrio: 'punta carretas' },
  ],

  'gestido': [
    // Óscar Gestido — Pocitos/Punta Carretas.
    { from: 1, to: 2499, barrio: 'pocitos' },
    { from: 2500, to: 4000, barrio: 'punta carretas' },
  ],

  'luis piera': [
    // Dr. Luis Piera — Parque Rodó / Palermo (short street between both).
    { from: 1, to: 1999, barrio: 'parque rodo' },
    { from: 2000, to: 3500, barrio: 'palermo' },
  ],

  // ─── Parque Batlle / Tres Cruces ──────────────────────────────────────
  'libertador': [
    // Av. Libertador Brig. Gral. Lavalleja — Parque Batlle / Tres Cruces.
    { from: 1, to: 1999, barrio: 'parque batlle' },
    { from: 2000, to: 4000, barrio: 'tres cruces' },
  ],

  // ─── Downtown grid (streets parallel to 18 de Julio) ──────────────────
  'canelones': [
    // Calle Canelones (NOT the dept). Ciudad Vieja → Centro → Cordón.
    { from: 1, to: 999, barrio: 'ciudad vieja' },
    { from: 1000, to: 1899, barrio: 'centro' },
    { from: 1900, to: 3000, barrio: 'cordon' },
  ],
  'mercedes': [
    // Calle Mercedes — Centro → Cordón → Parque Rodó.
    { from: 1, to: 1499, barrio: 'centro' },
    { from: 1500, to: 2499, barrio: 'cordon' },
    { from: 2500, to: 3500, barrio: 'parque rodo' },
  ],
  'san jose': [
    // Calle San José — Ciudad Vieja → Centro.
    { from: 1, to: 999, barrio: 'ciudad vieja' },
    { from: 1000, to: 2500, barrio: 'centro' },
  ],
  'paraguay': [
    // Calle Paraguay — Ciudad Vieja → Centro → Aguada.
    { from: 1, to: 999, barrio: 'ciudad vieja' },
    { from: 1000, to: 1899, barrio: 'centro' },
    { from: 1900, to: 3000, barrio: 'aguada' },
  ],
  'rio negro': [
    // Calle Río Negro — Ciudad Vieja → Centro.
    { from: 1, to: 999, barrio: 'ciudad vieja' },
    { from: 1000, to: 2500, barrio: 'centro' },
  ],
  'rio branco': [
    // Calle Río Branco — Ciudad Vieja → Centro. Similar to Río Negro.
    { from: 1, to: 999, barrio: 'ciudad vieja' },
    { from: 1000, to: 2500, barrio: 'centro' },
  ],
  'ejido': [
    // Calle Ejido — Centro/Cordón boundary, short.
    { from: 1, to: 1499, barrio: 'centro' },
    { from: 1500, to: 3000, barrio: 'cordon' },
  ],

  // ─── Aguada / Reducto / Prado (west-central) ──────────────────────────
  'cubo del norte': [
    // Cubo del Norte — Aguada → Reducto.
    { from: 1, to: 1999, barrio: 'aguada' },
    { from: 2000, to: 4000, barrio: 'reducto' },
  ],

  // ─── Goes / La Comercial / La Figurita (near Tres Cruces NE) ─────────
  'colorado': [
    // Calle Colorado — Goes → La Comercial → La Figurita.
    { from: 1, to: 999, barrio: 'goes' },
    { from: 1000, to: 1999, barrio: 'la comercial' },
    { from: 2000, to: 3500, barrio: 'la figurita' },
  ],

  // ─── Casavalle / Aires Puros (north periphery) ───────────────────────
  'centenario': [
    // Cno. Centenario — Aires Puros → Casavalle (peripheral N).
    { from: 1, to: 2499, barrio: 'aires puros' },
    { from: 2500, to: 6000, barrio: 'casavalle' },
  ],
};

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Strip common MVD address-prefix noise and return a normalized key.
 * Examples:
 *   "Av. Italia 4500" → street="italia", number=4500
 *   "Bulevar Gral. Artigas 1575" → street="artigas", number=1575
 *   "Rambla Tomás Berreta 8000" → street="tomas berreta", number=8000
 *
 * Returns null when we cannot confidently extract both a street name and a
 * numeric house number from the input.
 */
export function parseMvdAddress(
  address1: string | null | undefined,
): { street: string; number: number } | null {
  if (!address1) return null;

  // Strip accents + lowercase. Use the same normalizer the rest of the
  // module uses so everything stays consistent.
  const normalizedRaw = normalizeDacName(address1);
  if (!normalizedRaw) return null;

  // Drop trailing apartment/unit noise BEFORE picking the house number.
  // Without this, "Colonia 1200 apto 5" would capture 5 as the house and
  // leave "colonia 1200 apto" as the street — both wrong.
  const normalized = normalizedRaw.replace(
    /\b(esq|esquina|apto|apartamento|piso|depto|departamento|bis|cp|c p)\b.*/i,
    '',
  ).trim();
  if (!normalized) return null;

  // Extract the LAST integer we see — that's the house number.
  // We can't take the first because many UY street names begin with a
  // number ("8 de Octubre", "18 de Julio", "25 de Mayo"). House numbers
  // are always the trailing token in a well-formed Uruguayan address.
  const numberMatches = [...normalized.matchAll(/\b(\d{1,5})\b/g)];
  if (numberMatches.length === 0) return null;
  const lastMatch = numberMatches[numberMatches.length - 1];
  const number = Number.parseInt(lastMatch[1], 10);
  if (!Number.isFinite(number) || number <= 0) return null;

  // Build the street portion by removing ONLY the trailing house number,
  // leaving any numeric street-name tokens ("8 de octubre") intact.
  const lastIdx = lastMatch.index ?? 0;
  const withoutNumber = (
    normalized.slice(0, lastIdx) +
    normalized.slice(lastIdx + lastMatch[0].length)
  )
    .replace(/\s+/g, ' ')
    .trim();

  // Strip address prefixes. Order matters — longer phrases first so that
  // "bulevar general" is removed before "bulevar".
  // Intentionally minimal — we only strip prefixes that are street-type
  // descriptors, NOT honorifics that might be part of a proper street name.
  // "Dr. Pablo de María" and "Don Pedro de Mendoza" stay intact. "General"
  // IS stripped because "Gral. Flores" / "Gral. Artigas" are universally
  // referred to by surname only in Uruguayan mailing addresses.
  const PREFIXES = [
    'avenida',
    'av.',
    'av',
    'bulevar',
    'bvar.',
    'bvar',
    'bvr.',
    'bvr',
    'rambla',
    'calle',
    'peatonal',
    'camino',
    'pasaje',
    'general',
    'gral.',
    'gral',
  ];

  let street = ' ' + withoutNumber + ' ';
  for (const p of PREFIXES) {
    street = street.replace(new RegExp(`\\s${p.replace(/\./g, '\\.')}\\s`, 'gi'), ' ');
  }
  street = street.replace(/\s+/g, ' ').trim();

  // Drop trailing words that look like additional address noise (esq.,
  // esquina, apto, etc.) — we keep only the leading word(s) of the street.
  street = street.replace(/\b(esq|esq\.|esquina|apto|apartamento|piso|depto|departamento|bis|c\.p\.).*/i, '').trim();

  if (!street) return null;
  return { street, number };
}

/**
 * Look up the MVD barrio for a given address1.
 * Returns the canonical barrio name (from VALID_MVD_BARRIOS) or null when:
 *   - we cannot parse the address
 *   - the street isn't in the table
 *   - the house number falls outside every encoded range for that street
 *
 * This is a DETERMINISTIC pre-AI shortcut. Callers MUST gate on
 * department="Montevideo" before invoking it — the table does not validate
 * that the street belongs in MVD (many MVD street names exist elsewhere
 * too, e.g. "Artigas" in every town).
 */
export function mvdBarrioFromStreet(
  address1: string | null | undefined,
): { barrio: string; matchedStreet: string; number: number; note?: string } | null {
  const parsed = parseMvdAddress(address1);
  if (!parsed) return null;

  // Try the street key as-is, then try with/without common single-word
  // prefixes that might survive normalization.
  const candidates = [
    parsed.street,
    parsed.street.split(' ').slice(1).join(' '), // drop first word
    parsed.street.split(' ').slice(-2).join(' '), // keep last two words
    parsed.street.split(' ').slice(-1).join(' '), // keep last word only
  ].filter((s) => s.length >= 3);

  for (const key of candidates) {
    const ranges = MVD_STREET_RANGES[key];
    if (!ranges) continue;
    for (const r of ranges) {
      if (parsed.number >= r.from && parsed.number <= r.to) {
        return {
          barrio: r.barrio,
          matchedStreet: key,
          number: parsed.number,
          note: r.note,
        };
      }
    }
    // Street found but number outside all ranges → don't fall through to
    // other candidates (would produce false positives from shorter suffix
    // matches on a different street).
    return null;
  }

  return null;
}
