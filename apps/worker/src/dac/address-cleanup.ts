/**
 * Address-quality preprocessor for the DAC pipeline.
 *
 * Audit 2026-05-06 — DAC's submit form silently rejects (URL stays on
 * /envios/nuevo, no error box, no guía created) when the customer's
 * address has structural issues that DAC's parser cannot interpret:
 *
 *   - "Asencio1666"       — no space between street and number
 *   - "La Paloma"         — only the city name, no street + number
 *   - "Calle X 123 4-A"   — extra fragments DAC chokes on (rare)
 *
 * These pre-deterministic-resolver fixes cheaply turn unparseable
 * customer input into something DAC accepts, without involving the
 * AI resolver (saves cost + latency) and without burning a guía that
 * DAC won't ever return.
 *
 * Pure functions: no DB, no Playwright, no logger. Easy to unit-test.
 *
 * Production cases this module addresses:
 *   #11733 Silvia Aranda  — address1 "Asencio1666"           → "Asencio 1666"
 *   #11724 Marcela Pascal — address1 "La Paloma"             → no number → fail early
 *   #11705 Valeria Ramírez — handled separately by city-typo correction
 *   #11748 naza fernandez  — handled separately by city-equals-dept correction
 */

/**
 * Insert a space between consecutive letter+digit pairs in an address.
 * Handles the most common malformation: customers concatenating street
 * and house number without a space ("Asencio1666", "Rondeau345b").
 *
 * Conservative: only inserts space at letter→digit transitions (where
 * we are highly confident a street name ends and a number begins).
 * Does NOT split digit→letter transitions ("3a" stays together — that's
 * usually a unit suffix like "3a piso").
 *
 * Idempotent: running on already-spaced "Asencio 1666" produces
 * "Asencio 1666" (unchanged).
 *
 * Examples:
 *   "Asencio1666"             → "Asencio 1666"
 *   "Asencio 1666"            → "Asencio 1666"          (no-op)
 *   "Av Italia 4500"          → "Av Italia 4500"        (no-op)
 *   "Av.Bolivia2338"          → "Av.Bolivia 2338"
 *   "Calle Principal100"      → "Calle Principal 100"
 *   "8 de Octubre1234"        → "8 de Octubre 1234"
 *   "Rondeau345 bis"          → "Rondeau 345 bis"
 *   "9 de Junio s/n"          → "9 de Junio s/n"        (no-op)
 *   ""                        → ""                       (empty stays empty)
 *   null                      → ""                       (null safety)
 *   undefined                 → ""
 */
export function normalizeStreetNumberSpacing(
  address1: string | null | undefined,
): string {
  if (!address1) return '';
  // Insert a single space between any non-digit-non-space character
  // followed by a digit. Using `[^\d\s]` (instead of `[a-zA-Z]`) so
  // accented chars and the dot in "Av.Bolivia" also trigger the split.
  let out = address1.replace(/([^\d\s])(\d)/g, '$1 $2');
  // Collapse any runs of whitespace into a single space (preserve
  // intentional double-spaces in obs / "esquina XYZ" wording).
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Returns true if the given address looks like it has NO usable street
 * number — only a city name or a totally bare token. DAC requires a
 * numeric street number to create a guía; submitting the form without
 * one causes a silent rejection that costs us a wasted form attempt.
 *
 * Heuristic: an address is "missing-number" if, after normalization,
 * it contains no digit characters anywhere. We deliberately keep this
 * narrow so we don't false-positive on legitimate "s/n" addresses
 * (which DAC sometimes accepts — let those through and let DAC decide).
 *
 * Examples:
 *   "La Paloma"                      → true   (no digits)
 *   "Av. del Mar"                    → true   (no digits)
 *   "Asencio1666"                    → false  (has digits)
 *   "Asencio 1666"                   → false  (has digits)
 *   "8 de Octubre 1234"              → false  (has digits)
 *   "Calle X s/n"                    → true   (no digits — but rare/edge case)
 *   ""                               → true   (empty is missing)
 *   null                             → true
 *
 * NOTE on "s/n" (sin número): rural Uruguay addresses do occasionally
 * use this. We currently flag those as missing-number — operator must
 * contact customer to get the actual number or the closest landmark.
 * If "s/n" volume turns out to be high we can relax this later.
 */
export function isAddressMissingStreetNumber(
  address1: string | null | undefined,
): boolean {
  if (!address1) return true;
  return !/\d/.test(address1);
}

/**
 * 2026-05-12 — broader "address is incomplete" check than the bare-digit
 * heuristic above.
 *
 * Production trigger: orders like
 *   - "Av aigua esquina camino de los gauchos"   (Alfonsina Garibotti)
 *   - "Batlle Entre 18 De Julio Y Lubkov"        (Grace Gurin)
 *   - "Calle Principal casi Mercado"             (generic case)
 * DON'T have a building number, but the original
 * isAddressMissingStreetNumber() returned false on the Grace case
 * because "18" appears in the cross-street name "18 De Julio". DAC then
 * silently rejected the submission because there's no actual building
 * number on the form's K_Direccion field.
 *
 * This second detector catches the cross-street-without-building-number
 * pattern:
 *   1. The address contains a known cross-street keyword
 *      ("esquina", "entre", "casi", " y " mid-address).
 *   2. After stripping common Uruguayan street-name digit patterns
 *      (e.g. "18 de Julio", "33 Orientales", "8 de Octubre", "26 de
 *      Marzo", "21 de Septiembre", "9 de Junio", "1 de Mayo"), no
 *      digits remain. That means whatever digit was there belonged to
 *      a street name, not a building number.
 *
 * The caller treats this the same way as the original
 * missingStreetNumber flag — invokes ai-feasibility, falls through to
 * ship-with-note when AI can't recover, includes the customer phone
 * in the operator note.
 *
 * Examples:
 *   "Av Italia 1234 esquina Bolivia" → false  (has standalone "1234")
 *   "Av Italia esquina Bolivia"      → true   (cross-street, no number)
 *   "Batlle Entre 18 De Julio Y Lubkov" → true (only digit is in street name)
 *   "Av 8 de Octubre 1234"           → false  (1234 is a standalone number)
 *   "Av 8 de Octubre"                → true   (8 is part of street name)
 *   "Avenida 30 Metros entre E y F"  → true   (#5388: "30" names the avenue,
 *                                              "entre E y F" is a cross-street,
 *                                              there is no door number)
 *
 * Returns true when isAddressMissingStreetNumber is already true (so
 * callers can use this single function for both cases).
 */
const STREET_NAME_DIGIT_PATTERNS: RegExp[] = [
  // "<N> de <month>" — most common: "18 de Julio", "8 de Octubre", etc.
  // Allow accents on month names.
  /\b\d{1,2}\s+de\s+[a-záéíóúñ]+\b/gi,
  // "33 Orientales" — historical Uruguayan reference.
  /\b33\s+orientales\b/gi,
  // Standalone "Km <N>" — kilometer markers, not building numbers.
  /\bkm\s*\d+/gi,
  // "<N> Metros" — balneario avenues named by their width
  // ("Avenida 30 Metros", "Calle 18 Metros"). The number is part of the
  // street NAME, not a door number. Production: #5388 "Avenida 30 Metros
  // entre E y F" (Las Toscas) was silently rejected by DAC because it has
  // no real building number, yet the bare-digit heuristic saw the "30" and
  // treated the address as complete — so it never got the ship-with-note
  // (S/N + operator-call) treatment.
  /\b\d{1,3}\s+metros\b/gi,
  // "<N> piso(s)" — floor-count description ("Cabaña de troncos 2 pisos"),
  // never a door number. Same #5388 incident: the merged address carried a
  // landmark description whose "2" otherwise survived the strip.
  /\b\d{1,2}\s+pisos?\b/gi,
];

const CROSS_STREET_KEYWORDS = /\b(esquina|entre|casi)\b/i;

export function isAddressIncomplete(
  address1: string | null | undefined,
): boolean {
  if (!address1) return true;
  const text = address1.trim();
  if (!text) return true;

  // Fast-path: already missing-number under the bare-digit definition.
  if (!/\d/.test(text)) return true;

  // Has a digit somewhere. Only worry about cross-street patterns —
  // pure addresses like "Asencio 1666" return false here even though
  // they contain no cross-street keyword.
  if (!CROSS_STREET_KEYWORDS.test(text)) return false;

  // Has a cross-street keyword + has at least one digit. Strip known
  // street-name digit patterns and see if any digit survives. Surviving
  // digit = standalone building number → not incomplete.
  let stripped = text;
  for (const pat of STREET_NAME_DIGIT_PATTERNS) {
    stripped = stripped.replace(pat, ' ');
  }
  return !/\d/.test(stripped);
}

/**
 * Result of preprocessing the raw Shopify address before it enters the
 * DAC pipeline. Captures whether the address was modified (so we can
 * log it) and whether it should fail-fast (no usable number).
 */
export interface AddressPreprocessResult {
  /** The cleaned-up address1 to use downstream. Always non-null. */
  cleanedAddress1: string;
  /** True if the cleaned address has no digit — caller should fail fast. */
  missingStreetNumber: boolean;
  /** True if normalization actually changed the input (for logging). */
  wasNormalized: boolean;
}

/**
 * One-shot preprocessor. Applies all cleanups and returns a structured
 * result the shipment pipeline can act on.
 */
export function preprocessShopifyAddress(
  address1: string | null | undefined,
): AddressPreprocessResult {
  const original = address1 ?? '';
  const cleanedAddress1 = normalizeStreetNumberSpacing(address1);
  // missingStreetNumber now uses the BROADER incomplete-address detector
  // (covers cross-street-without-building-number cases in addition to
  // the bare-digit case). The caller treats both states identically —
  // invoke ai-feasibility, fall through to ship-with-note. See
  // isAddressIncomplete docstring for the failure modes this catches.
  return {
    cleanedAddress1,
    missingStreetNumber: isAddressIncomplete(cleanedAddress1),
    wasNormalized: cleanedAddress1 !== original.trim().replace(/\s+/g, ' '),
  };
}
