import { describe, it, expect } from 'vitest';
import {
  getDepartmentFromZip,
  shouldPinMontevideoFromZip,
  isAmbiguousCityName,
  isValidUruguayProvince,
  DEPARTMENT_ZIP_PREFIX,
  AMBIGUOUS_CITY_NAMES,
  URUGUAY_DEPARTMENTS_NORMALIZED,
  getDepartmentForCity,
} from '../dac/uruguay-geo';

/**
 * Audit 2026-05-05 regression suite — fixes the misroute of
 * Tacuarembó/Río Negro (and other interior) orders to Montevideo.
 *
 * Two root causes:
 *   1. DEPARTMENT_ZIP_PREFIX had ~15 wrong mappings (45=RioNegro should
 *      have been Tacuarembó, 65=Flores should have been RíoNegro, etc.)
 *   2. shipment.ts blindly trusted the city-name lookup over Shopify's
 *      province, even when the city was an ambiguous generic word
 *      ("Centro", "Cerro", "Bella Vista"). A customer in Tacuarembó
 *      who typed `city: "Centro"` was being shipped to Montevideo.
 *
 * These tests lock in the corrected behavior so it can never regress.
 */

describe('Audit 2026-05-05: ZIP prefix mapping (real Uruguay codes)', () => {
  // Each (zip, expected) pair was verified against ~5,400 real production
  // orders. The previous (buggy) mapping is shown in the comment.
  const REAL_UY_PREFIXES: Array<[string, string, string?]> = [
    ['11000', 'Montevideo'],
    ['12500', 'Montevideo'],
    ['13000', 'Montevideo'],
    ['15000', 'Canelones'],   // Costa de Oro — El Pinar, Lagomar
    ['16200', 'Canelones'],   // La Floresta
    ['20000', 'Maldonado'],
    ['20100', 'Maldonado'],   // Punta del Este area
    ['27000', 'Rocha',         'was wrongly "Treinta y Tres"'],
    ['30000', 'Lavalleja',     'was wrongly "Cerro Largo"'],
    ['33000', 'Treinta y Tres','was wrongly "Rivera"'],
    ['37000', 'Cerro Largo',   'was wrongly "Salto"'],
    ['40000', 'Rivera',        'was wrongly "Paysandu"'],
    ['45000', 'Tacuarembo',    'was wrongly "Rio Negro" — THIS is the audit bug'],
    ['45100', 'Tacuarembo',    'Paso de los Toros'],
    ['50000', 'Salto',         'was wrongly "Colonia"'],
    ['55000', 'Artigas'],
    ['60000', 'Paysandu',      'was wrongly "San Jose"'],
    ['65000', 'Rio Negro',     'was wrongly "Flores" — Fray Bentos'],
    ['65100', 'Rio Negro',     'Young'],
    ['70000', 'Colonia',       'was wrongly "Florida"'],
    ['75000', 'Soriano',       'was wrongly "Durazno" — Mercedes'],
    ['80000', 'San Jose',      'was wrongly "Lavalleja"'],
    ['85000', 'Flores',        'was wrongly "Tacuarembo" — Trinidad'],
    ['90000', 'Canelones',     'was wrongly "Treinta y Tres"'],
    ['91000', 'Canelones',     'was wrongly "Cerro Largo" — Pando, Tala, Sauce'],
    ['94000', 'Florida'],
  ];

  it.each(REAL_UY_PREFIXES)('ZIP %s → %s', (zip, expected) => {
    expect(getDepartmentFromZip(zip)).toBe(expected);
  });

  it('returns null for prefixes intentionally removed (ambiguous in real data)', () => {
    // 17, 21, 25, 35, 47 had no production orders; old mappings were guesses.
    // 97, 98 had ambiguous distributions (Rivera vs Durazno, Florida vs Durazno).
    // Letting the city-name resolver handle these is safer than a wrong default.
    expect(getDepartmentFromZip('17000')).toBeNull();
    expect(getDepartmentFromZip('21000')).toBeNull();
    expect(getDepartmentFromZip('25000')).toBeNull();
    expect(getDepartmentFromZip('35000')).toBeNull();
    expect(getDepartmentFromZip('47000')).toBeNull();
    expect(getDepartmentFromZip('97000')).toBeNull();
    expect(getDepartmentFromZip('98000')).toBeNull();
  });

  it('every entry in DEPARTMENT_ZIP_PREFIX is a valid UY department', () => {
    for (const [, dept] of Object.entries(DEPARTMENT_ZIP_PREFIX)) {
      const normalized = dept.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      expect(URUGUAY_DEPARTMENTS_NORMALIZED.has(normalized)).toBe(true);
    }
  });
});

describe('Audit 2026-05-05: ambiguous city-name detection', () => {
  it('flags generic single-word city names', () => {
    expect(isAmbiguousCityName('Centro')).toBe(true);
    expect(isAmbiguousCityName('centro')).toBe(true);
    expect(isAmbiguousCityName('CENTRO')).toBe(true);
    expect(isAmbiguousCityName('Cerro')).toBe(true);
    expect(isAmbiguousCityName('Bella Vista')).toBe(true);
    expect(isAmbiguousCityName('bella vista')).toBe(true);
    expect(isAmbiguousCityName('Manga')).toBe(true);
    expect(isAmbiguousCityName('Prado')).toBe(true);
    expect(isAmbiguousCityName('Union')).toBe(true);
    expect(isAmbiguousCityName('La Union')).toBe(true);
    expect(isAmbiguousCityName('Colon')).toBe(true);
  });

  it('flags slash-form compounds the customer types', () => {
    // From real misroute #11673 — customer typed "Centro/San Carlos" meaning
    // "centro de San Carlos" (Maldonado), got shipped to Montevideo.
    expect(isAmbiguousCityName('Centro/San Carlos')).toBe(true);
    expect(isAmbiguousCityName('centro/montevideo')).toBe(true);
    expect(isAmbiguousCityName('Centro/Rivera')).toBe(true);
    expect(isAmbiguousCityName('Centro/Tacuarembo')).toBe(true);
  });

  it('does NOT flag specific Montevideo barrios', () => {
    expect(isAmbiguousCityName('Pocitos')).toBe(false);
    expect(isAmbiguousCityName('Carrasco')).toBe(false);
    expect(isAmbiguousCityName('Punta Carretas')).toBe(false);
    expect(isAmbiguousCityName('Buceo')).toBe(false);
    expect(isAmbiguousCityName('Malvin')).toBe(false);
    expect(isAmbiguousCityName('Palermo')).toBe(false);
  });

  it('does NOT flag interior city names', () => {
    expect(isAmbiguousCityName('Tacuarembo')).toBe(false);
    expect(isAmbiguousCityName('Tacuarembó')).toBe(false);
    expect(isAmbiguousCityName('Fray Bentos')).toBe(false);
    expect(isAmbiguousCityName('Young')).toBe(false);
    expect(isAmbiguousCityName('Mercedes')).toBe(false);
    expect(isAmbiguousCityName('Trinidad')).toBe(false);
    expect(isAmbiguousCityName('Salto')).toBe(false);
    expect(isAmbiguousCityName('Maldonado')).toBe(false);
  });

  it('handles null/empty/whitespace safely', () => {
    expect(isAmbiguousCityName(null)).toBe(false);
    expect(isAmbiguousCityName(undefined)).toBe(false);
    expect(isAmbiguousCityName('')).toBe(false);
    expect(isAmbiguousCityName('   ')).toBe(false);
  });

  it('AMBIGUOUS_CITY_NAMES is exposed and includes the audit-confirmed bug triggers', () => {
    expect(AMBIGUOUS_CITY_NAMES.has('centro')).toBe(true);
    expect(AMBIGUOUS_CITY_NAMES.has('bella vista')).toBe(true);
    expect(AMBIGUOUS_CITY_NAMES.has('centro/san carlos')).toBe(true);
  });
});

describe('Audit 2026-05-05: Uruguay province validation', () => {
  it('accepts all 19 official department names', () => {
    expect(isValidUruguayProvince('Montevideo')).toBe(true);
    expect(isValidUruguayProvince('Canelones')).toBe(true);
    expect(isValidUruguayProvince('Maldonado')).toBe(true);
    expect(isValidUruguayProvince('Rocha')).toBe(true);
    expect(isValidUruguayProvince('Lavalleja')).toBe(true);
    expect(isValidUruguayProvince('Treinta y Tres')).toBe(true);
    expect(isValidUruguayProvince('Cerro Largo')).toBe(true);
    expect(isValidUruguayProvince('Rivera')).toBe(true);
    expect(isValidUruguayProvince('Tacuarembó')).toBe(true);
    expect(isValidUruguayProvince('Tacuarembo')).toBe(true);
    expect(isValidUruguayProvince('Salto')).toBe(true);
    expect(isValidUruguayProvince('Artigas')).toBe(true);
    expect(isValidUruguayProvince('Paysandú')).toBe(true);
    expect(isValidUruguayProvince('Paysandu')).toBe(true);
    expect(isValidUruguayProvince('Río Negro')).toBe(true);
    expect(isValidUruguayProvince('Rio Negro')).toBe(true);
    expect(isValidUruguayProvince('Soriano')).toBe(true);
    expect(isValidUruguayProvince('Colonia')).toBe(true);
    expect(isValidUruguayProvince('San José')).toBe(true);
    expect(isValidUruguayProvince('San Jose')).toBe(true);
    expect(isValidUruguayProvince('Flores')).toBe(true);
    expect(isValidUruguayProvince('Florida')).toBe(true);
    expect(isValidUruguayProvince('Durazno')).toBe(true);
  });

  it('handles case and accent variations', () => {
    expect(isValidUruguayProvince('MONTEVIDEO')).toBe(true);
    expect(isValidUruguayProvince('  Montevideo  ')).toBe(true);
    expect(isValidUruguayProvince('rio negro')).toBe(true);
    expect(isValidUruguayProvince('  Río Negro  ')).toBe(true);
  });

  it('rejects non-UY/garbage inputs', () => {
    expect(isValidUruguayProvince(null)).toBe(false);
    expect(isValidUruguayProvince(undefined)).toBe(false);
    expect(isValidUruguayProvince('')).toBe(false);
    expect(isValidUruguayProvince('Buenos Aires')).toBe(false);
    expect(isValidUruguayProvince('NY')).toBe(false);
    expect(isValidUruguayProvince('asdf')).toBe(false);
  });
});

describe('Audit 2026-05-05: city-name resolver still works as before for valid cities', () => {
  // Smoke-check that adding the ambiguity helpers didn't change the
  // existing getDepartmentForCity behavior — which other tests already
  // cover comprehensively.
  it('resolves correct interior cities to their departments', () => {
    expect(getDepartmentForCity('Tacuarembo')).toBe('Tacuarembo');
    expect(getDepartmentForCity('Tacuarembó')).toBe('Tacuarembo');
    expect(getDepartmentForCity('Fray Bentos')).toBe('Rio Negro');
    expect(getDepartmentForCity('Young')).toBe('Rio Negro');
    expect(getDepartmentForCity('Mercedes')).toBe('Soriano');
    expect(getDepartmentForCity('Trinidad')).toBe('Flores');
  });

  it('still returns Montevideo for the ambiguous names — the GUARD is in shipment.ts', () => {
    // The geo DB itself is unchanged: "Centro" → Montevideo as a barrio.
    // The fix is at the *consumer* side: shipment.ts now refuses to
    // override a non-MVD Shopify province with this MVD result when the
    // city name is in the ambiguity list.
    expect(getDepartmentForCity('Centro')).toBe('Montevideo');
    expect(getDepartmentForCity('Cerro')).toBe('Montevideo');
    expect(getDepartmentForCity('Bella Vista')).toBe('Montevideo');
  });
});

describe('shouldPinMontevideoFromZip — ZIP-11 authority (2026-06-16 street-name misroute)', () => {
  it('pins Montevideo when ZIP is 11xxx but the dept resolved elsewhere (#2348 regression)', () => {
    // "SAN Jose 807", city=Montevideo, zip=11100 was routed to "San José"
    // because the resolver matched the STREET name "San José". ZIP 11 must win.
    expect(shouldPinMontevideoFromZip('11100', 'San Jose')).toBe(true);
    expect(shouldPinMontevideoFromZip('11200', 'Canelones')).toBe(true);
  });

  it('does NOT pin when the order already resolved to Montevideo (no-op, case-insensitive)', () => {
    expect(shouldPinMontevideoFromZip('11100', 'Montevideo')).toBe(false);
    expect(shouldPinMontevideoFromZip('11100', 'montevideo')).toBe(false);
    expect(shouldPinMontevideoFromZip('11100', 'MONTEVIDEO')).toBe(false);
  });

  it('does NOT pin when the ZIP is a real interior ZIP (never overrides a correct interior order)', () => {
    // 80100 = San José de Mayo (Libertad) — a genuine San José zip; leave it.
    expect(shouldPinMontevideoFromZip('80100', 'San Jose')).toBe(false);
    expect(shouldPinMontevideoFromZip('20000', 'Canelones')).toBe(false);
  });

  it('does NOT pin when there is no usable ZIP (no signal to act on)', () => {
    expect(shouldPinMontevideoFromZip(null, 'San Jose')).toBe(false);
    expect(shouldPinMontevideoFromZip(undefined, 'San Jose')).toBe(false);
    expect(shouldPinMontevideoFromZip('', 'San Jose')).toBe(false);
    expect(shouldPinMontevideoFromZip('1', 'San Jose')).toBe(false); // too short to have a prefix
  });

  it('tolerates a missing resolved dept (treats it as not-Montevideo -> pins)', () => {
    expect(shouldPinMontevideoFromZip('11500', '')).toBe(true);
    expect(shouldPinMontevideoFromZip('11500', null as unknown as string)).toBe(true);
  });
});
