/**
 * Safe defaults for Label model fields that are required (non-null) in Prisma.
 *
 * Background: Label.city and Label.department are declared as `String` (not `String?`)
 * in the Prisma schema, so passing `null` to an upsert's `create` block triggers a
 * misleading Prisma error: "Argument `tenant` is missing." The actual problem is a
 * required scalar (city or department) being null. Prisma's error reporter picks the
 * first validation issue and reports it using relation syntax, which makes debugging
 * extremely hard.
 *
 * Historical impact: before this helper was introduced, an order with empty city and
 * null province would succeed at creating a DAC guia but then fail to persist the
 * Label row. The cron retries that order every tick, burning a fresh DAC guia each
 * time — a real money leak. We track this regression here so it can never return.
 *
 * This module is pure (no DB, no logger, no Playwright) so it can be imported by
 * both the production job (process-orders.job.ts) and the test job (test-dac.job.ts)
 * without side effects and tested in isolation.
 */

export interface LabelGeoInput {
  /** The city string from the Shopify shipping address (may be null/undefined/empty). */
  city: string | null | undefined;
  /** The province/state string from the Shopify shipping address (may be null/undefined/empty). */
  province: string | null | undefined;
  /** The department resolved by the geo database (may be null if city wasn't found). */
  resolvedDepartment: string | null | undefined;
}

export interface LabelGeoOutput {
  /** Guaranteed non-null city for the Label create payload. */
  safeCity: string;
  /** Guaranteed non-null department for the Label create payload. */
  safeDepartment: string;
}

/**
 * Compute safe (never-null) values for Label.city and Label.department given the raw
 * inputs from a Shopify order. Falls back to empty strings when every source is null.
 *
 * Resolution priority for department:
 *   1. resolvedDepartment (from the geo database lookup)
 *   2. province (the Shopify-provided province/state name)
 *   3. empty string (final fallback to satisfy the non-null schema constraint)
 *
 * Resolution for city is simpler — just coalesce null/undefined to empty string. The
 * actual city selection for DAC is done elsewhere in shipment.ts based on the
 * detected barrio; this field is informational only in the Label row.
 */
export function buildSafeLabelGeoFields(input: LabelGeoInput): LabelGeoOutput {
  const safeCity = input.city ?? '';
  const safeDepartment =
    input.resolvedDepartment ?? input.province ?? '';
  return { safeCity, safeDepartment };
}
