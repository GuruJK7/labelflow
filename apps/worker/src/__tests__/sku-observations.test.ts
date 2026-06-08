/**
 * Tests for the per-tenant "SKU en observaciones" feature (Tenant.skuInObservations).
 *
 * A client asked to have the product SKU(s) printed in the DAC label
 * "Observaciones" field so the packer can pick by code. The feature is
 * opt-in per store (default OFF) and must NOT alter the label for any tenant
 * that leaves it off.
 *
 * Confirmed format (operator decision 2026-06-08): "<value> xN", multiple
 * distinct SKUs separated by commas, with NO "SKU:" prefix and placed as the
 * FIRST line of Observaciones, e.g.
 *   "Plantillas Nube Grandes x2, Faja Reductora x1".
 *
 * These tests pin the format AND prove the line survives the existing
 * belt-and-suspenders sanitizer (sanitizeObservationLine) untouched — that is
 * the guarantee that turning the flag on cannot corrupt the observations the
 * DAC courier already relies on. With the "SKU:" prefix gone, the mandatory
 * " xN" quantity suffix is what keeps an all-digit barcode SKU from being
 * stripped by LONG_NUMERIC_ID_RE (see the barcode test at the bottom).
 */
import { describe, it, expect } from 'vitest';
import { buildSkuObservationLine, sanitizeObservationLine } from '../dac/shipment';

// Minimal line_item factory — only sku + quantity matter to the helper, but the
// ShopifyOrder type requires the other fields, so fill them with inert values.
function li(sku: string | null | undefined, quantity: number) {
  return { title: 'Producto', price: '0.00', product_id: null, sku, quantity };
}

describe('buildSkuObservationLine — emitted cases', () => {
  it('single item with SKU → "<value> xN" (no prefix)', () => {
    expect(
      buildSkuObservationLine({ line_items: [li('Plantillas Nube Grandes', 3)] }),
    ).toBe('Plantillas Nube Grandes x3');
  });

  it('client production example — two distinct SKUs, comma-separated, order preserved', () => {
    expect(
      buildSkuObservationLine({
        line_items: [li('Plantillas Nube Grandes', 2), li('Faja Reductora', 1)],
      }),
    ).toBe('Plantillas Nube Grandes x2, Faja Reductora x1');
  });

  it('aggregates quantities for the SAME sku across multiple line items', () => {
    expect(
      buildSkuObservationLine({ line_items: [li('ABC', 2), li('ABC', 1)] }),
    ).toBe('ABC x3');
  });

  it('preserves first-seen order when a duplicate sku appears later', () => {
    expect(
      buildSkuObservationLine({
        line_items: [li('A', 1), li('B', 1), li('A', 1)],
      }),
    ).toBe('A x2, B x1');
  });

  it('skips line items WITHOUT a sku but keeps the ones that have it', () => {
    expect(
      buildSkuObservationLine({
        line_items: [li('A', 1), li(null, 5), li('', 9), li('B', 2)],
      }),
    ).toBe('A x1, B x2');
  });

  it('trims surrounding whitespace from the sku value', () => {
    expect(
      buildSkuObservationLine({ line_items: [li('  ABC  ', 1)] }),
    ).toBe('ABC x1');
  });
});

describe('buildSkuObservationLine — suppression cases (line omitted)', () => {
  it('returns null when NO line item has a sku', () => {
    expect(
      buildSkuObservationLine({ line_items: [li(null, 1), li('', 2), li('   ', 3)] }),
    ).toBeNull();
  });

  it('returns null for empty line_items', () => {
    expect(buildSkuObservationLine({ line_items: [] })).toBeNull();
  });

  it('returns null defensively for null/undefined line_items', () => {
    // Malformed orders must never throw — the courier label just omits the line.
    expect(buildSkuObservationLine({ line_items: null as never })).toBeNull();
    expect(buildSkuObservationLine({ line_items: undefined as never })).toBeNull();
  });
});

describe('buildSkuObservationLine — quantity edge cases default to x1', () => {
  it('zero quantity → x1', () => {
    expect(buildSkuObservationLine({ line_items: [li('A', 0)] })).toBe('A x1');
  });

  it('negative quantity → x1', () => {
    expect(buildSkuObservationLine({ line_items: [li('A', -4)] })).toBe('A x1');
  });

  it('NaN quantity → x1', () => {
    expect(buildSkuObservationLine({ line_items: [li('A', Number.NaN)] })).toBe('A x1');
  });

  it('missing quantity field → x1', () => {
    expect(
      buildSkuObservationLine({
        line_items: [{ title: 'P', price: '0', product_id: null, sku: 'A' } as never],
      }),
    ).toBe('A x1');
  });

  it('fractional quantity is floored', () => {
    expect(buildSkuObservationLine({ line_items: [li('A', 2.9)] })).toBe('A x2');
  });
});

describe('buildSkuObservationLine — separator safety (cannot corrupt observations)', () => {
  it('never emits a pipe — pipes inside a sku are collapsed to a space', () => {
    const out = buildSkuObservationLine({ line_items: [li('A|B', 1)] });
    expect(out).toBe('A B x1');
    expect(out).not.toContain('|');
  });

  it('newlines/tabs inside a sku are collapsed to a single space', () => {
    expect(
      buildSkuObservationLine({ line_items: [li('A\n\tB', 1)] }),
    ).toBe('A B x1');
  });

  it('the produced line SURVIVES sanitizeObservationLine unchanged (text sku)', () => {
    const line = buildSkuObservationLine({
      line_items: [li('Plantillas Nube Grandes', 2), li('Faja Reductora', 1)],
    })!;
    // sanitizeObservationLine is the final pass run on every observation piece
    // before it is sent to DAC — it must NOT strip or mangle the SKU line.
    expect(sanitizeObservationLine(line)).toBe(line);
  });

  it('a pure-numeric (barcode) sku SURVIVES the long-numeric-ID strip thanks to the " xN" suffix', () => {
    // A bare "1234567890123" would be stripped by LONG_NUMERIC_ID_RE; with the
    // mandatory " xN" quantity suffix the whole piece is no longer pure-numeric,
    // so it stays even now that the old "SKU:" prefix is gone.
    const line = buildSkuObservationLine({ line_items: [li('1234567890123', 2)] })!;
    expect(line).toBe('1234567890123 x2');
    expect(sanitizeObservationLine(line)).toBe(line);
  });

  it('a single all-digit barcode (no comma) still survives without the prefix', () => {
    // Hardens the load-bearing-suffix guarantee for the single-item case too.
    const line = buildSkuObservationLine({ line_items: [li('8821239602381', 1)] })!;
    expect(line).toBe('8821239602381 x1');
    expect(sanitizeObservationLine(line)).toBe(line);
    expect(sanitizeObservationLine(line)).not.toBe('');
  });
});
