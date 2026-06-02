// Agency-office (Oficina / "Agencia *") resolution — load-bearing for the
// agency-pickup flow (TipoEntrega=Agencia).
//
// Background (audit 2026-06-02): DAC's new-shipment form shows a REQUIRED
// <select name="Oficina"> when the customer collects at a branch. AJAX-
// populated per department, option text = "<Name> (<address>)". The worker
// never filled it, so every agency pickup passed the cart-add but was SILENTLY
// rejected at Finalizar — the root cause of parked #5404 ("DAC Tres Cruces")
// and #5399 ("DAC Ciudad del Plata"). These tests pin the two pure helpers:
//   - extractAgencyPlace: pulls the branch name out of free-text pickup notes
//   - matchAgencyOffice: deterministically maps that name to a live option,
//     with a hard ambiguity guard (never misroute → leave empty instead)
//
// Option sets below are modelled on the live read-only DOM probe (2026-06-02):
//   Montevideo includes 661 "Tres Cruces ( )"
//   San José   includes 642 "Ciudad Del Plata (Pamplona 3603)"
//   Rivera     includes 913 "Tranqueras (Veinticinco De Agosto 680)"

import { describe, it, expect } from 'vitest';
import { extractAgencyPlace, matchAgencyOffice, type AgencyOption } from '../dac/shipment';

const MONTEVIDEO: AgencyOption[] = [
  { value: '661', text: 'Tres Cruces ( )' },
  { value: '662', text: 'Agencia Pocitos (Av Brasil 2000)' },
  { value: '663', text: 'Carrasco (Av Italia 7000)' },
  { value: '664', text: 'Paso Molino (Agraciada 3500)' },
  { value: '665', text: 'Centro (18 De Julio 1000)' },
];

const SAN_JOSE: AgencyOption[] = [
  { value: '642', text: 'Ciudad Del Plata (Pamplona 3603)' },
  { value: '640', text: 'San José De Mayo (Artigas 500)' },
  { value: '641', text: 'Libertad (Treinta Y Tres 200)' },
];

const RIVERA: AgencyOption[] = [
  { value: '913', text: 'Tranqueras (Veinticinco De Agosto 680)' },
  { value: '910', text: 'Rivera Centro (Sarandi 100)' },
  { value: '911', text: 'Minas De Corrales (Principal 50)' },
];

describe('extractAgencyPlace', () => {
  it('strips the DAC brand prefix to the branch name', () => {
    expect(extractAgencyPlace('DAC Tres Cruces', '', '')).toBe('Tres Cruces');
    expect(extractAgencyPlace('Dac Ciudad del Plata', '', '')).toBe('Ciudad del Plata');
  });

  it('strips "retiro"/"agencia"/"sucursal" boilerplate but keeps the place', () => {
    expect(extractAgencyPlace('Retiro en agencia Tranqueras', '', '').toLowerCase()).toContain('tranqueras');
    expect(extractAgencyPlace('Sucursal de Dac Buceo', '', '').toLowerCase()).toContain('buceo');
  });

  it('falls through to address2 / note when address1 has no place name', () => {
    // bare "Retiro" carries no branch name → look at the note
    expect(
      extractAgencyPlace('Retiro', '', 'paso a retirar por DAC tres cruces').toLowerCase(),
    ).toContain('tres cruces');
  });

  it('returns empty string when there is no recoverable place name', () => {
    expect(extractAgencyPlace('Retiro', '', '')).toBe('');
    expect(extractAgencyPlace('', '', '')).toBe('');
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(extractAgencyPlace(null, null, null)).toBe('');
    expect(extractAgencyPlace(undefined, undefined, undefined)).toBe('');
  });
});

describe('matchAgencyOffice — confident matches', () => {
  it('matches "tres cruces" to Montevideo agency 661', () => {
    expect(matchAgencyOffice('tres cruces', MONTEVIDEO)?.value).toBe('661');
  });

  it('matches the #5404 case end-to-end (DAC Tres Cruces → 661)', () => {
    const place = extractAgencyPlace('DAC Tres Cruces', '', '');
    expect(matchAgencyOffice(place, MONTEVIDEO)?.value).toBe('661');
  });

  it('matches the #5399 case end-to-end (DAC Ciudad del Plata → 642)', () => {
    const place = extractAgencyPlace('Dac Ciudad del Plata', '', '');
    expect(matchAgencyOffice(place, SAN_JOSE)?.value).toBe('642');
  });

  it('matches a subset ("ciudad de tranqueras" → 913 Tranqueras)', () => {
    expect(matchAgencyOffice('ciudad de tranqueras', RIVERA)?.value).toBe('913');
  });

  it('matches when the place comes straight from the city field', () => {
    expect(matchAgencyOffice('Ciudad del Plata', SAN_JOSE)?.value).toBe('642');
    expect(matchAgencyOffice('Tranqueras', RIVERA)?.value).toBe('913');
  });

  it('is diacritic- and case-insensitive', () => {
    expect(matchAgencyOffice('TRÉS CRUCÉS', MONTEVIDEO)?.value).toBe('661');
  });
});

describe('matchAgencyOffice — refuses to guess (leaves Oficina empty)', () => {
  it('returns null when the place names the department, not a branch', () => {
    // No agency is literally named "Montevideo" → no confident match
    expect(matchAgencyOffice('montevideo', MONTEVIDEO)).toBeNull();
  });

  it('returns null for an unknown place', () => {
    expect(matchAgencyOffice('lugar inexistente xyz', MONTEVIDEO)).toBeNull();
  });

  it('returns null for empty / whitespace place text', () => {
    expect(matchAgencyOffice('', MONTEVIDEO)).toBeNull();
    expect(matchAgencyOffice('   ', MONTEVIDEO)).toBeNull();
  });

  it('returns null when two options tie (ambiguity guard)', () => {
    const ambiguous: AgencyOption[] = [
      { value: '1', text: 'Centro (Calle A 100)' },
      { value: '2', text: 'Centro (Calle B 200)' },
    ];
    expect(matchAgencyOffice('centro', ambiguous)).toBeNull();
  });

  it('returns null when no option clears the score>=2 threshold', () => {
    // shares a single short/stopword-ish token only
    expect(matchAgencyOffice('de la', MONTEVIDEO)).toBeNull();
  });

  it('handles an empty option list', () => {
    expect(matchAgencyOffice('tres cruces', [])).toBeNull();
  });
});
