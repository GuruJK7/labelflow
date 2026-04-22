/**
 * Comprehensive test suite for LabelFlow shipment processing logic.
 * 100+ tests covering every function in the DAC/Shopify pipeline
 * using real Uruguay addresses and Shopify order patterns.
 */
import { describe, it, expect } from 'vitest';
import { mergeAddress, detectCityIntelligent, shouldInvokeAIResolver } from '../dac/shipment';
import {
  getDepartmentForCity,
  getBarriosFromZip,
  getDepartmentFromZip,
  getBarriosFromStreet,
  CITY_TO_DEPARTMENT,
} from '../dac/uruguay-geo';
import { determinePaymentType } from '../rules/payment';

// Helper to create minimal ShopifyOrder for payment tests
function mockOrder(totalPrice: string, currency = 'UYU'): any {
  return { id: 9999, name: '#TEST', total_price: totalPrice, currency };
}

// ============================================================
// SECTION 1: getDepartmentForCity — 40 tests
// Every department capital + edge cases
// ============================================================
describe('getDepartmentForCity', () => {
  // --- All 19 department capitals must resolve ---
  it.each([
    ['Artigas', 'Artigas'],
    ['Canelones', 'Canelones'],
    ['Melo', 'Cerro Largo'],
    ['Colonia del Sacramento', 'Colonia'],
    ['Durazno', 'Durazno'],
    ['Trinidad', 'Flores'],
    ['Florida', 'Florida'],
    ['Minas', 'Lavalleja'],
    ['Maldonado', 'Maldonado'],
    ['Montevideo', 'Montevideo'],
    ['Paysandu', 'Paysandu'],
    ['Fray Bentos', 'Rio Negro'],
    ['Rivera', 'Rivera'],
    ['Rocha', 'Rocha'],
    ['Salto', 'Salto'],
    ['San Jose de Mayo', 'San Jose'],
    ['Mercedes', 'Soriano'],
    ['Tacuarembo', 'Tacuarembo'],
    ['Treinta y Tres', 'Treinta y Tres'],
  ])('capital "%s" → %s', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // --- Common Montevideo barrios used as city ---
  it.each([
    ['Pocitos', 'Montevideo'],
    ['Carrasco', 'Montevideo'],
    ['Punta Carretas', 'Montevideo'],
    ['Buceo', 'Montevideo'],
    ['Centro', 'Montevideo'],
    ['Malvin', 'Montevideo'],
    ['Union', 'Montevideo'],
    ['Cordon', 'Montevideo'],
    ['Goes', 'Montevideo'],
    ['Prado', 'Montevideo'],
    ['La Blanqueada', 'Montevideo'],
    ['Tres Cruces', 'Montevideo'],
    ['Aguada', 'Montevideo'],
    ['Bella Vista', 'Montevideo'],
    ['Aires Puros', 'Montevideo'],
    ['Cerrito', 'Montevideo'],
    ['Mercado Modelo', 'Montevideo'],
    ['Pocitos Nuevo', 'Montevideo'],
    ['Punta Gorda', 'Montevideo'],
    ['Carrasco Norte', 'Montevideo'],
    ['Flor de Maronas', 'Montevideo'],
    ['La Figurita', 'Montevideo'],
    ['Barrio Sur', 'Montevideo'],
    ['Villa Munoz', 'Montevideo'],
    ['Paso de las Duranas', 'Montevideo'],
  ])('barrio "%s" → Montevideo', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // --- Ciudad de la Costa and Canelones suburbs ---
  it.each([
    ['Ciudad de la Costa', 'Canelones'],
    ['Solymar', 'Canelones'],
    ['Lagomar', 'Canelones'],
    ['El Pinar', 'Canelones'],
    ['Shangri-la', 'Canelones'],
    ['Atlantida', 'Canelones'],
    ['Las Piedras', 'Canelones'],
    ['Pando', 'Canelones'],
    ['Barros Blancos', 'Canelones'],
    ['Paso Carrasco', 'Canelones'],
    ['La Paz', 'Canelones'],
  ])('Canelones suburb "%s" → Canelones', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // --- Smart parsing edge cases ---
  it('handles dot in city: "La.paz" → Canelones', () => {
    expect(getDepartmentForCity('La.paz')).toBe('Canelones');
  });

  it('handles country suffix: "montevideo- URUGUAY" → Montevideo', () => {
    expect(getDepartmentForCity('montevideo- URUGUAY')).toBe('Montevideo');
  });

  it('handles pipe separator: "2|montevideo" → Montevideo', () => {
    expect(getDepartmentForCity('2|montevideo')).toBe('Montevideo');
  });

  it('handles slash separator: "centro/Rivera" → Centro(Montevideo) or Rivera', () => {
    const result = getDepartmentForCity('centro/Rivera');
    // Should find "centro" first (Montevideo) or "rivera" (Rivera) — either is a valid city
    expect(result).toBeDefined();
    expect(['Montevideo', 'Rivera']).toContain(result);
  });

  it('handles comma separator: "Barrio Espanol, Atlantida Norte" → Canelones', () => {
    expect(getDepartmentForCity('Barrio Espanol, Atlantida Norte')).toBe('Canelones');
  });

  it('handles compound city: "Ciudad de la Costa solymar" → Canelones', () => {
    expect(getDepartmentForCity('Ciudad de la Costa solymar')).toBe('Canelones');
  });

  it('handles accented input: "Paysandu" (no accent) → Paysandu', () => {
    expect(getDepartmentForCity('Paysandu')).toBe('Paysandu');
  });

  it('handles accented input: "Paysandu" (with accent) → Paysandu', () => {
    expect(getDepartmentForCity('Paysand\u00fa')).toBe('Paysandu');
  });

  it('handles extra spaces: "  Pocitos  " → Montevideo', () => {
    expect(getDepartmentForCity('  Pocitos  ')).toBe('Montevideo');
  });

  it('handles ALL CAPS: "MONTEVIDEO" → Montevideo', () => {
    expect(getDepartmentForCity('MONTEVIDEO')).toBe('Montevideo');
  });

  it('returns undefined for garbage input', () => {
    expect(getDepartmentForCity('asdfghjkl')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getDepartmentForCity('')).toBeUndefined();
  });

  // --- Cities that were missing and got added ---
  it.each([
    ['Shangrila', 'Canelones'],
    ['Canada Chica', 'Canelones'],
    ['Atlantida Norte', 'Canelones'],
    ['Gautron', 'Salto'],
    ['Las Violetas', 'Durazno'],
    ['Picada de las Tunas', 'San Jose'],
    ['Jardines del Hum', 'Soriano'],
    ['Barrio Elisa', 'Maldonado'],
  ])('newly added city "%s" → %s', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });
});

// ============================================================
// SECTION 2: getBarriosFromZip — 15 tests
// ============================================================
describe('getBarriosFromZip', () => {
  it.each([
    ['11000', ['ciudad vieja', 'centro']],
    ['11100', ['centro', 'cordon', 'barrio sur']],
    ['11500', ['pocitos', 'punta carretas', 'parque batlle']],
    ['11600', ['buceo', 'malvin', 'malvin norte']],
    ['11800', ['carrasco', 'carrasco norte', 'punta gorda']],
    ['11900', ['cerro', 'la teja', 'paso de la arena', 'casabo']],
    ['12100', ['prado', 'capurro', 'belvedere', 'nuevo paris']],
    ['12500', ['capurro', 'belvedere', 'aguada']],
  ])('ZIP %s → %j', (zip, expected) => {
    expect(getBarriosFromZip(zip)).toEqual(expected);
  });

  it('rounds 11345 to 11300', () => {
    expect(getBarriosFromZip('11345')).toEqual(['tres cruces', 'la comercial', 'la figurita', 'jacinto vera']);
  });

  it('returns null for non-Montevideo ZIP', () => {
    expect(getBarriosFromZip('20000')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(getBarriosFromZip(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(getBarriosFromZip(undefined)).toBeNull();
  });

  it('returns null for too-short ZIP', () => {
    expect(getBarriosFromZip('11')).toBeNull();
  });

  it('strips non-digits from ZIP', () => {
    expect(getBarriosFromZip('11-500')).toEqual(['pocitos', 'punta carretas', 'parque batlle']);
  });
});

// ============================================================
// SECTION 3: getDepartmentFromZip — 10 tests
// ============================================================
describe('getDepartmentFromZip', () => {
  it.each([
    ['11000', 'Montevideo'],
    ['12500', 'Montevideo'],
    ['15000', 'Canelones'],
    ['20000', 'Maldonado'],
    ['25000', 'Rocha'],
    ['37000', 'Salto'],
    ['40000', 'Paysandu'],
    ['50000', 'Colonia'],
    ['60000', 'San Jose'],
    ['85000', 'Tacuarembo'],
  ])('ZIP %s → %s', (zip, expected) => {
    expect(getDepartmentFromZip(zip)).toBe(expected);
  });

  it('returns null for null', () => {
    expect(getDepartmentFromZip(null)).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(getDepartmentFromZip('99000')).toBeNull();
  });
});

// ============================================================
// SECTION 4: getBarriosFromStreet — 12 tests
// ============================================================
describe('getBarriosFromStreet', () => {
  it('detects 18 de julio', () => {
    const result = getBarriosFromStreet('18 de Julio 1234');
    expect(result).toContain('centro');
    expect(result).toContain('cordon');
  });

  it('detects Av Italia', () => {
    const result = getBarriosFromStreet('Av Italia 3500');
    expect(result).toContain('buceo');
  });

  it('detects Avenida Italia (full)', () => {
    const result = getBarriosFromStreet('Avenida Italia 2800');
    expect(result).toContain('buceo');
  });

  it('detects Boulevard Artigas', () => {
    const result = getBarriosFromStreet('Boulevard Artigas 1100');
    expect(result).toContain('tres cruces');
  });

  it('detects Colorado street → Goes', () => {
    const result = getBarriosFromStreet('Colorado 1850');
    expect(result).toContain('goes');
  });

  it('detects Millan → Blanqueada/Reducto', () => {
    const result = getBarriosFromStreet('Millan 3200');
    expect(result).toContain('la blanqueada');
  });

  it('detects Camino Carrasco', () => {
    const result = getBarriosFromStreet('Camino Carrasco 5400');
    expect(result).toContain('carrasco');
  });

  it('detects Ellauri → Pocitos', () => {
    const result = getBarriosFromStreet('Ellauri 980');
    expect(result).toContain('pocitos');
  });

  it('detects 21 de setiembre → Pocitos', () => {
    const result = getBarriosFromStreet('21 de Setiembre 2900');
    expect(result).toContain('pocitos');
  });

  it('returns null for unknown street', () => {
    expect(getBarriosFromStreet('Calle Inventada 1234')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(getBarriosFromStreet(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getBarriosFromStreet('')).toBeNull();
  });
});

// ============================================================
// SECTION 5: mergeAddress — 30 tests
// Real Shopify address patterns from Uruguay stores
// ============================================================
describe('mergeAddress', () => {
  // --- Basic cases ---
  it('address1 only, no address2', () => {
    expect(mergeAddress('18 de Julio 1234', null)).toEqual({ fullAddress: '18 de Julio 1234', extraObs: '' });
  });

  it('address1 only, empty address2', () => {
    expect(mergeAddress('Rivera 2500', '')).toEqual({ fullAddress: 'Rivera 2500', extraObs: '' });
  });

  it('address1 only, undefined address2', () => {
    expect(mergeAddress('Bvar Artigas 1100', undefined)).toEqual({ fullAddress: 'Bvar Artigas 1100', extraObs: '' });
  });

  // --- Door number in address2 ---
  it('address2 is door number: "705"', () => {
    expect(mergeAddress('18 De Julio', '705')).toEqual({ fullAddress: '18 De Julio 705', extraObs: '' });
  });

  it('address2 is door number but address1 already has one', () => {
    const result = mergeAddress('18 de Julio 1234', '502');
    expect(result.fullAddress).toBe('18 de Julio 1234');
    expect(result.extraObs).toBe('Apto 502');
  });

  // --- Apartment info ---
  it('address2 is "Apto 301"', () => {
    const result = mergeAddress('Bvar Artigas 1100', 'Apto 301');
    expect(result.fullAddress).toBe('Bvar Artigas 1100');
    expect(result.extraObs).toBe('Apto 301');
  });

  it('address2 is "Piso 3"', () => {
    const result = mergeAddress('18 de Julio 999', 'Piso 3');
    expect(result.fullAddress).toBe('18 de Julio 999');
    expect(result.extraObs).toBe('Piso 3');
  });

  it('address2 is "Torre 2 Apto 1401"', () => {
    const result = mergeAddress('Rambla Republica de Mexico 5805', 'Torre 2 Apto 1401');
    expect(result.fullAddress).toBe('Rambla Republica de Mexico 5805');
    expect(result.extraObs).toBe('Torre 2 Apto 1401');
  });

  it('address2 is "Casa 5"', () => {
    const result = mergeAddress('Camino Carrasco 1500', 'Casa 5');
    expect(result.fullAddress).toBe('Camino Carrasco 1500');
    expect(result.extraObs).toBe('Casa 5');
  });

  // --- Phone number in address2 (should be ignored) ---
  it('address2 is phone: "099680230"', () => {
    expect(mergeAddress('Colorado 1850', '099680230')).toEqual({ fullAddress: 'Colorado 1850', extraObs: '' });
  });

  it('address2 is phone with dash: "099-680-230"', () => {
    expect(mergeAddress('Rivera 3500', '099-680-230')).toEqual({ fullAddress: 'Rivera 3500', extraObs: '' });
  });

  it('address2 is phone with country code: "+59899680230"', () => {
    expect(mergeAddress('Ellauri 900', '+59899680230')).toEqual({ fullAddress: 'Ellauri 900', extraObs: '' });
  });

  // --- City/department in address2 (should be ignored) ---
  it('address2 is "Montevideo"', () => {
    expect(mergeAddress('Rivera 2500', 'Montevideo')).toEqual({ fullAddress: 'Rivera 2500', extraObs: '' });
  });

  it('address2 is "Pocitos"', () => {
    expect(mergeAddress('21 de Setiembre 2800', 'Pocitos')).toEqual({ fullAddress: '21 de Setiembre 2800', extraObs: '' });
  });

  it('address2 is "Canelones"', () => {
    expect(mergeAddress('Av. Giannattasio km 22', 'Canelones')).toEqual({ fullAddress: 'Av. Giannattasio km 22', extraObs: '' });
  });

  // --- Duplicate detection ---
  // v3 (2026-04-10): when address2 is an AMBIGUOUS 3+ digit number (no leading zero)
  // that duplicates the trailing number of address1, treat it as a duplicated DOOR
  // number rather than an apartment. The customer typically did this by mistake —
  // they entered the same door number twice. Apt numbers are usually short (1-2
  // digits) or have a leading zero (002, 012). See isLikelyAptNumber().
  it('address2 already at end of address1: "18 De Julio 705" + "705" — treated as duplicate door, NOT apt', () => {
    const result = mergeAddress('18 De Julio 705', '705');
    expect(result.fullAddress).toBe('18 De Julio 705');
    expect(result.extraObs).toBe('');
  });

  // The corollary: if address2 looks "obviously apt" (leading zero), it IS the apt
  it('address2 with leading zero IS treated as apt: "Rambla X 4507" + "002"', () => {
    const result = mergeAddress('Rambla X 4507', '002');
    expect(result.extraObs).toBe('Apto 002');
  });

  // --- Direction references ---
  it('address2 is "esq. Av Italia"', () => {
    const result = mergeAddress('Rivera 2500', 'esq. Av Italia');
    expect(result.fullAddress).toBe('Rivera 2500 esq. Av Italia');
    expect(result.extraObs).toBe('');
  });

  it('address2 is "entre Colonia y Soriano"', () => {
    const result = mergeAddress('18 de Julio 1200', 'entre Colonia y Soriano');
    expect(result.fullAddress).toContain('entre Colonia y Soriano');
    expect(result.extraObs).toBe('');
  });

  // --- Combined door + apt: "1502B" ---
  it('address2 is "1502B" (door+apt combined)', () => {
    const result = mergeAddress('Av Italia', '1502B');
    // address1 has no number, so door part goes to fullAddress, apt letter to obs
    expect(result.fullAddress).toBe('Av Italia 1502');
    expect(result.extraObs).toBe('Apto B');
  });

  // --- Slash pattern: "3274/801" ---
  it('address2 is "3274/801" (slash apt pattern)', () => {
    const result = mergeAddress('Bvar Artigas', '3274/801');
    // Unrecognized pattern goes to extraObs only
    expect(result.fullAddress).toBe('Bvar Artigas');
    expect(result.extraObs).toBe('3274/801');
  });

  // --- Bis pattern ---
  it('address2 is "1234 bis"', () => {
    const result = mergeAddress('Av Rivera', '1234 bis');
    expect(result.fullAddress).toBe('Av Rivera 1234 bis');
    expect(result.extraObs).toBe('');
  });

  // --- Long descriptive address2 ---
  it('address2 is long text → goes to obs only', () => {
    const result = mergeAddress('Rambla 5000', 'Edificio Torre Azul entrada por costado norte');
    expect(result.fullAddress).toBe('Rambla 5000');
    expect(result.extraObs).toBe('Edificio Torre Azul entrada por costado norte');
  });

  // --- Empty/null address1 ---
  it('address1 is empty, address2 has data', () => {
    const result = mergeAddress('', 'Apto 301');
    expect(result.fullAddress).toBe('');
    expect(result.extraObs).toBe('Apto 301');
  });

  // --- Real problem cases from production ---
  it('real case: "Av Italia 3456" + "Apto 12"', () => {
    const result = mergeAddress('Av Italia 3456', 'Apto 12');
    expect(result.fullAddress).toBe('Av Italia 3456');
    expect(result.extraObs).toBe('Apto 12');
  });

  it('real case: "Colorado" + "1850"', () => {
    const result = mergeAddress('Colorado', '1850');
    expect(result.fullAddress).toBe('Colorado 1850');
    expect(result.extraObs).toBe('');
  });

  it('real case: "Bvar Artigas 1100" + "Local 3"', () => {
    const result = mergeAddress('Bvar Artigas 1100', 'Local 3');
    expect(result.fullAddress).toBe('Bvar Artigas 1100');
    expect(result.extraObs).toBe('Local 3');
  });

  it('real case: "Camino Maldonado 5890" + "Ciudad de la Costa"', () => {
    const result = mergeAddress('Camino Maldonado 5890', 'Ciudad de la Costa');
    expect(result.fullAddress).toBe('Camino Maldonado 5890');
    expect(result.extraObs).toBe('');
  });

  it('real case: address1 has slash apt "Rivera 3274/801" — split into door + apt', () => {
    // v3 (2026-04-10): mergeAddress now detects slash apt patterns directly,
    // not just in the post-merge step. This was needed for #11085 (Luis a de
    // Herrera 1183/204 + delivery hours in address2). The slash form is split
    // into a clean door address + Apto in obs so the courier doesn't get
    // confused by "Calle 1234/5".
    const result = mergeAddress('Rivera 3274/801', null);
    expect(result.fullAddress).toBe('Rivera 3274');
    expect(result.extraObs).toBe('Apto 801');
  });

  // --- H-6 (2026-04-21 audit): slash apt edge cases ---
  it('H-6: slash apt with letter-only — "Herrera 1183/B" → door + Apto B', () => {
    const result = mergeAddress('Luis A de Herrera 1183/B', null);
    expect(result.fullAddress).toBe('Luis A de Herrera 1183');
    expect(result.extraObs).toBe('Apto B');
  });

  it('H-6: slash apt with number+letter — "Herrera 1183/6B" → door + Apto 6B', () => {
    const result = mergeAddress('Luis A de Herrera 1183/6B', null);
    expect(result.fullAddress).toBe('Luis A de Herrera 1183');
    expect(result.extraObs).toBe('Apto 6B');
  });

  it('H-6: km sub-marker must NOT be split — "Ruta 9 km 120/5" stays intact', () => {
    // Highway kilometer sub-markers look like slash apts but are NOT apts.
    // The regex used to swallow them incorrectly and produce door=120,apt=5.
    const result = mergeAddress('Ruta 9 km 120/5', null);
    expect(result.fullAddress).toBe('Ruta 9 km 120/5');
    expect(result.extraObs).toBe('');
  });

  it('H-6: "KM" uppercase also guarded', () => {
    const result = mergeAddress('Ruta Interbalnearia KM 60/2', null);
    expect(result.fullAddress).toBe('Ruta Interbalnearia KM 60/2');
    expect(result.extraObs).toBe('');
  });
});

// ============================================================
// SECTION 6: determinePaymentType — 20 tests
// ============================================================
describe('determinePaymentType', () => {
  const THRESHOLD = 3900;

  // --- Basic flow ---
  it('above threshold → REMITENTE', () => {
    expect(determinePaymentType(mockOrder('5000'), THRESHOLD, true)).toBe('REMITENTE');
  });

  it('below threshold → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('2000'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('exactly at threshold → DESTINATARIO (<=)', () => {
    expect(determinePaymentType(mockOrder('3900'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('just above threshold → REMITENTE', () => {
    expect(determinePaymentType(mockOrder('3901'), THRESHOLD, true)).toBe('REMITENTE');
  });

  // --- Rule disabled ---
  it('paymentRuleEnabled=false → always DESTINATARIO regardless of amount', () => {
    expect(determinePaymentType(mockOrder('999999'), THRESHOLD, false)).toBe('DESTINATARIO');
  });

  it('paymentRuleEnabled defaults to false', () => {
    expect(determinePaymentType(mockOrder('999999'), THRESHOLD)).toBe('DESTINATARIO');
  });

  // --- Invalid inputs ---
  it('NaN total → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('abc'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('empty string total → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder(''), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('negative total → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('-500'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('zero total → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('0'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  // --- Currency conversion ---
  it('USD 100 at rate 43 = 4300 UYU → REMITENTE', () => {
    expect(determinePaymentType(mockOrder('100', 'USD'), THRESHOLD, true)).toBe('REMITENTE');
  });

  it('USD 50 at rate 43 = 2150 UYU → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('50', 'USD'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('EUR 100 at rate 47 = 4700 UYU → REMITENTE', () => {
    expect(determinePaymentType(mockOrder('100', 'EUR'), THRESHOLD, true)).toBe('REMITENTE');
  });

  it('EUR 50 at rate 47 = 2350 UYU → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('50', 'EUR'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  it('BRL 500 at rate 8 = 4000 UYU → REMITENTE', () => {
    expect(determinePaymentType(mockOrder('500', 'BRL'), THRESHOLD, true)).toBe('REMITENTE');
  });

  it('unknown currency GBP → DESTINATARIO (safe default)', () => {
    expect(determinePaymentType(mockOrder('5000', 'GBP'), THRESHOLD, true)).toBe('DESTINATARIO');
  });

  // --- Threshold edge cases ---
  it('threshold=0 → DESTINATARIO (guard against misconfiguration)', () => {
    expect(determinePaymentType(mockOrder('100'), 0, true)).toBe('DESTINATARIO');
  });

  it('threshold=-1 → DESTINATARIO (invalid threshold)', () => {
    expect(determinePaymentType(mockOrder('100'), -1, true)).toBe('DESTINATARIO');
  });

  it('threshold=NaN → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('100'), NaN, true)).toBe('DESTINATARIO');
  });

  it('very high threshold 1000000, order 500000 → DESTINATARIO', () => {
    expect(determinePaymentType(mockOrder('500000'), 1000000, true)).toBe('DESTINATARIO');
  });
});

// ============================================================
// SECTION 7: Geo DB completeness — verify no gaps in coverage
// ============================================================
describe('Geo DB completeness', () => {
  it('has all 19 department capitals', () => {
    const capitals = [
      'artigas', 'canelones', 'melo', 'colonia del sacramento', 'durazno',
      'trinidad', 'florida', 'minas', 'maldonado', 'montevideo',
      'paysandu', 'fray bentos', 'rivera', 'rocha', 'salto',
      'san jose de mayo', 'mercedes', 'tacuarembo', 'treinta y tres',
    ];
    for (const cap of capitals) {
      expect(CITY_TO_DEPARTMENT[cap]).toBeDefined();
    }
  });

  it('Punta del Este → Maldonado', () => {
    expect(CITY_TO_DEPARTMENT['punta del este']).toBe('Maldonado');
  });

  it('Ciudad del Plata → San Jose', () => {
    expect(CITY_TO_DEPARTMENT['ciudad del plata']).toBe('San Jose');
  });

  it('Paso de los Toros → Tacuarembo', () => {
    expect(CITY_TO_DEPARTMENT['paso de los toros']).toBe('Tacuarembo');
  });

  it('Chuy → Rocha', () => {
    expect(CITY_TO_DEPARTMENT['chuy']).toBe('Rocha');
  });

  it('Young → Rio Negro', () => {
    expect(CITY_TO_DEPARTMENT['young']).toBe('Rio Negro');
  });

  it('Bella Union → Artigas', () => {
    expect(CITY_TO_DEPARTMENT['bella union']).toBe('Artigas');
  });

  it('Carmelo → Colonia', () => {
    expect(CITY_TO_DEPARTMENT['carmelo']).toBe('Colonia');
  });

  it('Piriapolis → Maldonado', () => {
    expect(CITY_TO_DEPARTMENT['piriapolis']).toBe('Maldonado');
  });
});

// ============================================================
// SECTION 8: Integration-style tests — full address resolution
// Simulates what happens with a real Shopify order address
// ============================================================
describe('Full address resolution (integration)', () => {
  function resolveAddress(city: string, address1: string, address2: string | null, zip: string) {
    const dept = getDepartmentForCity(city);
    const zipBarrios = getBarriosFromZip(zip);
    const streetBarrios = getBarriosFromStreet(address1);
    const zipDept = getDepartmentFromZip(zip);
    const { fullAddress, extraObs } = mergeAddress(address1, address2);
    return { dept, zipBarrios, streetBarrios, zipDept, fullAddress, extraObs };
  }

  it('Pocitos order: Colorado 1850, ZIP 11300', () => {
    const r = resolveAddress('Pocitos', 'Colorado 1850', null, '11300');
    expect(r.dept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('la figurita');
    expect(r.streetBarrios).toContain('goes');
    expect(r.fullAddress).toBe('Colorado 1850');
  });

  it('Carrasco order: Camino Carrasco 5400 Apto 12, ZIP 11800', () => {
    const r = resolveAddress('Carrasco', 'Camino Carrasco 5400', 'Apto 12', '11800');
    expect(r.dept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('carrasco');
    expect(r.streetBarrios).toContain('carrasco');
    expect(r.fullAddress).toBe('Camino Carrasco 5400');
    expect(r.extraObs).toBe('Apto 12');
  });

  it('Interior order: Salto city, ZIP 37000', () => {
    const r = resolveAddress('Salto', 'Uruguay 340', null, '37000');
    expect(r.dept).toBe('Salto');
    expect(r.zipDept).toBe('Salto');
    expect(r.zipBarrios).toBeNull(); // Not Montevideo
    expect(r.fullAddress).toBe('Uruguay 340');
  });

  it('Wrong dept from Shopify: city=Solymar but province=Montevideo', () => {
    const r = resolveAddress('Solymar', 'Av Giannattasio km 20', null, '15000');
    expect(r.dept).toBe('Canelones'); // Corrected!
    expect(r.zipDept).toBe('Canelones');
  });

  it('Barrio as city: city=Buceo, ZIP 11600', () => {
    const r = resolveAddress('Buceo', 'Av Italia 2800', null, '11600');
    expect(r.dept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('buceo');
    expect(r.streetBarrios).toContain('buceo');
  });

  it('La Paz with dot: city=La.paz, ZIP 15000', () => {
    const r = resolveAddress('La.paz', 'Ruta 1 km 30', null, '15000');
    expect(r.dept).toBe('Canelones');
  });

  it('Punta del Este: ZIP 20000', () => {
    const r = resolveAddress('Punta del Este', 'Gorlero 900', null, '20000');
    expect(r.dept).toBe('Maldonado');
    expect(r.zipDept).toBe('Maldonado');
  });

  it('Ciudad de la Costa: ZIP 15000', () => {
    const r = resolveAddress('Ciudad de la Costa', 'Av Giannattasio km 24', 'Casa 15', '15000');
    expect(r.dept).toBe('Canelones');
    expect(r.fullAddress).toBe('Av Giannattasio km 24');
    expect(r.extraObs).toBe('Casa 15');
  });

  it('Rivera city: ZIP 33000', () => {
    const r = resolveAddress('Rivera', 'Sarandi 500', null, '33000');
    expect(r.dept).toBe('Rivera');
    expect(r.zipDept).toBe('Rivera');
  });

  it('Order with no city, ZIP 11500 → should get Montevideo from ZIP', () => {
    const r = resolveAddress('', '21 de Setiembre 2900', null, '11500');
    expect(r.dept).toBeUndefined(); // getDepartmentForCity('') returns undefined
    expect(r.zipDept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('pocitos');
    expect(r.streetBarrios).toContain('pocitos');
  });
});

// ============================================================
// SECTION 9: detectCityIntelligent — ZIP must not override Shopify barrio
// ============================================================
describe('detectCityIntelligent — Shopify barrio priority over ZIP', () => {
  it('Shopify city=Pocitos, ZIP 11300 (maps to tres cruces/figurita) → returns pocitos, not tres cruces', () => {
    const result = detectCityIntelligent('Pocitos', 'Colorado 1850', '', '11300');
    expect(result.barrio).toBe('pocitos');
    expect(result.department).toBe('Montevideo');
  });

  it('Shopify city=Punta Carretas, ZIP 11300 → returns punta carretas, not tres cruces', () => {
    const result = detectCityIntelligent('Punta Carretas', 'Ellauri 500', '', '11300');
    expect(result.barrio).toBe('punta carretas');
    expect(result.department).toBe('Montevideo');
  });

  it('Shopify city=Carrasco, ZIP 11800 (agrees) → returns carrasco (ZIP confirms)', () => {
    const result = detectCityIntelligent('Carrasco', 'Camino Carrasco 5400', '', '11800');
    expect(result.barrio).toBe('carrasco');
    expect(result.source).toBe('zip'); // ZIP confirms the alias — high confidence
  });

  // Product decision 2026-04-20: when customer did not name a barrio, do NOT guess.
  // Uruguayan ZIPs map to 3-4 barrios (e.g. 11300 → tres cruces/la comercial/la figurita/jacinto vera),
  // so picking zipBarrios[0] was wrong more often than right. Submit DAC with department only.
  it('No alias barrio from Shopify, ZIP 11300 → barrio null, department only', () => {
    const result = detectCityIntelligent('Montevideo', 'Calle X 100', '', '11300');
    expect(result.barrio).toBeNull();
    expect(result.department).toBe('Montevideo');
    expect(result.source).toBe('zip');
  });

  it('Empty city, ZIP 11500 → barrio null, department only', () => {
    const result = detectCityIntelligent('', '21 de Setiembre 2900', '', '11500');
    expect(result.barrio).toBeNull();
    expect(result.department).toBe('Montevideo');
    expect(result.source).toBe('zip');
  });
});

// ============================================================
// SECTION 10: Real-order regressions — Shopify barrio must NOT be overridden by ZIP
// Each case: customer named a valid barrio; a wrong/imprecise ZIP would map elsewhere.
// ============================================================
describe('detectCityIntelligent — real-order ZIP-override regressions', () => {
  it('Pocitos + ZIP 11300 (tres cruces zone) → stays pocitos', () => {
    const result = detectCityIntelligent('Pocitos', 'Ellauri 1200', '', '11300');
    expect(result.barrio).toBe('pocitos');
    expect(result.department).toBe('Montevideo');
  });

  it('Carrasco Norte + ZIP 11300 (tres cruces zone) → stays carrasco norte', () => {
    const result = detectCityIntelligent('Carrasco Norte', 'Av Italia 5800', '', '11300');
    expect(result.barrio).toBe('carrasco norte');
    expect(result.department).toBe('Montevideo');
  });

  it('Belvedere + ZIP 11900 (cerro zone) → stays belvedere', () => {
    const result = detectCityIntelligent('Belvedere', 'Carlos Maria Ramirez 2500', '', '11900');
    expect(result.barrio).toBe('belvedere');
    expect(result.department).toBe('Montevideo');
  });

  it('Reducto + ZIP 11800 (carrasco zone) → stays reducto', () => {
    const result = detectCityIntelligent('Reducto', 'Gral Flores 3200', '', '11800');
    expect(result.barrio).toBe('reducto');
    expect(result.department).toBe('Montevideo');
  });

  it('Las Acacias + ZIP 11900 (cerro zone) → stays las acacias', () => {
    const result = detectCityIntelligent('Las Acacias', 'Instrucciones del Año XIII 1800', '', '11900');
    expect(result.barrio).toBe('las acacias');
    expect(result.department).toBe('Montevideo');
  });

  it('Cordón + ZIP 11800 (carrasco zone) → stays cordon', () => {
    const result = detectCityIntelligent('Cordón', 'Yi 1500', '', '11800');
    expect(result.barrio).toBe('cordon');
    expect(result.department).toBe('Montevideo');
  });
});

// ============================================================
// SECTION 11: Regression tests for Curva Divina production bugs
// ============================================================

// Bug #11117 — zone wrong: Av. Libertador should prefer parque batlle over tres cruces
describe('Regression #11117 — Av. Libertador zone detection', () => {
  it('Av. Libertador street maps to parque batlle as first candidate', () => {
    const barrios = getBarriosFromStreet('Av. Libertador 1748');
    expect(barrios).not.toBeNull();
    expect(barrios![0]).toBe('parque batlle');
  });

  // Product decision 2026-04-20: when customer did not name a barrio, do NOT guess even from
  // street-name heuristics. Av. Libertador overlaps several barrios; submit department only.
  it('detectCityIntelligent with Av. Libertador returns barrio null (no guessing)', () => {
    const result = detectCityIntelligent('Montevideo', 'Av. Libertador 1748', '', '');
    expect(result.barrio).toBeNull();
    expect(result.department).toBe('Montevideo');
  });
});

// Bug #11120 — zone wrong: "Rbla." abbreviation should resolve to rambla barrios
describe('Regression #11120 — Rbla. abbreviation zone detection', () => {
  it('getBarriosFromStreet handles Rbla. abbreviation', () => {
    const barrios = getBarriosFromStreet('Rbla. República de Chile 4507');
    expect(barrios).not.toBeNull();
    expect(barrios).toContain('pocitos');
  });

  // Product decision 2026-04-20: no barrio guessing from street heuristics when the
  // customer didn't name one. The getBarriosFromStreet helper still works (used elsewhere),
  // but detectCityIntelligent returns null and relies on department only.
  it('detectCityIntelligent with Rbla. address returns barrio null (no guessing)', () => {
    const result = detectCityIntelligent('Montevideo', 'Rbla. República de Chile 4507 002', '', '');
    expect(result.barrio).toBeNull();
    expect(result.department).toBe('Montevideo');
    expect(result.source).toBe('street');
  });
});

// Bug #11121 — "Puerta X" in address1 should be extracted to extraObs, not treated as apt
describe('Regression #11121 — Puerta X in address1', () => {
  it('Puerta at end of address1 extracted to extraObs', () => {
    const { fullAddress, extraObs } = mergeAddress('Cuató 3117 Puerta 3', undefined);
    expect(fullAddress).toBe('Cuató 3117');
    expect(extraObs).toBe('Puerta 3');
  });

  it('Puerta with letter suffix extracted to extraObs', () => {
    const { fullAddress, extraObs } = mergeAddress('Av. Italia 2500 Puerta A', undefined);
    expect(fullAddress).toBe('Av. Italia 2500');
    expect(extraObs).toBe('Puerta A');
  });

  it('Address without Puerta unaffected', () => {
    const { fullAddress, extraObs } = mergeAddress('Cuató 3117', undefined);
    expect(fullAddress).toBe('Cuató 3117');
    expect(extraObs).toBe('');
  });

  it('address2=Puerta 3 goes to extraObs without Apto prefix', () => {
    const { fullAddress, extraObs } = mergeAddress('Cuató 3117', 'Puerta 3');
    expect(fullAddress).toBe('Cuató 3117');
    expect(extraObs).toBe('Puerta 3');
    expect(extraObs).not.toContain('Apto');
  });
});

// Bug #11125/#11126 — consecutive orders: rambla variants work after rbla alias added
describe('Regression — street alias completeness', () => {
  it('rambla (full word) still maps correctly', () => {
    const barrios = getBarriosFromStreet('Rambla Gandhi 500');
    expect(barrios).not.toBeNull();
    expect(barrios).toContain('pocitos');
  });
});

// ============================================================
// Bug #11492 (2026-04-22) — DAC rejected Adriana Abeijon's order:
//   city  = "Mvdo."
//   addr  = "Juan Ortíz 3315, Apto. 201"
//   zip   = "11600"
//
// Root cause was a false-positive "high confidence" deterministic result:
//   - detectBarrio("Mvdo.", "Juan Ortíz 3315") → null  (not a known barrio alias)
//   - getBarriosFromZip("11600") → ['buceo', 'malvin', 'malvin norte'] (ambiguous)
//   - getBarriosFromStreet("Juan Ortíz 3315") → null (not in MVD_STREET_RANGES)
//   - Result: { barrio: null, department: "Montevideo", source: "zip",
//              confidence: "high" }
//
// `confidence === "high"` meant the AI fallback did NOT fire. Then the
// non-AI path in shipment.ts only normalized resolvedCity to "Montevideo"
// INSIDE an `if (barrio)` block — so resolvedCity stayed as "Mvdo.", which
// never matched the DAC city dropdown → city empty → form rejected.
//
// Two-part fix:
//   A) shipment.ts: always normalize resolvedCity to "Montevideo" when
//      geoDept is Montevideo, regardless of whether barrio was detected.
//   B) shouldInvokeAIResolver(): add a 4th trigger — "Montevideo resolved
//      but no barrio" — so the AI resolver fills in the barrio that the
//      deterministic table couldn't disambiguate.
// ============================================================
describe('Regression #11492 — Mvdo. + ambiguous ZIP 11600 + non-canonical street', () => {
  it('detectCityIntelligent returns dept=Montevideo, barrio=null, confidence=high for exact prod input', () => {
    const result = detectCityIntelligent('Mvdo.', 'Juan Ortíz 3315', 'Apto. 201', '11600');
    expect(result.department).toBe('Montevideo');
    expect(result.barrio).toBeNull();
    // This is the false-positive we're guarding against: deterministic path
    // reports "high confidence" even though the barrio is unresolved.
    expect(result.confidence).toBe('high');
  });

  it('shouldInvokeAIResolver returns true for the #11492 shape', () => {
    const intelligent = detectCityIntelligent('Mvdo.', 'Juan Ortíz 3315', 'Apto. 201', '11600');
    // Without the Fix-B clause this would return false → AI never fires →
    // barrio stays null → DAC rejects. With the fix the AI is invoked and
    // can resolve "Juan Ortíz 3315" → Buceo.
    expect(shouldInvokeAIResolver(intelligent)).toBe(true);
  });

  it('getDepartmentForCity resolves "Mvdo." deterministically to Montevideo (no AI needed for dept)', () => {
    // Sanity check that the alias table covers the abbreviation that triggered
    // the regression. The city-selector code in shipment.ts relies on this
    // mapping to decide it should normalize resolvedCity to "Montevideo".
    expect(getDepartmentForCity('Mvdo.')).toBe('Montevideo');
  });
});

// ============================================================
// shouldInvokeAIResolver — trigger matrix
// Documents the full decision table for when the Claude Haiku fallback fires.
// ============================================================
describe('shouldInvokeAIResolver — trigger matrix', () => {
  it('fires on low confidence', () => {
    expect(shouldInvokeAIResolver({
      barrio: null, department: null, source: 'none', confidence: 'low',
    })).toBe(true);
  });

  it('fires on medium confidence when barrio is null', () => {
    expect(shouldInvokeAIResolver({
      barrio: null, department: 'Montevideo', source: 'zip', confidence: 'medium',
    })).toBe(true);
  });

  it('does NOT fire on medium confidence with a barrio (customer named it)', () => {
    expect(shouldInvokeAIResolver({
      barrio: 'pocitos', department: 'Montevideo', source: 'alias', confidence: 'medium',
    })).toBe(false);
  });

  it('fires when both barrio and department are null', () => {
    expect(shouldInvokeAIResolver({
      barrio: null, department: null, source: 'none', confidence: 'high',
    })).toBe(true);
  });

  it('fires on Montevideo + no barrio, even at high confidence (#11492 clause)', () => {
    expect(shouldInvokeAIResolver({
      barrio: null, department: 'Montevideo', source: 'zip', confidence: 'high',
    })).toBe(true);
  });

  it('does NOT fire when department is a non-MVD dept with no barrio (we accept dept-only for interior)', () => {
    expect(shouldInvokeAIResolver({
      barrio: null, department: 'Canelones', source: 'zip', confidence: 'high',
    })).toBe(false);
  });

  it('does NOT fire when deterministic produced a confirmed barrio (high confidence + alias match)', () => {
    expect(shouldInvokeAIResolver({
      barrio: 'pocitos', department: 'Montevideo', source: 'zip', confidence: 'high',
    })).toBe(false);
  });
});
