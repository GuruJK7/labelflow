/**
 * Tests for the defensive "Tel cliente …" line that goes into DAC
 * Observaciones for every shipment (audit 2026-05-12).
 *
 * Operator directive (verbatim): "en el peor caso se deberían poner los
 * datos igualmente y poner que ante cualquier duda se comuniquen con el
 * número de teléfono del cliente en observaciones".
 *
 * These tests pin down WHEN the line is emitted and EXACTLY what it
 * looks like, so the format stays courier-readable and we don't
 * duplicate the phone when a more urgent operator note already has it.
 */
import { describe, it, expect } from 'vitest';
import { buildCustomerContactLine } from '../dac/shipment';

describe('buildCustomerContactLine — emitted cases', () => {
  it('phone + first + last name → "Tel cliente <phone> (First Last)"', () => {
    expect(
      buildCustomerContactLine({
        phone: '+59899837343',
        firstName: 'Anyelina',
        lastName: 'Días Lopez',
      }),
    ).toBe('Tel cliente +59899837343 (Anyelina Días Lopez)');
  });

  it('phone only (no name) → "Tel cliente <phone>" (no parentheses)', () => {
    expect(
      buildCustomerContactLine({
        phone: '099837343',
        firstName: null,
        lastName: null,
      }),
    ).toBe('Tel cliente 099837343');
  });

  it('phone + only firstName → "Tel cliente <phone> (First)"', () => {
    expect(
      buildCustomerContactLine({
        phone: '099837343',
        firstName: 'Maria',
        lastName: null,
      }),
    ).toBe('Tel cliente 099837343 (Maria)');
  });

  it('phone + only lastName → "Tel cliente <phone> (Last)"', () => {
    expect(
      buildCustomerContactLine({
        phone: '099837343',
        firstName: null,
        lastName: 'Garcia',
      }),
    ).toBe('Tel cliente 099837343 (Garcia)');
  });

  it('trims whitespace from phone before checking emptiness', () => {
    expect(
      buildCustomerContactLine({
        phone: '  +598 99 837 343  ',
        firstName: 'X',
        lastName: 'Y',
      }),
    ).toBe('Tel cliente +598 99 837 343 (X Y)');
  });
});

describe('buildCustomerContactLine — suppression cases', () => {
  it('returns null when phone is empty string', () => {
    expect(
      buildCustomerContactLine({
        phone: '',
        firstName: 'Maria',
        lastName: 'Garcia',
      }),
    ).toBeNull();
  });

  it('returns null when phone is whitespace-only', () => {
    expect(
      buildCustomerContactLine({
        phone: '   ',
        firstName: 'Maria',
        lastName: 'Garcia',
      }),
    ).toBeNull();
  });

  it('returns null when phone is null', () => {
    expect(
      buildCustomerContactLine({
        phone: null,
        firstName: 'Maria',
        lastName: 'Garcia',
      }),
    ).toBeNull();
  });

  it('returns null when phone is undefined', () => {
    expect(
      buildCustomerContactLine({
        phone: undefined,
        firstName: 'Maria',
        lastName: 'Garcia',
      }),
    ).toBeNull();
  });

  // CRITICAL: avoid duplicating phone when the FALTA DATO operator note
  // already includes it. The Kimberly-style "no-number" note format is:
  //   "FALTA DATO EN DIRECCION — CONTACTAR AL CLIENTE <name> TEL <phone>..."
  // Adding a second "Tel cliente <phone>..." line would clutter the label.
  it('returns null when suppressBecauseNoNumberNote=true (even with phone)', () => {
    expect(
      buildCustomerContactLine({
        phone: '+59899837343',
        firstName: 'Anyelina',
        lastName: 'Días',
        suppressBecauseNoNumberNote: true,
      }),
    ).toBeNull();
  });

  it('emits the line when suppressBecauseNoNumberNote=false (explicit)', () => {
    expect(
      buildCustomerContactLine({
        phone: '+59899837343',
        firstName: 'Anyelina',
        lastName: 'Días',
        suppressBecauseNoNumberNote: false,
      }),
    ).toBe('Tel cliente +59899837343 (Anyelina Días)');
  });
});

describe('buildCustomerContactLine — production case sanity', () => {
  it('#12060 Carolina Frey Pizzorno — emits "Tel cliente 099152933 (Carolina Frey Pizzorno)"', () => {
    expect(
      buildCustomerContactLine({
        phone: '099152933',
        firstName: 'Carolina',
        lastName: 'Frey Pizzorno',
      }),
    ).toBe('Tel cliente 099152933 (Carolina Frey Pizzorno)');
  });

  it('#12059 Anyelina Días Lopez — emits "Tel cliente 099837343 (Anyelina Días Lopez)"', () => {
    expect(
      buildCustomerContactLine({
        phone: '099837343',
        firstName: 'Anyelina',
        lastName: 'Días Lopez',
      }),
    ).toBe('Tel cliente 099837343 (Anyelina Días Lopez)');
  });
});
