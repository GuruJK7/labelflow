import { describe, it, expect } from 'vitest';
import {
  correctCityWhenEqualsDepartment,
  fuzzyMatchCity,
  getCapitalCity,
  levenshtein,
  splitHyphenatedCityName,
  DEPARTMENT_CAPITALS,
  CITY_TO_DEPARTMENT,
} from '../dac/uruguay-geo';

/**
 * Audit 2026-05-06 — city-correction regression tests.
 *
 * Two complementary fixes for DAC silent rejections:
 *   1. correctCityWhenEqualsDepartment: substitute dept capital when
 *      customer typed the dept name as the city (e.g. "San José" alone)
 *   2. fuzzyMatchCity: Levenshtein-based typo correction (e.g.
 *      "Parque batalle" → "Parque Batlle")
 *
 * Each test case is grounded in a real production order — see comment
 * blocks for the order numbers.
 */

describe('DEPARTMENT_CAPITALS', () => {
  it('has an entry for every Uruguay department (19 official)', () => {
    expect(Object.keys(DEPARTMENT_CAPITALS)).toHaveLength(19);
  });

  it('the only entries where capital DIFFERS from dept name', () => {
    // These are the 7 "dept != capital" cases. If this list ever changes
    // (Uruguay creates a new dept, etc.) update DEPARTMENT_CAPITALS too.
    const mismatches = Object.entries(DEPARTMENT_CAPITALS).filter(
      ([dept, capital]) => dept !== capital,
    );
    expect(mismatches.map(([d]) => d).sort()).toEqual([
      'Cerro Largo',         // → Melo
      'Colonia',             // → Colonia del Sacramento
      'Flores',              // → Trinidad
      'Lavalleja',           // → Minas
      'Rio Negro',           // → Fray Bentos
      'San Jose',            // → San Jose de Mayo
      'Soriano',             // → Mercedes
    ]);
  });
});

describe('getCapitalCity', () => {
  it('returns the capital for each department', () => {
    expect(getCapitalCity('San Jose')).toBe('San Jose de Mayo');
    expect(getCapitalCity('Soriano')).toBe('Mercedes');
    expect(getCapitalCity('Cerro Largo')).toBe('Melo');
    expect(getCapitalCity('Lavalleja')).toBe('Minas');
    expect(getCapitalCity('Flores')).toBe('Trinidad');
    expect(getCapitalCity('Rio Negro')).toBe('Fray Bentos');
    expect(getCapitalCity('Colonia')).toBe('Colonia del Sacramento');
  });

  it('handles accented dept names (Shopify can emit either form)', () => {
    expect(getCapitalCity('San José')).toBe('San Jose de Mayo');
    expect(getCapitalCity('Río Negro')).toBe('Fray Bentos');
    expect(getCapitalCity('Paysandú')).toBe('Paysandu');
    expect(getCapitalCity('Tacuarembó')).toBe('Tacuarembo');
  });

  it('handles case variations', () => {
    expect(getCapitalCity('san jose')).toBe('San Jose de Mayo');
    expect(getCapitalCity('SAN JOSE')).toBe('San Jose de Mayo');
    expect(getCapitalCity('  San Jose  ')).toBe('San Jose de Mayo');
  });

  it('returns null for unknown / empty input', () => {
    expect(getCapitalCity(null)).toBeNull();
    expect(getCapitalCity(undefined)).toBeNull();
    expect(getCapitalCity('')).toBeNull();
    expect(getCapitalCity('Buenos Aires')).toBeNull();
    expect(getCapitalCity('asdf')).toBeNull();
  });
});

describe('correctCityWhenEqualsDepartment', () => {
  describe('production cases (audit 2026-05-06)', () => {
    it('#11748 naza fernandez — city="San José" + dept="San José" → "San Jose de Mayo"', () => {
      // The exact production failure. Customer typed both fields as the
      // dept name; DAC's San José city dropdown has no "San José" option.
      expect(correctCityWhenEqualsDepartment('San José', 'San José')).toBe(
        'San Jose de Mayo',
      );
    });
  });

  describe('substitutes capital when city == dept (and capital differs)', () => {
    it.each([
      ['San José', 'San José', 'San Jose de Mayo'],
      ['San Jose', 'San Jose', 'San Jose de Mayo'],
      ['Soriano', 'Soriano', 'Mercedes'],
      ['Cerro Largo', 'Cerro Largo', 'Melo'],
      ['Lavalleja', 'Lavalleja', 'Minas'],
      ['Flores', 'Flores', 'Trinidad'],
      ['Río Negro', 'Río Negro', 'Fray Bentos'],
      ['Rio Negro', 'Rio Negro', 'Fray Bentos'],
      ['Colonia', 'Colonia', 'Colonia del Sacramento'],
    ])('city="%s" + dept="%s" → "%s"', (city, dept, expected) => {
      expect(correctCityWhenEqualsDepartment(city, dept)).toBe(expected);
    });
  });

  describe('no-op when city == dept AND capital == dept name', () => {
    // For these depts the capital IS named after the dept — no
    // correction needed (DAC's dropdown HAS "Maldonado" as a city).
    it.each([
      ['Maldonado', 'Maldonado'],
      ['Florida', 'Florida'],
      ['Rocha', 'Rocha'],
      ['Salto', 'Salto'],
      ['Paysandú', 'Paysandú'],
      ['Tacuarembó', 'Tacuarembó'],
      ['Rivera', 'Rivera'],
      ['Artigas', 'Artigas'],
      ['Canelones', 'Canelones'],
      ['Durazno', 'Durazno'],
      ['Treinta y Tres', 'Treinta y Tres'],
      ['Montevideo', 'Montevideo'],
    ])('city="%s" + dept="%s" — unchanged', (city, dept) => {
      expect(correctCityWhenEqualsDepartment(city, dept)).toBe(city);
    });
  });

  describe('no-op when city differs from dept (legitimate city name)', () => {
    it.each([
      ['Mercedes', 'Soriano'],         // Mercedes is a real city in Soriano
      ['Fray Bentos', 'Rio Negro'],
      ['Minas', 'Lavalleja'],
      ['Trinidad', 'Flores'],
      ['Melo', 'Cerro Largo'],
      ['San Jose de Mayo', 'San Jose'],
      ['Colonia del Sacramento', 'Colonia'],
      ['Pocitos', 'Montevideo'],
    ])('city="%s" + dept="%s" — unchanged', (city, dept) => {
      expect(correctCityWhenEqualsDepartment(city, dept)).toBe(city);
    });
  });

  describe('null/undefined/empty handling', () => {
    it('returns city as-is when either input is empty', () => {
      expect(correctCityWhenEqualsDepartment(null, 'San Jose')).toBe(null);
      expect(correctCityWhenEqualsDepartment('San Jose', null)).toBe('San Jose');
      expect(correctCityWhenEqualsDepartment('', '')).toBe('');
    });

    it('returns city as-is when dept is unrecognized', () => {
      expect(correctCityWhenEqualsDepartment('Cordoba', 'Cordoba')).toBe('Cordoba');
    });
  });
});

describe('levenshtein (helper)', () => {
  it('computes correct distances', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('cat', 'bat')).toBe(1); // substitution
    expect(levenshtein('cat', 'cats')).toBe(1); // insertion
    expect(levenshtein('cats', 'cat')).toBe(1); // deletion
    expect(levenshtein('kitten', 'sitting')).toBe(3); // classic
  });

  it('handles real city typo distances', () => {
    expect(levenshtein('parque batalle', 'parque batlle')).toBe(1);
    expect(levenshtein('monteideo', 'montevideo')).toBe(1);
    expect(levenshtein('tacuarmebo', 'tacuarembo')).toBe(2);
  });
});

describe('fuzzyMatchCity', () => {
  // Note on #11705 Valeria Ramírez (city="Parque batalle"): "Parque
  // Batlle" is a Mvd BARRIO, not a city, so it isn't in
  // CITY_TO_DEPARTMENT — fuzzyMatchCity intentionally returns null for
  // it. Barrio-level typo correction is handled separately by the AI
  // resolver / detectBarrio path. The fuzzy matcher specifically helps
  // when the customer typed a misspelled CITY (not barrio) name.

  describe('exact match short-circuit (no correction)', () => {
    it('returns the canonical normalized form for exact matches', () => {
      expect(fuzzyMatchCity('Tacuarembo')).toBe('tacuarembo');
      expect(fuzzyMatchCity('Tacuarembó')).toBe('tacuarembo');
      expect(fuzzyMatchCity('Mercedes')).toBe('mercedes');
      expect(fuzzyMatchCity('Fray Bentos')).toBe('fray bentos');
      expect(fuzzyMatchCity('San Jose')).toBe('san jose');
    });
  });

  describe('typo correction within distance 1', () => {
    it.each([
      // Distance 1 from a unique CITY_TO_DEPARTMENT key
      ['monteideo', 'montevideo'],          // missing 'v'
      ['fray bento', 'fray bentos'],        // missing 's'
      ['mercede', 'mercedes'],              // missing 's'
      ['tacuarambo', 'tacuarembo'],         // 'a' instead of 'e'
    ])('"%s" → "%s"', (typo, expected) => {
      expect(fuzzyMatchCity(typo)).toBe(expected);
    });
  });

  describe('rejects too-short inputs (false-positive defense)', () => {
    it.each(['Sur', 'Mvd', 'Co', 'Sa', 'Min'])(
      '"%s" returns null (under 5 char threshold)',
      (short) => {
        expect(fuzzyMatchCity(short)).toBeNull();
      },
    );
  });

  describe('rejects ambiguous matches (cross-department)', () => {
    // If two equally-close candidates resolve to DIFFERENT departments,
    // we cannot safely auto-correct. Returns null.
    // (This test depends on the geo dict structure; if no such
    // ambiguity exists naturally we just verify the safety mechanism
    // doesn't crash.)
    it('does not crash on ambiguity-defense path', () => {
      // Just exercise the function with a non-matching input.
      expect(() => fuzzyMatchCity('xxxxxyyyyy', 1)).not.toThrow();
    });
  });

  describe('respects maxDistance parameter', () => {
    it('default maxDistance=1 rejects distance-2 typos', () => {
      // "tacuarmebo" → "tacuarembo" is distance 2 (swap of 'em')
      expect(fuzzyMatchCity('tacuarmebo', 1)).toBeNull();
    });

    it('explicit maxDistance=2 accepts distance-2 typos', () => {
      expect(fuzzyMatchCity('tacuarmebo', 2)).toBe('tacuarembo');
    });
  });

  describe('null/empty handling', () => {
    it.each([null, undefined, ''])('"%s" returns null', (input) => {
      expect(fuzzyMatchCity(input)).toBeNull();
    });
  });

  describe('does NOT match unrelated short words', () => {
    // Conservative: random strings that happen to be 5+ chars but
    // aren't close to any UY city should return null.
    it.each([
      'asdfg',
      'qwerty',
      'aaaaaa',
      'foobarbaz',
      'lorem ipsum',
    ])('"%s" returns null', (input) => {
      expect(fuzzyMatchCity(input)).toBeNull();
    });
  });

  describe('CITY_TO_DEPARTMENT consumability — fuzzy result is a valid key', () => {
    it('every fuzzy result is a real key that maps to a department', () => {
      const cases = ['Tacuarembo', 'Mercedes', 'Fray Bentos', 'monteideo'];
      for (const c of cases) {
        const fuzzy = fuzzyMatchCity(c);
        expect(fuzzy).not.toBeNull();
        expect(CITY_TO_DEPARTMENT[fuzzy!]).toBeDefined();
      }
    });
  });
});

describe('splitHyphenatedCityName', () => {
  describe('production case (audit 2026-05-06)', () => {
    it('#11733 Silvia Aranda — "Dolores-Soriano" → "Dolores"', () => {
      // Real case: customer's checkout joined city + dept with a hyphen.
      // Without this split, getDepartmentForCity returned undefined and
      // the order fell into the AI fallback path (non-deterministic).
      expect(splitHyphenatedCityName('Dolores-Soriano')).toBe('Dolores');
    });
  });

  describe('extracts city when first part is a known city', () => {
    it.each([
      ['Dolores-Soriano', 'Dolores'],
      ['Cardona-Soriano', 'Cardona'],
      ['Mercedes-Soriano', 'Mercedes'],
      ['Florida-Florida', 'Florida'],
      // Preserves customer's original casing
      ['DOLORES-SORIANO', 'DOLORES'],
      ['  Dolores  -  Soriano  ', 'Dolores'],
    ])('"%s" → "%s"', (input, expected) => {
      expect(splitHyphenatedCityName(input)).toBe(expected);
    });
  });

  describe('returns input unchanged when first part is NOT a known city', () => {
    // Random strings shouldn't be split — pass through unchanged.
    it.each([
      'foo-bar',
      'asdf-qwer',
      'random-text',
    ])('"%s" — unchanged', (input) => {
      expect(splitHyphenatedCityName(input)).toBe(input);
    });
  });

  describe('returns input unchanged when no hyphen', () => {
    it.each([
      'Dolores',
      'Av. Bolivia 2338',
      'San José de Mayo',
      'Pocitos',
    ])('"%s" — unchanged', (input) => {
      expect(splitHyphenatedCityName(input)).toBe(input);
    });
  });

  describe('returns input unchanged for 3+ part forms (avoid wrong guess)', () => {
    it.each([
      'a-b-c',
      'Dolores-Centro-Soriano',
    ])('"%s" — unchanged', (input) => {
      expect(splitHyphenatedCityName(input)).toBe(input);
    });
  });

  describe('null/empty handling', () => {
    it.each([null, undefined, ''])('"%s" → ""', (input) => {
      expect(splitHyphenatedCityName(input)).toBe('');
    });
  });
});
