/**
 * Unit tests for the cache-key hash normalization.
 *
 * The normalizer has two goals in tension:
 *   1. Collapse equivalent spellings of the SAME physical address into
 *      the same key (so repeat orders hit cache).
 *   2. Preserve distinctions between genuinely DIFFERENT addresses
 *      (don't let "Italia 45" collide with "Italia 4500").
 *
 * Every test below encodes one of those two goals. If you change the
 * normalizer, read these cases first — they describe the contract the
 * cache layer depends on.
 */

import { describe, it, expect } from 'vitest';
import {
  hashAddressInput,
  _testing,
  type AIResolverInput,
} from '../ai-resolver';

const { normalizeAddressForHash } = _testing;

// ─── normalizeAddressForHash ───────────────────────────────────────────

describe('normalizeAddressForHash — equivalences that MUST collapse', () => {
  it('prefix variants collapse ("Av." == "Avenida" == no prefix)', () => {
    const a = normalizeAddressForHash('Av. Italia 4500');
    const b = normalizeAddressForHash('Avenida Italia 4500');
    const c = normalizeAddressForHash('Italia 4500');
    const d = normalizeAddressForHash('AVDA Italia 4500');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
    expect(a).toBe('italia 4500');
  });

  it('bulevar variants collapse', () => {
    expect(normalizeAddressForHash('Bvar. Artigas 1300')).toBe(
      normalizeAddressForHash('Bulevar Artigas 1300'),
    );
    expect(normalizeAddressForHash('Bvar. Artigas 1300')).toBe('artigas 1300');
  });

  it('rambla prefix stripped', () => {
    expect(normalizeAddressForHash('Rambla Tomás Berreta 8000')).toBe(
      'tomas berreta 8000',
    );
    expect(normalizeAddressForHash("Rambla O'Higgins 14500")).toBe(
      'ohiggins 14500',
    );
  });

  it('doctor/general/teniente prefixes stripped', () => {
    expect(normalizeAddressForHash('Gral. Flores 2400')).toBe('flores 2400');
    expect(normalizeAddressForHash('General Flores 2400')).toBe('flores 2400');
    expect(normalizeAddressForHash('Dr. Schroeder 6400')).toBe('schroeder 6400');
  });

  it('apartment trailers dropped (same building → same hash)', () => {
    const base = normalizeAddressForHash('Italia 4500');
    expect(normalizeAddressForHash('Italia 4500 apto 2')).toBe(base);
    expect(normalizeAddressForHash('Italia 4500, piso 3')).toBe(base);
    expect(normalizeAddressForHash('Italia 4500 depto 505')).toBe(base);
    expect(normalizeAddressForHash('Italia 4500 bis')).toBe(base);
    expect(normalizeAddressForHash('Italia 4500 local 7')).toBe(base);
  });

  it('intersection trailers PRESERVED (grid cities need cross-street)', () => {
    // "Calle 11 esquina 22" and "Calle 11 esquina 33" are different
    // houses in Atlántida's grid. Cache must not collide them.
    const houseA = normalizeAddressForHash('Calle 11 esquina 22');
    const houseB = normalizeAddressForHash('Calle 11 esquina 33');
    expect(houseA).not.toBe(houseB);
    // And an intersection is NOT the same as a numbered house with no
    // intersection suffix.
    expect(normalizeAddressForHash('Italia 4500 esq Propios')).not.toBe(
      normalizeAddressForHash('Italia 4500'),
    );
  });

  it('accent folding ("Tomás" == "Tomas")', () => {
    expect(normalizeAddressForHash('Rambla Tomás Berreta 8000')).toBe(
      normalizeAddressForHash('Rambla Tomas Berreta 8000'),
    );
  });

  it('case folding (upper == lower == mixed)', () => {
    expect(normalizeAddressForHash('AV. ITALIA 4500')).toBe(
      normalizeAddressForHash('av. italia 4500'),
    );
  });

  it('compound prefix stripped ("Av. Gral Flores" → "flores")', () => {
    expect(normalizeAddressForHash('Av. Gral Flores 2400')).toBe('flores 2400');
    expect(normalizeAddressForHash('Avenida General Flores 2400')).toBe(
      'flores 2400',
    );
  });

  it('punctuation normalized (periods, commas, apostrophes)', () => {
    expect(normalizeAddressForHash('Rambla R. Fernández 12500')).toBe(
      'r fernandez 12500',
    );
    expect(normalizeAddressForHash('Italia 4500, Montevideo')).toBe(
      'italia 4500 montevideo',
    );
  });

  it('whitespace collapse', () => {
    expect(normalizeAddressForHash('  Italia    4500   ')).toBe('italia 4500');
  });
});

describe('normalizeAddressForHash — distinctions that MUST be preserved', () => {
  it('different house number → different hash', () => {
    expect(normalizeAddressForHash('Italia 4500')).not.toBe(
      normalizeAddressForHash('Italia 45'),
    );
    expect(normalizeAddressForHash('Italia 4500')).not.toBe(
      normalizeAddressForHash('Italia 4501'),
    );
  });

  it('different street → different hash', () => {
    expect(normalizeAddressForHash('Av. Italia 4500')).not.toBe(
      normalizeAddressForHash('Av. Brasil 4500'),
    );
  });

  it('does not strip part of a real street name', () => {
    // "Don Pedro de Mendoza" — "Don" is NOT in the strip list, preserved.
    expect(normalizeAddressForHash('Don Pedro de Mendoza 900')).toBe(
      'don pedro de mendoza 900',
    );
    // "San José" — "San" is NOT a strip prefix.
    expect(normalizeAddressForHash('San José de Carrasco 500')).toBe(
      'san jose de carrasco 500',
    );
  });

  it('empty / null / whitespace → empty string (not error)', () => {
    expect(normalizeAddressForHash(null)).toBe('');
    expect(normalizeAddressForHash(undefined)).toBe('');
    expect(normalizeAddressForHash('')).toBe('');
    expect(normalizeAddressForHash('   ')).toBe('');
  });

  it('prefix-only input → empty (degenerate case, but must not crash)', () => {
    // "Avenida" with no street name — degenerate, returns "avenida" (kept
    // because words.length==1 in the strip loop).
    expect(normalizeAddressForHash('Avenida')).toBe('avenida');
  });

  it('street starting with a prefix word is preserved when it is the ONLY word', () => {
    // "Rambla" alone (no street name after it) — keep as-is, don't
    // strip to empty.
    expect(normalizeAddressForHash('Rambla')).toBe('rambla');
  });
});

// ─── hashAddressInput (end-to-end) ─────────────────────────────────────

describe('hashAddressInput — cache-key equivalence', () => {
  const base: AIResolverInput = {
    tenantId: 't1',
    city: 'Montevideo',
    address1: 'Av. Italia 4500',
    address2: '',
    zip: '11400',
    province: 'Montevideo',
    country: 'Uruguay',
    customerFirstName: '',
    customerLastName: '',
    customerEmail: '',
    customerPhone: '',
    orderNotes: '',
  };

  it('repeat order from same address → same hash (prefix variant)', () => {
    const h1 = hashAddressInput(base);
    const h2 = hashAddressInput({ ...base, address1: 'Avenida Italia 4500' });
    expect(h1).toBe(h2);
  });

  it('repeat order from same address → same hash (apto noise)', () => {
    const h1 = hashAddressInput(base);
    const h2 = hashAddressInput({
      ...base,
      address1: 'Av. Italia 4500 apto 7',
    });
    expect(h1).toBe(h2);
  });

  it('different city → different hash', () => {
    const h1 = hashAddressInput(base);
    const h2 = hashAddressInput({ ...base, city: 'Paysandu' });
    expect(h1).not.toBe(h2);
  });

  it('different zip → different hash', () => {
    const h1 = hashAddressInput(base);
    const h2 = hashAddressInput({ ...base, zip: '60000' });
    expect(h1).not.toBe(h2);
  });

  it('different house number → different hash', () => {
    const h1 = hashAddressInput(base);
    const h2 = hashAddressInput({ ...base, address1: 'Av. Italia 4501' });
    expect(h1).not.toBe(h2);
  });

  it('pure-apto address2 → collapses to empty, matches empty address2', () => {
    const h1 = hashAddressInput({ ...base, address2: '' });
    const h2 = hashAddressInput({ ...base, address2: 'apto 7' });
    expect(h1).toBe(h2);
  });

  // ─── H-1 (2026-04-21 audit) ────────────────────────────────────────────
  it('H-1: different province → different hash (even when other fields match)', () => {
    // Same street + number + zip but different province must NOT collide.
    // Pre-H-1 the province was ignored, so a customer ordering "Italia
    // 4500" in Paysandú from a Montevideo-based cache entry would have
    // picked up the wrong cache hit.
    const h1 = hashAddressInput(base);
    const h2 = hashAddressInput({ ...base, province: 'Paysandu' });
    expect(h1).not.toBe(h2);
  });

  it('H-1: province alias normalization collapses equivalent spellings', () => {
    const h1 = hashAddressInput({ ...base, province: 'paysandu' });
    const h2 = hashAddressInput({ ...base, province: 'Paysandú' });
    expect(h1).toBe(h2);
  });

  it('H-1: unknown/empty province hashes to the same bucket', () => {
    const h1 = hashAddressInput({ ...base, province: undefined });
    const h2 = hashAddressInput({ ...base, province: '' });
    const h3 = hashAddressInput({ ...base, province: 'bogus-department' });
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
  });
});
