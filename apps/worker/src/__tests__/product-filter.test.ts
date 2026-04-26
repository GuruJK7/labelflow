import { describe, it, expect } from 'vitest';
import {
  buildAllowedSet,
  entryMatchTokens,
  orderMatchesAllowedProducts,
  type ProductCache,
} from '../rules/product-filter';

function order(...productIds: Array<number | string | null | undefined>) {
  return {
    line_items: productIds.map((id) => ({ product_id: id })),
  };
}

describe('buildAllowedSet', () => {
  it('lowercases and trims', () => {
    const s = buildAllowedSet(['  Curvadivina  ', 'AKTIVA', 'joyas']);
    expect(s.has('curvadivina')).toBe(true);
    expect(s.has('aktiva')).toBe(true);
    expect(s.has('joyas')).toBe(true);
  });

  it('returns empty set for null/undefined/empty', () => {
    expect(buildAllowedSet(null).size).toBe(0);
    expect(buildAllowedSet(undefined).size).toBe(0);
    expect(buildAllowedSet([]).size).toBe(0);
  });

  it('drops empty strings so they do not collide with empty cache fields', () => {
    const s = buildAllowedSet(['', '   ', 'real']);
    expect(s.size).toBe(1);
    expect(s.has('real')).toBe(true);
  });
});

describe('entryMatchTokens', () => {
  it('returns single token for legacy string entry', () => {
    expect(entryMatchTokens('Curvadivina')).toEqual(['curvadivina']);
  });

  it('returns title/type/vendor tokens for enriched entry', () => {
    expect(
      entryMatchTokens({ title: 'Anillo', type: 'Joyas', vendor: 'Curvadivina' }),
    ).toEqual(['anillo', 'joyas', 'curvadivina']);
  });

  it('skips empty fields in enriched entry', () => {
    expect(entryMatchTokens({ title: 'Anillo', type: '', vendor: '  ' })).toEqual([
      'anillo',
    ]);
  });

  it('returns empty array for undefined / empty string', () => {
    expect(entryMatchTokens(undefined)).toEqual([]);
    expect(entryMatchTokens('')).toEqual([]);
    expect(entryMatchTokens({ title: '', type: '', vendor: '' })).toEqual([]);
  });
});

describe('orderMatchesAllowedProducts', () => {
  // ── Backward compatibility: legacy string cache ──

  it('matches legacy string cache by vendor name (nexomediaservices regression)', () => {
    const cache: ProductCache = { '111': 'Aktiva', '222': 'Otra Marca' };
    const allowed = buildAllowedSet(['Aktiva']);
    expect(orderMatchesAllowedProducts(order(111), allowed, cache)).toBe(true);
    expect(orderMatchesAllowedProducts(order(222), allowed, cache)).toBe(false);
  });

  it('legacy: order with mixed line items matches if at least one is allowed', () => {
    const cache: ProductCache = { '111': 'Aktiva', '222': 'Otra' };
    const allowed = buildAllowedSet(['aktiva']);
    expect(orderMatchesAllowedProducts(order(222, 111), allowed, cache)).toBe(true);
  });

  // ── Enriched cache shape ──

  it('matches enriched cache by exact title (single-product whitelist)', () => {
    const cache: ProductCache = {
      '1': { title: 'Anillo dorado', type: '', vendor: 'Curvadivina' },
      '2': { title: 'Pulsera plata', type: '', vendor: 'Curvadivina' },
    };
    const allowed = buildAllowedSet(['Anillo dorado']);
    expect(orderMatchesAllowedProducts(order(1), allowed, cache)).toBe(true);
    expect(orderMatchesAllowedProducts(order(2), allowed, cache)).toBe(false);
  });

  it('matches enriched cache by type', () => {
    const cache: ProductCache = {
      '1': { title: 'Anillo', type: 'Joyas', vendor: 'X' },
      '2': { title: 'Camisa', type: 'Ropa', vendor: 'X' },
    };
    const allowed = buildAllowedSet(['joyas']);
    expect(orderMatchesAllowedProducts(order(1), allowed, cache)).toBe(true);
    expect(orderMatchesAllowedProducts(order(2), allowed, cache)).toBe(false);
  });

  it('matches enriched cache by vendor', () => {
    const cache: ProductCache = {
      '1': { title: 'Anillo', type: '', vendor: 'Curvadivina' },
      '2': { title: 'Camisa', type: '', vendor: 'Otra' },
    };
    const allowed = buildAllowedSet(['Curvadivina']);
    expect(orderMatchesAllowedProducts(order(1), allowed, cache)).toBe(true);
    expect(orderMatchesAllowedProducts(order(2), allowed, cache)).toBe(false);
  });

  it('case-insensitive matching across all token sources', () => {
    const cache: ProductCache = {
      '1': { title: 'AnIlLo DoRaDo', type: 'JOYAS', vendor: 'CurvaDIVINA' },
    };
    expect(
      orderMatchesAllowedProducts(order(1), buildAllowedSet(['anillo dorado']), cache),
    ).toBe(true);
    expect(
      orderMatchesAllowedProducts(order(1), buildAllowedSet(['joyas']), cache),
    ).toBe(true);
    expect(
      orderMatchesAllowedProducts(order(1), buildAllowedSet(['CURVADIVINA']), cache),
    ).toBe(true);
  });

  // ── Mixed shapes during migration ──

  it('handles mixed legacy + enriched entries in same cache', () => {
    const cache: ProductCache = {
      '1': 'Aktiva',
      '2': { title: 'Anillo', type: 'Joyas', vendor: 'Curvadivina' },
    };
    const allowed = buildAllowedSet(['Aktiva', 'Joyas']);
    expect(orderMatchesAllowedProducts(order(1), allowed, cache)).toBe(true);
    expect(orderMatchesAllowedProducts(order(2), allowed, cache)).toBe(true);
    expect(orderMatchesAllowedProducts(order(3), allowed, cache)).toBe(false);
  });

  // ── Edge cases ──

  it('empty allowed set means "no filter" — every order matches', () => {
    const cache: ProductCache = { '1': 'Aktiva' };
    expect(orderMatchesAllowedProducts(order(999), buildAllowedSet([]), cache)).toBe(
      true,
    );
    expect(orderMatchesAllowedProducts(order(), buildAllowedSet([]), cache)).toBe(
      true,
    );
  });

  it('empty cache with active filter means nothing can match', () => {
    const allowed = buildAllowedSet(['Aktiva']);
    expect(orderMatchesAllowedProducts(order(1), allowed, {})).toBe(false);
  });

  it('line items without product_id are ignored (cannot match)', () => {
    const cache: ProductCache = { '1': 'Aktiva' };
    const allowed = buildAllowedSet(['Aktiva']);
    expect(orderMatchesAllowedProducts(order(null, undefined), allowed, cache)).toBe(
      false,
    );
    // But a sibling line with valid id rescues the order:
    expect(
      orderMatchesAllowedProducts(order(null, 1), allowed, cache),
    ).toBe(true);
  });

  it('product_id not present in cache is ignored', () => {
    const cache: ProductCache = { '1': 'Aktiva' };
    const allowed = buildAllowedSet(['Aktiva']);
    expect(orderMatchesAllowedProducts(order(999), allowed, cache)).toBe(false);
  });

  it('handles string-typed product_ids (Shopify sends numbers but tolerate strings)', () => {
    const cache: ProductCache = { '1': 'Aktiva' };
    const allowed = buildAllowedSet(['Aktiva']);
    expect(orderMatchesAllowedProducts(order('1'), allowed, cache)).toBe(true);
  });
});
