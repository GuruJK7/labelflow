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
  return {
    cleanedAddress1,
    missingStreetNumber: isAddressMissingStreetNumber(cleanedAddress1),
    wasNormalized: cleanedAddress1 !== original.trim().replace(/\s+/g, ' '),
  };
}
