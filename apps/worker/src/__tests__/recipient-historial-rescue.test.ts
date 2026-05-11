import { describe, it, expect } from 'vitest';
import { pickMatchingHistorialRow } from '../dac/shipment';

// Regression tests for the 2026-04-22 #11497 Jenny Pensotti incident.
//
// Background: after clicking Finalizar on the DAC form, the worker relies
// on the browser URL to decide whether DAC accepted or rejected the form:
//   - URL redirected to /envios/guiacreada/<id>  → accepted
//   - URL stayed on /envios/nuevo                → rejected
//
// The URL signal is NOT reliable. In the #11497 incident DAC created guía
// 8821127182837 for the customer Jenny Pensotti (Solymar, Canelones), then
// redirected the browser back to /envios/nuevo (DAC's "start a new
// shipment" flow). The worker interpreted the URL as rejection, threw
// DacAddressRejectedError, wrote a "dirección confusa" note on Shopify,
// and deleted the PendingShipment row. DAC still billed the tenant, the
// customer never got tracking, and the guía was orphaned in DAC.
//
// Fix: when the URL is /envios/nuevo but DAC shows no validation error,
// we now try a RESCUE historial lookup — scrape DAC's historial page and
// look for a row whose visible text matches the recipient name we filled
// on the form. If we find a single guía that (a) is not already in our DB
// and (b) has the customer's name in the row, we adopt it.
//
// Critical safety property: the rescue MUST NOT cause the older
// #11481 Noelia Osorio / 8821122926412 poisoning bug. That happened
// because the previous code picked "the newest guía in historial" with
// no filter — an unrelated guía from a manual DAC shipment got attributed
// to a rejected order. These tests lock in the name-match guard.

type Row = { guia: string; href: string | null; text: string };

describe('pickMatchingHistorialRow', () => {
  // ── Happy path: #11497 rescue ────────────────────────────────────────────
  describe('happy path — rescues a guía whose row matches recipient', () => {
    it('#11497 Jenny Pensotti — finds 8821127182837 when row text has full name', () => {
      const rows: Row[] = [
        {
          guia: '8821127182837',
          href: 'https://www.dac.com.uy/envios/guiacreada/8821127182837',
          text: '8821127182837 JENNY PENSOTTI Río Yi Manzana 669 Solar 8 Solymar Canelones 22/04 20:55',
        },
        {
          guia: '8821127180001',
          href: null,
          text: '8821127180001 OTHER CUSTOMER Some Other Address',
        },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Jenny Pensotti', []);
      expect(picked?.guia).toBe('8821127182837');
    });

    it('case- and accent-insensitive match', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PÉNSOTTI Some address' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'jenny pensotti', []);
      expect(picked?.guia).toBe('8821127182837');
    });

    it('matches when DAC displays name uppercase and we filled mixed case', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: 'ADRIANA ABEIJON 8821127182837 Juan Ortíz 3315 Apto 201 Montevideo' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Adriana Abeijon', []);
      expect(picked?.guia).toBe('8821127182837');
    });
  });

  // ── #11481 Noelia Osorio POISONING regression guard ─────────────────────
  describe('poisoning guard — must NOT match unrelated historial rows', () => {
    it('returns null when no row contains the recipient name', () => {
      const rows: Row[] = [
        // These are real-looking guías from other customers — what the old
        // blind "highest guía in historial" would have picked.
        { guia: '8821122926412', href: null, text: '8821122926412 CARLOS PEREZ Canelones' },
        { guia: '8821122926500', href: null, text: '8821122926500 MARIA LOPEZ Maldonado' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Noelia Osorio', []);
      expect(picked).toBeNull();
    });

    it('short/ambiguous names (<3 usable tokens) return null', () => {
      // "Ana Ri" — both tokens <3 chars after filtering. Refusing these
      // prevents matching any shipment where "Ana" appears in the row.
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 ANALIA RIVERO anywhere' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Ana Ri', []);
      expect(picked).toBeNull();
    });

    it('empty recipient name returns null', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: 'any text with guía' },
      ];
      expect(pickMatchingHistorialRow(rows, '', [])).toBeNull();
      expect(pickMatchingHistorialRow(rows, '   ', [])).toBeNull();
    });

    it('only some of the name tokens matching is NOT enough', () => {
      // "Juan Perez" — if only "Juan" appears in a row (different
      // last name), we must NOT match. Both tokens are required.
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 JUAN GONZALEZ somewhere' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Juan Perez', []);
      expect(picked).toBeNull();
    });

    it('guía already in our DB (excludeGuias) is not re-adopted', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI Solymar' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        ['8821127182837'],
      );
      expect(picked).toBeNull();
    });
  });

  // ── Multi-row: repeat customer ──────────────────────────────────────────
  describe('multiple matching rows — picks highest/newest guía', () => {
    it('repeat customer: picks the highest-numbered guía not in excludeGuias', () => {
      // Jenny ordered before (older guía is in our DB), then ordered again
      // (new guía not yet in our DB). The rescue should pick the newer one.
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 JENNY PENSOTTI old shipment' },
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI new shipment' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        ['8821127100000'],
      );
      expect(picked?.guia).toBe('8821127182837');
    });

    it('when all matching guías are excluded, returns null', () => {
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 JENNY PENSOTTI' },
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        ['8821127100000', '8821127182837'],
      );
      expect(picked).toBeNull();
    });
  });

  // ── Empty/degenerate inputs ─────────────────────────────────────────────
  describe('degenerate inputs', () => {
    it('empty rows returns null', () => {
      expect(pickMatchingHistorialRow([], 'Jenny Pensotti', [])).toBeNull();
    });

    it('rows without any recipient-like text return null', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 99.99' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Jenny Pensotti', []);
      expect(picked).toBeNull();
    });
  });

  // ── 2026-05-11 incident #11865: destination verification ─────────────────
  //
  // Order #11865 Curvadivina (Nelly Susan García Martinicorena) was destined
  // for Tacuarembó. Our form fill set K_Estado="Tacuarembó" + K_Ciudad="Tacuarembo"
  // correctly, but a separate bug (lat/lng coords map missed accent-bearing
  // department names — see shipment.ts ~line 2193) made DAC's geocode-bypass
  // use Montevideo's lat/lng. DAC's backend used those coords as the
  // authoritative destination → minted guía 8821166614737 with
  // "Destino: MONTEVIDEO" instead of Tacuarembó.
  //
  // The rescue path then ADOPTED that bogus guía because it only matched on
  // recipient name. Customer's DAC tracking showed "Destino: MONTEVIDEO" for
  // a Tacuarembó order → package routed to wrong DAC distribution center.
  //
  // Fix: require the historial row's text to ALSO contain the expected city
  // OR department (case-/accent-insensitive). When the destination filter
  // rejects an otherwise-name-matching row, we refuse to adopt and let the
  // order fall through to "needs operator review".
  describe('destination verification (incident #11865)', () => {
    it('adopts guía when row text contains expected department', () => {
      const rows: Row[] = [
        {
          guia: '8821166614737',
          href: null,
          text: '8821166614737 NELLY SUSAN GARCIA MARTINICORENA 18 de Julio 199 Tacuarembo Tacuarembo 09/05',
        },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Nelly Susan García Martinicorena',
        [],
        { city: 'Tacuarembo', department: 'Tacuarembó' },
      );
      expect(picked?.guia).toBe('8821166614737');
    });

    it('adopts guía when row text contains expected city only', () => {
      // Row shows just "Tacuarembo" not the department — common in some DAC views.
      const rows: Row[] = [
        {
          guia: '8821166614737',
          href: null,
          text: '8821166614737 NELLY SUSAN GARCIA MARTINICORENA 18 de Julio 199 Tacuarembo 09/05',
        },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Nelly Susan García Martinicorena',
        [],
        { city: 'Tacuarembo', department: 'Tacuarembó' },
      );
      expect(picked?.guia).toBe('8821166614737');
    });

    it('REFUSES to adopt guía when row shows Montevideo for a Tacuarembó order (the #11865 bug)', () => {
      // The exact failure mode that hit production: Nelly's name matched
      // but DAC created the guía with destino MONTEVIDEO. Returning null
      // here forces the rescue to fail, the order to be parked, and the
      // operator to investigate manually instead of fulfilling Shopify
      // with a wrong-destination tracking number.
      const rows: Row[] = [
        {
          guia: '8821166614737',
          href: null,
          text: '8821166614737 NELLY SUSAN GARCIA MARTINICORENA 18 de Julio 199 MONTEVIDEO 09/05',
        },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Nelly Susan García Martinicorena',
        [],
        { city: 'Tacuarembo', department: 'Tacuarembó' },
      );
      expect(picked).toBeNull();
    });

    it('accent-insensitive destination match: "Río Negro" matches "RIO NEGRO" in row', () => {
      const rows: Row[] = [
        {
          guia: '8821127200000',
          href: null,
          text: '8821127200000 PEDRO RODRIGUEZ Av. Brasil 100 FRAY BENTOS RIO NEGRO',
        },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Pedro Rodriguez',
        [],
        { city: 'Fray Bentos', department: 'Río Negro' },
      );
      expect(picked?.guia).toBe('8821127200000');
    });

    it('multi-word destination: "Treinta y Tres" matches', () => {
      const rows: Row[] = [
        {
          guia: '8821127300000',
          href: null,
          text: '8821127300000 ANA MARTINEZ 18 de Julio 100 Treinta y Tres',
        },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Ana Martinez',
        [],
        { city: null, department: 'Treinta y Tres' },
      );
      expect(picked?.guia).toBe('8821127300000');
    });

    it('legacy callers (no destination param) get name-only behaviour', () => {
      // Pre-#11865 callers (and tests) didn't pass expectedDestination —
      // they must still get the old name-only match, since dropping that
      // would break Jenny Pensotti's case.
      const rows: Row[] = [
        {
          guia: '8821127182837',
          href: null,
          text: '8821127182837 JENNY PENSOTTI Río Yi Solymar Canelones',
        },
      ];
      // No 4th arg
      expect(pickMatchingHistorialRow(rows, 'Jenny Pensotti', [])?.guia).toBe('8821127182837');
      // null is also accepted as "skip destination check"
      expect(pickMatchingHistorialRow(rows, 'Jenny Pensotti', [], null)?.guia).toBe('8821127182837');
    });

    it('null/undefined fields in expectedDestination are skipped (effectively disable check if both null)', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI' },
      ];
      // Both null → falls back to name-only match (no destination tokens to require)
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        [],
        { city: null, department: null },
      );
      expect(picked?.guia).toBe('8821127182837');
    });

    it('short destination strings (<4 chars) are skipped to avoid false-positive substring matches', () => {
      // A 1- or 2-char dept like "TA" (Tacuarembó province code) would match
      // way too many substrings ("Av. Italia" contains "ta"...). We require
      // >= 4 chars normalised before adding to the destination filter.
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI Av. Italia 1000 MONTEVIDEO' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        [],
        { city: 'TA', department: null }, // 2 chars → ignored
      );
      // No dest filter applied; name-only match adopts the row.
      expect(picked?.guia).toBe('8821127182837');
    });

    it('mixed expected dept name with accent matches accent-stripped row text', () => {
      const rows: Row[] = [
        {
          guia: '8821127400000',
          href: null,
          text: '8821127400000 LUIS GOMEZ Av. Brasil PAYSANDU',
        },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Luis Gomez',
        [],
        { city: null, department: 'Paysandú' }, // accented
      );
      expect(picked?.guia).toBe('8821127400000');
    });
  });
});

// ── 2026-05-11 incident #11865: lat/lng coords accent regression ─────────
//
// Pure regression test for the bug that caused DAC to mint guías with the
// wrong destination. The buggy code lived inside a page.evaluate() and
// looked like this:
//
//   const deptText = deptEl?.options[deptEl.selectedIndex]?.text?.toLowerCase() ?? '';
//   const coords = { 'tacuarembo': [...], 'paysandu': [...], ... };
//   const c = coords[deptText] ?? coords['montevideo'];
//
// The DAC dropdown shows "Tacuarembó" (with accent). toLowerCase preserves
// the accent → lookup fails → falls back to Montevideo coords → DAC's
// geocoder uses MVD coords → guía minted with destino MONTEVIDEO.
//
// The fix is `.normalize('NFD').replace(/[̀-ͯ]/g, '')` before the
// lookup. These tests document the bug and exercise the same normalization
// in isolation so a refactor of the inline page.evaluate code can't reintroduce
// the regression silently.
describe('lat/lng coords accent regression (incident #11865)', () => {
  // Same map as shipment.ts ~line 2200. Keep in sync if departments change.
  const COORDS: Record<string, [string, string]> = {
    'montevideo': ['-34.9011', '-56.1645'],
    'canelones': ['-34.5229', '-56.2817'],
    'maldonado': ['-34.9093', '-54.9588'],
    'colonia': ['-34.4625', '-57.8399'],
    'salto': ['-31.3883', '-57.9609'],
    'paysandu': ['-32.3213', '-58.0756'],
    'rivera': ['-30.9053', '-55.5508'],
    'tacuarembo': ['-31.7110', '-55.9834'],
    'rocha': ['-34.4833', '-54.2220'],
    'florida': ['-34.0994', '-56.2144'],
    'durazno': ['-33.3794', '-56.5227'],
    'lavalleja': ['-34.3519', '-55.2331'],
    'san jose': ['-34.3369', '-56.7133'],
    'soriano': ['-33.5098', '-57.7524'],
    'rio negro': ['-33.1195', '-58.3025'],
    'flores': ['-33.5239', '-56.8919'],
    'artigas': ['-30.4006', '-56.4674'],
    'cerro largo': ['-32.3739', '-54.1784'],
    'treinta y tres': ['-33.2305', '-54.3836'],
  };

  // Mirrors the inline normalization in shipment.ts page.evaluate.
  // Tests this exactly the same way DAC's selected-option text is processed.
  function normalizeDept(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim();
  }

  // The exact dropdown texts DAC renders in K_Estado (verified against
  // shipment.ts logs from 2026-05-09 — line: "Selecting department: Tacuarembó").
  const DAC_DROPDOWN_DEPTS = [
    'Montevideo',
    'Canelones',
    'Maldonado',
    'Colonia',
    'Salto',
    'Paysandú',
    'Rivera',
    'Tacuarembó',
    'Rocha',
    'Florida',
    'Durazno',
    'Lavalleja',
    'San José',
    'Soriano',
    'Río Negro',
    'Flores',
    'Artigas',
    'Cerro Largo',
    'Treinta y Tres',
  ];

  it('every DAC dropdown department resolves to its OWN coordinates (not MVD fallback)', () => {
    const failures: { dept: string; got: string }[] = [];
    for (const raw of DAC_DROPDOWN_DEPTS) {
      const norm = normalizeDept(raw);
      const coords = COORDS[norm];
      if (!coords) {
        failures.push({ dept: raw, got: 'undefined → MVD fallback' });
      }
    }
    expect(failures).toEqual([]);
  });

  it('Tacuarembó normalizes to "tacuarembo" (NOT "tacuarembó")', () => {
    expect(normalizeDept('Tacuarembó')).toBe('tacuarembo');
    expect(COORDS[normalizeDept('Tacuarembó')]).toEqual(['-31.7110', '-55.9834']);
  });

  it('Paysandú normalizes to "paysandu"', () => {
    expect(normalizeDept('Paysandú')).toBe('paysandu');
    expect(COORDS[normalizeDept('Paysandú')]).toEqual(['-32.3213', '-58.0756']);
  });

  it('Río Negro normalizes to "rio negro"', () => {
    expect(normalizeDept('Río Negro')).toBe('rio negro');
    expect(COORDS[normalizeDept('Río Negro')]).toEqual(['-33.1195', '-58.3025']);
  });

  it('San José normalizes to "san jose"', () => {
    expect(normalizeDept('San José')).toBe('san jose');
    expect(COORDS[normalizeDept('San José')]).toEqual(['-34.3369', '-56.7133']);
  });

  it('THE BUG: without NFD normalization, accented depts fall back to MVD coords', () => {
    // This documents the OLD buggy behaviour. If anyone reverts the fix,
    // this test will start failing in a way that points right at the bug.
    const buggyLookup = (s: string) => s.toLowerCase(); // no NFD
    expect(COORDS[buggyLookup('Tacuarembó')]).toBeUndefined();
    expect(COORDS[buggyLookup('Paysandú')]).toBeUndefined();
    expect(COORDS[buggyLookup('Río Negro')]).toBeUndefined();
    expect(COORDS[buggyLookup('San José')]).toBeUndefined();
    // The 15 unaccented depts still worked under the old code:
    expect(COORDS[buggyLookup('Montevideo')]).toBeDefined();
    expect(COORDS[buggyLookup('Canelones')]).toBeDefined();
    expect(COORDS[buggyLookup('Cerro Largo')]).toBeDefined();
  });
});
