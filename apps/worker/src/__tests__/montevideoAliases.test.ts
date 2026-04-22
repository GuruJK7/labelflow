import { describe, it, expect } from 'vitest';
import { getDepartmentForCity } from '../dac/uruguay-geo';

// 2026-04-22 — A production order (#Adriana Abeijon, city="Mvdo.") was
// flagged as DacAddressRejectedError because "Mvdo." was not a known
// city alias. The deterministic resolver returned undefined; the DAC
// form couldn't pick a department; and the fallback error path asked
// the operator to contact the customer — even though "Mvdo." is a
// trivially-resolvable Montevideo abbreviation.
//
// We added explicit aliases in uruguay-geo.ts so these common forms
// resolve deterministically (zero API cost, zero dependency on
// ANTHROPIC_API_KEY being set). These tests lock in the contract so
// a future refactor doesn't silently drop them.

describe('getDepartmentForCity — Montevideo abbreviations', () => {
  // Raw forms operators type in Shopify (mixed case, with/without dot).
  // Normalization (lowercase + dot→space + collapse) must collapse all
  // of these to a single lookup key.
  it.each([
    // "Mvdo" family
    ['Mvdo', 'Montevideo'],
    ['Mvdo.', 'Montevideo'],
    ['MVDO', 'Montevideo'],
    ['mvdo', 'Montevideo'],
    ['mvdo.', 'Montevideo'],
    // "Mdeo" family
    ['Mdeo', 'Montevideo'],
    ['Mdeo.', 'Montevideo'],
    ['MDEO', 'Montevideo'],
    ['mdeo', 'Montevideo'],
    // "MVD" family (airport/city code)
    ['MVD', 'Montevideo'],
    ['mvd', 'Montevideo'],
    ['Mvd', 'Montevideo'],
    ['MVD.', 'Montevideo'],
    // "Mdo" and other common variants
    ['Mdo', 'Montevideo'],
    ['mdo', 'Montevideo'],
    ['MDO', 'Montevideo'],
    ['Mtdeo', 'Montevideo'],
    ['Mtvdeo', 'Montevideo'],
    ['Mvdeo', 'Montevideo'],
  ])('"%s" → %s', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // Real prod regression — the exact string from the Shopify order
  // that triggered the original DacAddressRejectedError.
  it('real prod regression: city="Mvdo." resolves to Montevideo', () => {
    expect(getDepartmentForCity('Mvdo.')).toBe('Montevideo');
  });

  // Guard: we are NOT claiming every short string is Montevideo —
  // other department capitals take priority when they exist.
  it('does NOT confuse "Mal" with Montevideo (no alias collision)', () => {
    // "Mal" is not a registered alias — should be undefined, not
    // misrouted to Montevideo.
    expect(getDepartmentForCity('Mal')).toBeUndefined();
  });

  it('does NOT claim "Can" is Montevideo (Canelones abbreviation, not a key)', () => {
    expect(getDepartmentForCity('Can')).toBeUndefined();
  });

  // Real full-address scenario: combines city alias + DAC-style input.
  // This is the integration concern — the resolver is one step in the
  // pipeline; we want to confirm the alias survives trimming, mixed
  // case, and trailing punctuation as it would come from Shopify.
  it('trims surrounding whitespace around Mvdo.', () => {
    expect(getDepartmentForCity('  Mvdo.  ')).toBe('Montevideo');
  });

  it('collapses internal whitespace (Mvdo .  → mvdo)', () => {
    expect(getDepartmentForCity('Mvdo .')).toBe('Montevideo');
  });
});
