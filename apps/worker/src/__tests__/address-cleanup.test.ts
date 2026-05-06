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
