import { describe, it, expect } from 'vitest';
import {
  normalizeStreetNumberSpacing,
  isAddressMissingStreetNumber,
  preprocessShopifyAddress,
} from '../dac/address-cleanup';

/**
 * Audit 2026-05-06 — address-quality preprocessor regression tests.
 *
 * Each test case here came from a real production failure where DAC
 * silently rejected the form because of a structural issue in the
 * customer-typed address. The preprocessor catches these BEFORE we
 * waste a DAC form submit attempt.
 */

describe('normalizeStreetNumberSpacing', () => {
  describe('production cases (audit 2026-05-06)', () => {
    it('#11733 Silvia Aranda — "Asencio1666" → "Asencio 1666"', () => {
      // The real production address that DAC silently rejected because
      // its parser couldn't separate the street name from the number.
      expect(normalizeStreetNumberSpacing('Asencio1666')).toBe('Asencio 1666');
    });
  });

  describe('inserts space at letter→digit transitions', () => {
    it.each([
      ['Asencio1666', 'Asencio 1666'],
      ['Av.Bolivia2338', 'Av.Bolivia 2338'],
      ['Calle Principal100', 'Calle Principal 100'],
      ['Rondeau345', 'Rondeau 345'],
      ['8 de Octubre1234', '8 de Octubre 1234'],
      ['Avenida Italia4500', 'Avenida Italia 4500'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeStreetNumberSpacing(input)).toBe(expected);
    });
  });

  describe('preserves accents and special characters', () => {
    it('handles accented street names', () => {
      expect(normalizeStreetNumberSpacing('Sarandí del Yí123')).toBe('Sarandí del Yí 123');
      expect(normalizeStreetNumberSpacing('Guayabos2580')).toBe('Guayabos 2580');
    });
  });

  describe('idempotent (no change on already-spaced)', () => {
    it.each([
      'Asencio 1666',
      'Av Italia 4500',
      'Calle Principal 100',
      '8 de Octubre 1234',
      'Av. Rivera 2966 esq. Rafael Pastoriza',
    ])('%s — unchanged', (input) => {
      expect(normalizeStreetNumberSpacing(input)).toBe(input);
    });
  });

  describe('does NOT split digit→letter transitions', () => {
    it('keeps "3a" / "5b" type unit suffixes intact', () => {
      // "3a piso", "5B" etc. are unit/floor suffixes — splitting would
      // garble them. The split only goes one direction: letter→digit.
      expect(normalizeStreetNumberSpacing('Calle X 345b')).toBe('Calle X 345b');
      expect(normalizeStreetNumberSpacing('Calle Y 3a piso')).toBe('Calle Y 3a piso');
    });
  });

  describe('collapses multiple spaces into one', () => {
    it.each([
      ['  Asencio   1666  ', 'Asencio 1666'],
      ['Calle    Principal     100', 'Calle Principal 100'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeStreetNumberSpacing(input)).toBe(expected);
    });
  });

  describe('null/empty safety', () => {
    it.each([null, undefined, ''])('%s → ""', (input) => {
      expect(normalizeStreetNumberSpacing(input)).toBe('');
    });

    it('whitespace-only → ""', () => {
      expect(normalizeStreetNumberSpacing('   ')).toBe('');
    });
  });

  describe('does NOT damage legitimate addresses', () => {
    // Real production addresses we've successfully shipped to. The
    // normalizer must leave these untouched (or at most collapse
    // spaces / trim).
    it.each([
      ['18 de Julio 1234', '18 de Julio 1234'],
      ['Av Italia 3500', 'Av Italia 3500'],
      ['Camino Carrasco 5400', 'Camino Carrasco 5400'],
      ['Rambla Republica De Chile 4437', 'Rambla Republica De Chile 4437'],
      ['Bvar. Artigas 1234', 'Bvar. Artigas 1234'],
      ['25 de Mayo 199', '25 de Mayo 199'],
    ])('%s — unchanged', (input, expected) => {
      expect(normalizeStreetNumberSpacing(input)).toBe(expected);
    });
  });
});

describe('isAddressMissingStreetNumber', () => {
  describe('production cases (audit 2026-05-06)', () => {
    it('#11724 Marcela Pascal — "La Paloma" has no number → true', () => {
      // Real failure: customer typed only the city name as address1.
      // DAC requires a numeric street number, so this would silently fail.
      expect(isAddressMissingStreetNumber('La Paloma')).toBe(true);
    });
  });

  describe('returns true for addresses without any digit', () => {
    it.each([
      'La Paloma',
      'Av. del Mar',
      'Centro',
      'Casa de mi mamá',
      'Frente a la plaza',
      'Esquina con la avenida',
    ])('%s → true', (input) => {
      expect(isAddressMissingStreetNumber(input)).toBe(true);
    });
  });

  describe('returns false for addresses with a number', () => {
    it.each([
      'Asencio 1666',
      '8 de Octubre 1234',
      'Calle Principal 100',
      'Apto 5',
      'Ruta 1 km 30',
      'Av Italia 4500 Apto 12',
      // Even a single digit anywhere counts as "has number"
      'Calle X 5',
    ])('%s → false', (input) => {
      expect(isAddressMissingStreetNumber(input)).toBe(false);
    });
  });

  describe('null/empty/whitespace are treated as missing', () => {
    it.each([null, undefined, '', '   '])('%s → true', (input) => {
      expect(isAddressMissingStreetNumber(input)).toBe(true);
    });
  });
});

describe('preprocessShopifyAddress (one-shot pipeline)', () => {
  it('reports both normalization and missing-number for #11733-style input', () => {
    // "Asencio1666" gets a space, has digits → not missing
    const r = preprocessShopifyAddress('Asencio1666');
    expect(r.cleanedAddress1).toBe('Asencio 1666');
    expect(r.missingStreetNumber).toBe(false);
    expect(r.wasNormalized).toBe(true);
  });

  it('reports missingStreetNumber=true for #11724-style input', () => {
    const r = preprocessShopifyAddress('La Paloma');
    expect(r.cleanedAddress1).toBe('La Paloma');
    expect(r.missingStreetNumber).toBe(true);
    expect(r.wasNormalized).toBe(false);
  });

  it('reports wasNormalized=false for already-clean input', () => {
    const r = preprocessShopifyAddress('Av Italia 3500');
    expect(r.cleanedAddress1).toBe('Av Italia 3500');
    expect(r.missingStreetNumber).toBe(false);
    expect(r.wasNormalized).toBe(false);
  });

  it('handles null gracefully', () => {
    const r = preprocessShopifyAddress(null);
    expect(r.cleanedAddress1).toBe('');
    expect(r.missingStreetNumber).toBe(true);
    expect(r.wasNormalized).toBe(false);
  });
});

// 2026-05-12 — cross-street-without-building-number incidents:
//   - Alfonsina Garibotti: "Av aigua esquina camino de los gauchos"  → no number
//   - Grace Gurin:         "Batlle Entre 18 De Julio Y Lubkov"       → digit "18" is in the cross-street NAME, not a building number
// Both silent-rejected by DAC because K_Direccion has no real number.
// The broader incomplete-address detector below catches these via the
// cross-street keywords ("esquina", "entre", "casi") + street-name digit
// stripping.
describe('preprocessShopifyAddress — cross-street incomplete (incidents 2026-05-12)', () => {
  it('"Av aigua esquina camino de los gauchos" → missingStreetNumber=true', () => {
    const r = preprocessShopifyAddress('Av aigua esquina camino de los gauchos');
    expect(r.missingStreetNumber).toBe(true);
  });

  it('"Batlle Entre 18 De Julio Y Lubkov" → missingStreetNumber=true (the "18" belongs to a street name)', () => {
    const r = preprocessShopifyAddress('Batlle Entre 18 De Julio Y Lubkov');
    expect(r.missingStreetNumber).toBe(true);
  });

  it('"Av 8 de Octubre 1234" → missingStreetNumber=false (1234 is a real number)', () => {
    // The "8" belongs to a street name; "1234" is the building number.
    // After stripping street-name digits, "1234" survives → has a real number.
    const r = preprocessShopifyAddress('Av 8 de Octubre 1234');
    expect(r.missingStreetNumber).toBe(false);
  });

  it('"Av 8 de Octubre esquina Bolivia" → missingStreetNumber=true (no real number)', () => {
    const r = preprocessShopifyAddress('Av 8 de Octubre esquina Bolivia');
    expect(r.missingStreetNumber).toBe(true);
  });

  it('"Avenida Italia 4500 esquina Bolivia" → missingStreetNumber=false (4500 is a real number)', () => {
    // Address WITH a building number that ALSO mentions the cross street.
    // Must not false-positive on this legitimate case.
    const r = preprocessShopifyAddress('Avenida Italia 4500 esquina Bolivia');
    expect(r.missingStreetNumber).toBe(false);
  });

  it('"Calle Principal casi Mercado" → missingStreetNumber=true', () => {
    const r = preprocessShopifyAddress('Calle Principal casi Mercado');
    expect(r.missingStreetNumber).toBe(true);
  });

  it('"Ruta 1 km 30" stays false (a real address even though minimal)', () => {
    // Ruta + km is a legitimate UY rural address form. Don't false-positive.
    const r = preprocessShopifyAddress('Ruta 1 km 30');
    expect(r.missingStreetNumber).toBe(false);
  });

  it('"Avenida 33 Orientales 500" → false (500 is real building number)', () => {
    const r = preprocessShopifyAddress('Avenida 33 Orientales 500');
    expect(r.missingStreetNumber).toBe(false);
  });

  it('"Avenida 33 Orientales esquina Plaza" → true (only digits are in street name)', () => {
    const r = preprocessShopifyAddress('Avenida 33 Orientales esquina Plaza');
    expect(r.missingStreetNumber).toBe(true);
  });
});

describe('preprocessShopifyAddress — balneario "N Metros" avenue + floor description (incident #5388)', () => {
  it('"Avenida 30 Metros entre E y F" → true ("30" is the avenue name, no door number)', () => {
    // Production #5388 (Christiam Mateus, Las Toscas). DAC silently rejected
    // this because there is no real building number — "30" belongs to the
    // avenue name and "entre E y F" is a cross-street reference.
    const r = preprocessShopifyAddress('Avenida 30 Metros entre E y F');
    expect(r.missingStreetNumber).toBe(true);
  });

  it('"Avenida 30 Metros entre E y F, Cabaña de troncos 2 pisos" → true (full merged form)', () => {
    // The exact merged address1 the worker built for #5388. Both the "30"
    // (avenue width) and the "2" (floor count) are stripped, leaving no
    // digit → flagged incomplete → ship-with-note.
    const r = preprocessShopifyAddress(
      'Avenida 30 Metros entre E y F, Cabaña de troncos 2 pisos',
    );
    expect(r.missingStreetNumber).toBe(true);
  });

  it('"Avenida 30 Metros 1234 entre E y F" → false (1234 is a real door number)', () => {
    // Must NOT false-positive: when a real standalone building number is
    // present alongside the "N Metros" avenue name, the address is complete.
    const r = preprocessShopifyAddress('Avenida 30 Metros 1234 entre E y F');
    expect(r.missingStreetNumber).toBe(false);
  });

  it('"Calle 18 Metros casi rambla" → true (no door number)', () => {
    const r = preprocessShopifyAddress('Calle 18 Metros casi rambla');
    expect(r.missingStreetNumber).toBe(true);
  });
});
