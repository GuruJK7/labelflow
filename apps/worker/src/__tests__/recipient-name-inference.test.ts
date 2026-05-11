/**
 * Tests for the email-based last-name inferer.
 *
 * Production trigger: 2026-05-11 order #12001 (Esmeralda P) — Shopify
 * shipping_address.last_name was "P" (single letter, incomplete checkout).
 * DAC silently rejected the form ("URL stays on /envios/nuevo, error box
 * empty"), rescue exhausted, order parqueado. Investigation showed this
 * was the ONLY single-letter-last-name order in tenant history AND the
 * only Aires Puros order that failed (two prior Aires Puros orders with
 * full names succeeded). The customer's email "pieriesmeralda@gmail.com"
 * obviously contains "pieri" + "esmeralda" — last name = "Pieri".
 *
 * The inferLastNameFromEmail function is intentionally DETERMINISTIC (no
 * AI call, no hallucination surface). These tests pin down the exact
 * parsing rules so the function can never regress into guessing.
 */

import { describe, it, expect } from 'vitest';
import { inferLastNameFromEmail } from '../dac/recipient-name-inference';

describe('inferLastNameFromEmail — early-skip guards', () => {
  it('skips when last name is already complete (≥3 chars)', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Esmeralda',
        lastName: 'Pieri',
        email: 'whatever@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('skips when last name is exactly 3 chars (the floor)', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Ana',
        lastName: 'Ros',
        email: 'rosana@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('skips when firstName is empty', () => {
    expect(
      inferLastNameFromEmail({
        firstName: '',
        lastName: 'P',
        email: 'whatever@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('skips when email is empty', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Esmeralda',
        lastName: 'P',
        email: '',
      }).inferredLastName,
    ).toBeNull();
  });

  it('skips when email has no @ sign (malformed)', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Esmeralda',
        lastName: 'P',
        email: 'pieriesmeralda',
      }).inferredLastName,
    ).toBeNull();
  });
});

describe('inferLastNameFromEmail — the #12001 Esmeralda Pieri case (REGRESSION)', () => {
  it('the exact production input recovers "Pieri"', () => {
    const r = inferLastNameFromEmail({
      firstName: 'Esmeralda',
      lastName: 'P',
      email: 'pieriesmeralda@gmail.com',
    });
    expect(r.inferredLastName).toBe('Pieri');
    expect(r.reasoning).toContain('pieri');
  });

  it('uppercase first name still matches lowercase email handle', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'ESMERALDA',
        lastName: 'P',
        email: 'PIERIESMERALDA@GMAIL.COM',
      }).inferredLastName,
    ).toBe('Pieri');
  });

  it('accented first name matches stripped form in email', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'José',
        lastName: 'M',
        email: 'martinjose@gmail.com',
      }).inferredLastName,
    ).toBe('Martin');
  });
});

describe('inferLastNameFromEmail — common email handle shapes', () => {
  it('"firstName.lastName" form picks last name from the dot suffix', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Juan',
        lastName: 'P',
        email: 'juan.perez@gmail.com',
      }).inferredLastName,
    ).toBe('Perez');
  });

  it('"lastName.firstName" form picks last name from the dot prefix', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Juan',
        lastName: 'P',
        email: 'perez.juan@gmail.com',
      }).inferredLastName,
    ).toBe('Perez');
  });

  it('"firstNameLastName" concatenated form (no separator)', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Maria',
        lastName: 'L',
        email: 'marialopez@gmail.com',
      }).inferredLastName,
    ).toBe('Lopez');
  });

  it('"lastNameFirstName" reversed concatenated form', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Maria',
        lastName: 'L',
        email: 'lopezmaria@gmail.com',
      }).inferredLastName,
    ).toBe('Lopez');
  });

  it('handle with underscores still works after non-alpha strip', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Ana',
        lastName: 'S',
        email: 'ana_silva@gmail.com',
      }).inferredLastName,
    ).toBe('Silva');
  });
});

describe('inferLastNameFromEmail — refuses to hallucinate', () => {
  it('returns null when firstName is not in handle (no anchor)', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Esmeralda',
        lastName: 'P',
        email: 'esme1234@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('returns null when only digits remain after stripping firstName', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Pedro',
        lastName: 'X',
        email: 'pedro1234@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('returns null when remainder is < 3 alphabetic chars', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Juan',
        lastName: 'P',
        email: 'juanab@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('refuses generic email-handle tokens (gmail, info, admin, etc.)', () => {
    // Hypothetical: handle is "juangmail" — "gmail" should NOT become last name.
    expect(
      inferLastNameFromEmail({
        firstName: 'Juan',
        lastName: 'X',
        email: 'juangmail@yahoo.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('refuses "admin", "info", "noreply" type fillers', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Ana',
        lastName: 'X',
        email: 'anaadmin@gmail.com',
      }).inferredLastName,
    ).toBeNull();
    expect(
      inferLastNameFromEmail({
        firstName: 'Ana',
        lastName: 'X',
        email: 'anainfo@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });

  it('returns null for entirely numeric handle', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Juan',
        lastName: 'P',
        email: '12345678@gmail.com',
      }).inferredLastName,
    ).toBeNull();
  });
});

describe('inferLastNameFromEmail — picks the longer of before/after when both exist', () => {
  it('when firstName is in the middle, picks the longer side', () => {
    // Unusual but possible: "abc.juan.pereira" — "juan" in middle.
    // before="abc.", after=".pereira" → stripped: "abc" vs "pereira" → pick "Pereira"
    expect(
      inferLastNameFromEmail({
        firstName: 'Juan',
        lastName: 'P',
        email: 'abc.juan.pereira@gmail.com',
      }).inferredLastName,
    ).toBe('Pereira');
  });
});

describe('inferLastNameFromEmail — output formatting', () => {
  it('returns title case (capitalize first letter)', () => {
    expect(
      inferLastNameFromEmail({
        firstName: 'Esmeralda',
        lastName: 'P',
        email: 'pieriesmeralda@gmail.com',
      }).inferredLastName,
    ).toBe('Pieri');
  });

  it('lowercases the rest of the inferred name', () => {
    // Even if handle had mixed case (rare, emails are usually lowercase),
    // the result is title case.
    expect(
      inferLastNameFromEmail({
        firstName: 'juan',
        lastName: 'p',
        email: 'JUAN.PEREZ@gmail.com',
      }).inferredLastName,
    ).toBe('Perez');
  });
});
