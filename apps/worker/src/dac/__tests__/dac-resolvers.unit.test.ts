/**
 * Unit tests for the deterministic resolvers.
 *
 * These tests run WITHOUT any API key — they exercise only the pure rule-based
 * logic in `dac-dept-resolver.ts` and `dac-city-resolver.ts`. They are the fast
 * safety net that catches regressions when we tweak the rules.
 *
 * Integration coverage (live Anthropic API) lives in
 * `ai-resolver.integration.test.ts` and `scripts/run-resolver-suite.ts`.
 */

import { describe, it, expect } from 'vitest';
import { resolveDepartmentDeterministic } from '../dac-dept-resolver';
import { resolveCityDeterministic } from '../dac-city-resolver';

// ─── resolveDepartmentDeterministic ────────────────────────────────────

describe('resolveDepartmentDeterministic — ZIP prefix rule', () => {
  it('ZIP 11200 → Montevideo (high)', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Montevideo',
      address1: '18 de Julio 1234',
      address2: '',
      zip: '11200',
    });
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Montevideo');
    expect(r!.matchedVia).toBe('zip');
    expect(r!.confidence).toBe('high');
  });

  it('ZIP 90100 → Canelones (high)', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Ciudad de la Costa',
      address1: 'Av. Giannattasio 5678',
      address2: '',
      zip: '90100',
    });
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Canelones');
  });

  it('ZIP 20000 + Maldonado → Maldonado', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Maldonado',
      address1: 'Sarandí 900',
      address2: '',
      zip: '20000',
    });
    expect(r!.department).toBe('Maldonado');
  });

  it('ZIP contradicted by address capital → address wins', () => {
    // ZIP says MVD but address2 says Tacuarembó. The rule 1 contradiction
    // check falls through and lets rule 2 pick Tacuarembó.
    const r = resolveDepartmentDeterministic({
      city: 'Montevideo',
      address1: '18 de Julio 1234',
      address2: 'Tacuarembó',
      zip: '11200',
    });
    expect(r!.department).toBe('Tacuarembo');
    expect(r!.matchedVia).toBe('address-capital');
  });
});

describe('resolveDepartmentDeterministic — address capital rule', () => {
  it('address2="Minas" → Lavalleja', () => {
    const r = resolveDepartmentDeterministic({
      city: '',
      address1: '25 de Mayo 100',
      address2: 'Minas',
    });
    expect(r!.department).toBe('Lavalleja');
    expect(r!.matchedVia).toBe('address-capital');
  });

  it('city="Paysandu" → Paysandu', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Paysandu',
      address1: '18 de Julio',
      address2: '',
    });
    expect(r!.department).toBe('Paysandu');
  });

  it('city="Colonia del Sacramento" → Colonia', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Colonia del Sacramento',
      address1: 'General Flores 300',
      address2: '',
    });
    expect(r!.department).toBe('Colonia');
  });

  it('"Florida" in city field → Florida department', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Florida',
      address1: 'Independencia 500',
      address2: '',
    });
    expect(r!.department).toBe('Florida');
  });
});

describe('resolveDepartmentDeterministic — major non-capital city rule', () => {
  it('city="Punta del Este" → Maldonado', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Punta del Este',
      address1: 'Gorlero 500',
      address2: '',
    });
    expect(r!.department).toBe('Maldonado');
  });

  it('city="Young" → Rio Negro', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Young',
      address1: '18 de Julio 200',
      address2: '',
    });
    expect(r!.department).toBe('Rio Negro');
  });

  it('city="Juan Lacaze" → Colonia (via aliases)', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Juan Lacaze',
      address1: 'Artigas 100',
      address2: '',
    });
    expect(r!.department).toBe('Colonia');
  });

  it('city="Ciudad del Plata" → San Jose (not Canelones)', () => {
    // Regression check for the overlap fix.
    const r = resolveDepartmentDeterministic({
      city: 'Ciudad del Plata',
      address1: 'Ruta 1 km 25',
      address2: '',
    });
    expect(r!.department).toBe('San Jose');
  });

  it('address1 with "25 de Agosto" street name does NOT pick Florida (regression C03)', () => {
    // "25 de Agosto" is Uruguay's Independence Day and a street name in EVERY
    // town. address2 says "San Carlos" which is Maldonado — the shortcut
    // should respect that, not get hijacked by the street name.
    const r = resolveDepartmentDeterministic({
      city: 'Montevideo',
      address1: '25 de Agosto 700',
      address2: 'San Carlos',
    });
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Maldonado');
  });

  it('address1="Artigas 1234" alone → null (street name, not dept)', () => {
    const r = resolveDepartmentDeterministic({
      city: '',
      address1: 'Artigas 1234',
      address2: '',
    });
    expect(r).toBeNull();
  });

  it('"Treinta y Tres 100" street + address2="Trinidad" → Flores (regression D09)', () => {
    // "Treinta y Tres" is the 33 Orientales (national heroes) — a street name
    // in every UY town. The real signal is "Trinidad" (capital of Flores) in
    // address2. The shortcut must skip the street name in address1 and fall
    // through to the capital match in address2.
    const r = resolveDepartmentDeterministic({
      city: 'Montevideo',
      address1: 'Treinta y Tres 100',
      address2: 'Trinidad',
    });
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Flores');
  });

  it('city="Mdeo" + address1="Canelones 985" → null (Canelones is a MVD street, regression from real prod)', () => {
    // From Manuel Garcia sample #9: city="Mdeo" (abbrev for Montevideo),
    // address1="Canelones 985/001". "Canelones" here is a MVD downtown street
    // (runs through Centro/Cordón), not the department. Our resolver must NOT
    // claim Canelones — falling through to AI lets it correctly return MVD.
    const r = resolveDepartmentDeterministic({
      city: 'Mdeo',
      address1: 'Canelones 985/001',
      address2: 'Apartamento',
    });
    expect(r).toBeNull();
  });

  it('"Calle Melo 300" street + address2="Las Piedras, Canelones" → Canelones (regression H08)', () => {
    // "Melo" is both the capital of Cerro Largo AND a common street name. The
    // real signal is "Canelones" in address2. The shortcut must skip "Melo"
    // in address1 and find "canelones" in address2.
    const r = resolveDepartmentDeterministic({
      city: 'Montevideo',
      address1: 'Calle Melo 300',
      address2: 'Las Piedras, Canelones',
    });
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Canelones');
  });

  it('city="Ciudad de la Costa" → Canelones', () => {
    const r = resolveDepartmentDeterministic({
      city: 'Ciudad de la Costa',
      address1: 'Av. Giannattasio 5678',
      address2: '',
    });
    expect(r!.department).toBe('Canelones');
  });
});

describe('resolveDepartmentDeterministic — ambiguous names defer to AI', () => {
  it('city="Las Piedras" alone → returns something (not null) but may defer', () => {
    // "Las Piedras" is AMBIGUOUS (Canelones big city / Artigas pueblito).
    // Our rules skip ambiguous names in the major-city scan, but the DAC
    // city index in rule 4 may still claim it if only one dept has it.
    // This test locks in whatever behavior we have so a regression surfaces.
    const r = resolveDepartmentDeterministic({
      city: 'Las Piedras',
      address1: '',
      address2: '',
    });
    // We accept either null (deferred to AI) OR Canelones if index resolves it
    // uniquely — DAC only lists "Las Piedras" under Canelones, so rule 4 (city
    // exact unique) lets it through but we guard with AMBIGUOUS_LOCALITIES.
    // The AMBIGUOUS guard catches city="Las Piedras" BEFORE rule 4, so null.
    expect(r).toBeNull();
  });

  it('empty everything → null', () => {
    const r = resolveDepartmentDeterministic({
      city: '',
      address1: '',
      address2: '',
    });
    expect(r).toBeNull();
  });
});

describe('resolveDepartmentDeterministic — city-exact-unique rule', () => {
  it('city="Piriapolis" → Maldonado (via DAC unique match)', () => {
    // "Piriápolis" without accent, matches DAC "Piriapolis" exactly.
    // It's also in MAJOR_NON_CAPITAL_CITIES so rule 3 catches it first.
    const r = resolveDepartmentDeterministic({
      city: 'Piriápolis',
      address1: '',
      address2: '',
    });
    expect(r!.department).toBe('Maldonado');
  });
});

describe('resolveDepartmentDeterministic — province fallback', () => {
  it('province="Salto" with empty everything else → medium confidence Salto', () => {
    const r = resolveDepartmentDeterministic({
      city: '',
      address1: '',
      address2: '',
      province: 'Salto',
    });
    expect(r!.department).toBe('Salto');
    expect(r!.matchedVia).toBe('province');
    expect(r!.confidence).toBe('medium');
  });

  it('province=empty → null', () => {
    const r = resolveDepartmentDeterministic({
      city: '',
      address1: '',
      address2: '',
      province: '',
    });
    expect(r).toBeNull();
  });
});

// ─── resolveCityDeterministic ──────────────────────────────────────────

describe('resolveCityDeterministic — exact-after-normalize', () => {
  it('Colonia + "Colonia del Sacramento" → DAC "Colonia Del Sacramento"', () => {
    const r = resolveCityDeterministic('Colonia', {
      city: 'Colonia del Sacramento',
      address1: '',
      address2: '',
    });
    expect(r).not.toBeNull();
    expect(r!.city).toBe('Colonia Del Sacramento');
    expect(r!.matchedVia).toBe('city-exact');
    expect(r!.confidence).toBe('high');
  });

  it('Colonia + "Juan Lacaze" → DAC "Juan Lacaze"', () => {
    const r = resolveCityDeterministic('Colonia', {
      city: 'Juan Lacaze',
      address1: '',
      address2: '',
    });
    expect(r!.city).toBe('Juan Lacaze');
  });

  it('Rio Negro + "Young" → DAC "Young"', () => {
    const r = resolveCityDeterministic('Rio Negro', {
      city: 'Young',
      address1: '',
      address2: '',
    });
    expect(r!.city).toBe('Young');
  });

  it('Maldonado + "Punta del Este" → DAC "Punta Del Este"', () => {
    const r = resolveCityDeterministic('Maldonado', {
      city: 'Punta del Este',
      address1: '',
      address2: '',
    });
    expect(r!.city).toBe('Punta Del Este');
  });
});

describe('resolveCityDeterministic — address-scan fallback', () => {
  it('Colonia + city="" + address2="Juan Lacaze" → DAC "Juan Lacaze"', () => {
    const r = resolveCityDeterministic('Colonia', {
      city: '',
      address1: 'Artigas 100',
      address2: 'Juan Lacaze',
    });
    expect(r!.city).toBe('Juan Lacaze');
    expect(r!.matchedVia).toBe('address-scan');
    // confidence downgrades to medium when match is outside the city field
    expect(r!.confidence).toBe('medium');
  });

  it('San Jose + city="San José de Mayo" → DAC "San Jose De Mayo"', () => {
    const r = resolveCityDeterministic('San Jose', {
      city: 'San José de Mayo',
      address1: '',
      address2: '',
    });
    expect(r!.city).toBe('San Jose De Mayo');
  });
});

describe('resolveCityDeterministic — returns null', () => {
  it('Montevideo → always null (caller handles MVD)', () => {
    const r = resolveCityDeterministic('Montevideo', {
      city: 'Montevideo',
      address1: 'Rambla 100',
      address2: '',
    });
    expect(r).toBeNull();
  });

  it('Unknown dept → null', () => {
    const r = resolveCityDeterministic('Atlantida', {
      city: 'Atlantida',
      address1: '',
      address2: '',
    });
    expect(r).toBeNull();
  });

  it('Colonia + nothing recognizable → null', () => {
    const r = resolveCityDeterministic('Colonia', {
      city: 'Pueblo Perdido',
      address1: 'Calle XYZ 999',
      address2: '',
    });
    expect(r).toBeNull();
  });
});
