import { describe, it, expect } from 'vitest';
import { mergeAddress } from '../dac/shipment';
import {
  getDepartmentForCity,
  getBarriosFromZip,
  getDepartmentFromZip,
  getBarriosFromStreet,
} from '../dac/uruguay-geo';
import { determinePaymentType } from '../rules/payment';

function makeOrder(totalPrice: string, currency = 'UYU') {
  return {
    id: 1,
    name: '#TEST',
    total_price: totalPrice,
    currency,
    shipping_address: { address1: 'Test', city: 'Montevideo', province: 'Montevideo' },
  } as any;
}

// ============================================================
// SECTION 1: mergeAddress — 50 tests
// ============================================================

describe('mergeAddress — comprehensive (50 tests)', () => {
  // ── 1. Empty/null address2 ──

  it('T01: address2 null returns address1 only', () => {
    const r = mergeAddress('Av Italia 1234', null);
    expect(r).toEqual({ fullAddress: 'Av Italia 1234', extraObs: '' });
  });

  it('T02: address2 undefined returns address1 only', () => {
    const r = mergeAddress('Colonia 500', undefined);
    expect(r).toEqual({ fullAddress: 'Colonia 500', extraObs: '' });
  });

  it('T03: address2 empty string returns address1 only', () => {
    const r = mergeAddress('Ejido 1234', '');
    expect(r).toEqual({ fullAddress: 'Ejido 1234', extraObs: '' });
  });

  it('T04: address2 whitespace-only returns address1 only', () => {
    const r = mergeAddress('Salto 100', '   ');
    expect(r).toEqual({ fullAddress: 'Salto 100', extraObs: '' });
  });

  it('T05: both empty returns empty', () => {
    const r = mergeAddress('', '');
    expect(r).toEqual({ fullAddress: '', extraObs: '' });
  });

  it('T06: address1 empty, address2 has apt', () => {
    const r = mergeAddress('', 'Apto 5');
    expect(r.fullAddress).toBe('');
    expect(r.extraObs).toBe('Apto 5');
  });

  // ── 2. Deduplication ──

  it('T07: exact number dedup — "705" already at end of address1 (v3: not extracted as apt)', () => {
    const r = mergeAddress('18 De Julio 705', '705');
    expect(r.fullAddress).toBe('18 De Julio 705');
    expect(r.fullAddress).not.toContain('705 705');
    // v3 (2026-04-10): 705 is 3 digits no leading zero → ambiguous → not apt
    expect(r.extraObs).toBe('');
  });

  it('T08: dedup with 4-digit number', () => {
    const r = mergeAddress('San Lorenzo 3247', '3247');
    expect(r.fullAddress).toBe('San Lorenzo 3247');
  });

  it('T09: dedup with street name suffix', () => {
    const r = mergeAddress('Av Italia 500 Pocitos', 'Pocitos');
    expect(r.fullAddress).toBe('Av Italia 500 Pocitos');
  });

  it('T10: NO dedup when number appears but not at end', () => {
    // "705" is in middle, not at end — should not dedup
    const r = mergeAddress('705 18 De Julio', '500');
    // address1 doesn't end with "500" → not dedup
    expect(r.fullAddress).toContain('500');
  });

  // ── 3. Apartment patterns ──

  it('T11: "Apto 5B" detected as apartment', () => {
    const r = mergeAddress('Rio Negro 1323', 'Apto 5B');
    expect(r.fullAddress).toBe('Rio Negro 1323');
    expect(r.extraObs).toBe('Apto 5B');
  });

  it('T12: "apto 201" lowercase detected', () => {
    const r = mergeAddress('Agraciada 3069', 'apto 201');
    expect(r.fullAddress).toBe('Agraciada 3069');
    expect(r.extraObs).toBe('apto 201');
  });

  it('T13: "Apt 10" without "o" detected', () => {
    const r = mergeAddress('Scoseria 2459', 'Apt 10');
    expect(r.fullAddress).toBe('Scoseria 2459');
    expect(r.extraObs).toBe('Apt 10');
  });

  it('T14: "Apt. 3" with period detected', () => {
    const r = mergeAddress('Colonia 800', 'Apt. 3');
    expect(r.fullAddress).toBe('Colonia 800');
    expect(r.extraObs).toBe('Apt. 3');
  });

  it('T15: "Piso 3" detected', () => {
    const r = mergeAddress('Av Italia 500', 'Piso 3');
    expect(r.fullAddress).toBe('Av Italia 500');
    expect(r.extraObs).toBe('Piso 3');
  });

  it('T16: "Depto 2A" detected', () => {
    const r = mergeAddress('Colonia 1234', 'Depto 2A');
    expect(r.fullAddress).toBe('Colonia 1234');
    expect(r.extraObs).toBe('Depto 2A');
  });

  it('T17: "Torre 2 Apto 5" detected', () => {
    const r = mergeAddress('Av Brasil 2500', 'Torre 2 Apto 5');
    expect(r.fullAddress).toBe('Av Brasil 2500');
    expect(r.extraObs).toBe('Torre 2 Apto 5');
  });

  it('T18: "local 5" detected', () => {
    const r = mergeAddress('18 de Julio 1000', 'local 5');
    expect(r.fullAddress).toBe('18 de Julio 1000');
    expect(r.extraObs).toBe('local 5');
  });

  it('T19: "oficina 302" detected', () => {
    const r = mergeAddress('Plaza Independencia 800', 'oficina 302');
    expect(r.fullAddress).toBe('Plaza Independencia 800');
    expect(r.extraObs).toBe('oficina 302');
  });

  it('T20: "puerta 3" detected', () => {
    const r = mergeAddress('Av Brasil 2500', 'puerta 3');
    expect(r.fullAddress).toBe('Av Brasil 2500');
    expect(r.extraObs).toBe('puerta 3');
  });

  it('T21: "Esc 2" (escalera) detected', () => {
    const r = mergeAddress('Colonia 900', 'Esc 2');
    expect(r.extraObs).toBe('Esc 2');
  });

  it('T22: "Block 4" detected', () => {
    const r = mergeAddress('Rambla 1000', 'Block 4');
    expect(r.extraObs).toBe('Block 4');
  });

  it('T23: "Unidad 7" detected', () => {
    const r = mergeAddress('Canelones 1500', 'Unidad 7');
    expect(r.extraObs).toBe('Unidad 7');
  });

  it('T24: "casa 3" detected (lowercase)', () => {
    const r = mergeAddress('Ruta 5 km 24', 'casa 3');
    expect(r.extraObs).toBe('casa 3');
  });

  // ── 4. Door+Apt combined ──

  it('T25: "1502B" splits into door + apt', () => {
    const r = mergeAddress('Av Rivera', '1502B');
    // address1 has no number: door part appended, apt letter to obs
    expect(r.fullAddress).toBe('Av Rivera 1502');
    expect(r.extraObs).toBe('Apto B');
  });

  it('T26: "304A" — address1 already has number, all goes to obs', () => {
    const r = mergeAddress('Canelones 1234', '304A');
    expect(r.fullAddress).toBe('Canelones 1234');
    expect(r.extraObs).toBe('Apto 304A');
  });

  it('T27: "2500C2" splits with apt letter+number', () => {
    const r = mergeAddress('Ejido', '2500C2');
    // address1 has no number: door part appended, apt part to obs
    expect(r.fullAddress).toBe('Ejido 2500');
    expect(r.extraObs).toBe('Apto C2');
  });

  it('T28: "12345Z" 5-digit door + letter', () => {
    const r = mergeAddress('Ruta 1', '12345Z');
    // address1 ends with "1" (a number), so address1 already has door
    expect(r.fullAddress).toBe('Ruta 1');
    expect(r.extraObs).toBe('Apto 12345Z');
  });

  // ── 5. Pure door number ──

  it('T29: pure door number appended when address1 has no number', () => {
    const r = mergeAddress('Av Italia', '500');
    expect(r.fullAddress).toBe('Av Italia 500');
    expect(r.extraObs).toBe('');
  });

  it('T30: pure door becomes apt when address1 already has number', () => {
    const r = mergeAddress('Salto 1032', '4');
    expect(r.fullAddress).toBe('Salto 1032');
    expect(r.extraObs).toBe('Apto 4');
  });

  it('T31: 3-digit number becomes apt when address1 has number', () => {
    const r = mergeAddress('Demostenes 3481', '801');
    expect(r.extraObs).toContain('Apto 801');
  });

  it('T32: pure 1-digit number as apt', () => {
    const r = mergeAddress('Colonia 1234', '2');
    expect(r.extraObs).toContain('Apto 2');
  });

  it('T33: pure door number to street without any number', () => {
    const r = mergeAddress('Rondeau', '1500');
    expect(r.fullAddress).toBe('Rondeau 1500');
    expect(r.extraObs).toBe('');
  });

  // ── 6. Direction references ──

  it('T34: "esquina Convencion" no observations', () => {
    const r = mergeAddress('18 de Julio 2000', 'esquina Convencion');
    expect(r.fullAddress).toBe('18 de Julio 2000 esquina Convencion');
    expect(r.extraObs).toBe('');
  });

  it('T35: "entre Yi y Ejido" no observations', () => {
    const r = mergeAddress('Colonia 1234', 'entre Yi y Ejido');
    expect(r.fullAddress).toBe('Colonia 1234 entre Yi y Ejido');
    expect(r.extraObs).toBe('');
  });

  it('T36: "frente a la plaza" no observations', () => {
    const r = mergeAddress('Sarandí 500', 'frente a la plaza');
    expect(r.fullAddress).toBe('Sarandí 500 frente a la plaza');
    expect(r.extraObs).toBe('');
  });

  it('T37: "casi Ejido" no observations', () => {
    const r = mergeAddress('18 de Julio 1800', 'casi Ejido');
    expect(r.fullAddress).toBe('18 de Julio 1800 casi Ejido');
    expect(r.extraObs).toBe('');
  });

  it('T38: "al lado del supermercado" no observations', () => {
    const r = mergeAddress('Ruta 5 km 20', 'al lado del supermercado');
    expect(r.fullAddress).toBe('Ruta 5 km 20 al lado del supermercado');
    expect(r.extraObs).toBe('');
  });

  // ── 7. Bis pattern ──

  it('T39: "1234 bis" appended without observations', () => {
    const r = mergeAddress('Colonia', '1234 bis');
    expect(r.fullAddress).toBe('Colonia 1234 bis');
    expect(r.extraObs).toBe('');
  });

  it('T40: "500 esq Rivera" appended without observations', () => {
    const r = mergeAddress('Av Brasil', '500 esq Rivera');
    expect(r.fullAddress).toBe('Av Brasil 500 esq Rivera');
    expect(r.extraObs).toBe('');
  });

  // ── 8. Short text starting with number ──

  it('T41: "103 (Susana De Haedo)" with address1 having number → obs only', () => {
    const r = mergeAddress('Liorna 6518', '103 ( Susana De Haedo)');
    expect(r.fullAddress).toBe('Liorna 6518');
    expect(r.extraObs).toBe('103 ( Susana De Haedo)');
  });

  it('T42: "3A puerta verde" with address1 having number → obs', () => {
    const r = mergeAddress('Colonia 800', '3A puerta verde');
    expect(r.extraObs).toBe('3A puerta verde');
  });

  it('T43: "5 timbre roto" with address1 having number → obs', () => {
    const r = mergeAddress('Ejido 1500', '5 timbre roto');
    expect(r.extraObs).toBe('5 timbre roto');
  });

  it('T44: short number+text without address1 number → goes to obs', () => {
    const r = mergeAddress('Rondeau', '5A edificio azul');
    // Falls through to catch-all: fullAddress = a1, extraObs = a2
    expect(r.fullAddress).toBe('Rondeau');
    expect(r.extraObs).toBe('5A edificio azul');
  });

  // ── 9. Default branch — long/unrecognized text ──

  it('T45: "Casa sin rejas" goes to default branch with obs only', () => {
    const r = mergeAddress('Emilio de Franco m34', 'Casa sin rejas');
    expect(r.fullAddress).toBe('Emilio de Franco m34');
    expect(r.extraObs).toBe('Casa sin rejas');
  });

  it('T46: "Complejo America. Senda 4" goes to default with obs only', () => {
    const r = mergeAddress('Andres y Yegros', 'Complejo America. Senda 4');
    expect(r.fullAddress).toBe('Andres y Yegros');
    expect(r.extraObs).toBe('Complejo America. Senda 4');
  });

  it('T47: "Montevideo" (city name) is filtered out — handled by DAC dropdown', () => {
    const r = mergeAddress('Luis Bonavita 1266 WTC', 'Montevideo');
    expect(r.fullAddress).toBe('Luis Bonavita 1266 WTC');
    expect(r.extraObs).toBe('');
  });

  it('T48: "Casa portones blancos" goes to default with obs', () => {
    const r = mergeAddress('Jardines Del Hum B09', 'Casa portones blancos');
    expect(r.extraObs).toBe('Casa portones blancos');
  });

  // ── 10. Whitespace edge cases ──

  it('T49: address1 with trailing spaces trimmed', () => {
    const r = mergeAddress('  Colonia 1234  ', null);
    expect(r.fullAddress).toBe('Colonia 1234');
  });

  it('T50: address2 with leading/trailing spaces trimmed', () => {
    const r = mergeAddress('Colonia 1234', '  Apto 5  ');
    expect(r.fullAddress).toBe('Colonia 1234');
    expect(r.extraObs).toBe('Apto 5');
  });
});

// ============================================================
// SECTION 2: getDepartmentForCity — 25 tests
// ============================================================

describe('getDepartmentForCity — comprehensive (25 tests)', () => {
  // ── Standard capitals ──

  it('T51: "Montevideo" → Montevideo', () => {
    expect(getDepartmentForCity('Montevideo')).toBe('Montevideo');
  });

  it('T52: "Canelones" → Canelones', () => {
    expect(getDepartmentForCity('Canelones')).toBe('Canelones');
  });

  it('T53: "Maldonado" → Maldonado', () => {
    expect(getDepartmentForCity('Maldonado')).toBe('Maldonado');
  });

  it('T54: "Salto" → Salto', () => {
    expect(getDepartmentForCity('Salto')).toBe('Salto');
  });

  it('T55: "Colonia del Sacramento" → Colonia', () => {
    expect(getDepartmentForCity('Colonia del Sacramento')).toBe('Colonia');
  });

  it('T56: "Paysandu" → Paysandu', () => {
    expect(getDepartmentForCity('Paysandu')).toBe('Paysandu');
  });

  it('T57: "Rivera" → Rivera', () => {
    expect(getDepartmentForCity('Rivera')).toBe('Rivera');
  });

  it('T58: "Durazno" → Durazno', () => {
    expect(getDepartmentForCity('Durazno')).toBe('Durazno');
  });

  it('T59: "Minas" → Lavalleja', () => {
    expect(getDepartmentForCity('Minas')).toBe('Lavalleja');
  });

  it('T60: "Tacuarembo" → Tacuarembo', () => {
    expect(getDepartmentForCity('Tacuarembo')).toBe('Tacuarembo');
  });

  // ── Canelones cities (common source of bugs) ──

  it('T61: "Lagomar" → Canelones (NOT Montevideo)', () => {
    expect(getDepartmentForCity('Lagomar')).toBe('Canelones');
  });

  it('T62: "La Floresta" → Canelones', () => {
    expect(getDepartmentForCity('La Floresta')).toBe('Canelones');
  });

  it('T63: "Ciudad de la Costa" → Canelones', () => {
    expect(getDepartmentForCity('Ciudad de la Costa')).toBe('Canelones');
  });

  it('T64: "Las Piedras" → Canelones', () => {
    expect(getDepartmentForCity('Las Piedras')).toBe('Canelones');
  });

  it('T65: "Pando" → Canelones', () => {
    expect(getDepartmentForCity('Pando')).toBe('Canelones');
  });

  it('T66: "Paso Carrasco" → Canelones', () => {
    expect(getDepartmentForCity('Paso Carrasco')).toBe('Canelones');
  });

  // ── Other interior cities ──

  it('T67: "Nueva Palmira" → Colonia', () => {
    expect(getDepartmentForCity('Nueva Palmira')).toBe('Colonia');
  });

  it('T68: "Nueva Helvecia" → Colonia', () => {
    expect(getDepartmentForCity('Nueva Helvecia')).toBe('Colonia');
  });

  it('T69: "Fray Bentos" → Rio Negro', () => {
    expect(getDepartmentForCity('Fray Bentos')).toBe('Rio Negro');
  });

  it('T70: "Cardona" → Soriano', () => {
    expect(getDepartmentForCity('Cardona')).toBe('Soriano');
  });

  // ── Normalization ──

  it('T71: lowercase "montevideo" works', () => {
    expect(getDepartmentForCity('montevideo')).toBe('Montevideo');
  });

  it('T72: UPPERCASE "SALTO" works', () => {
    expect(getDepartmentForCity('SALTO')).toBe('Salto');
  });

  it('T73: accented "Tacuarembó" works (accent stripped)', () => {
    expect(getDepartmentForCity('Tacuarembó')).toBe('Tacuarembo');
  });

  // ── Edge cases that return undefined ──

  it('T74: "Centro/Montevideo" — slash normalized, finds montevideo', () => {
    expect(getDepartmentForCity('Centro/Montevideo')).toBe('Montevideo');
  });

  it('T75: "2|montevideo" — pipe normalized, finds montevideo', () => {
    expect(getDepartmentForCity('2|montevideo')).toBe('Montevideo');
  });
});

// ============================================================
// SECTION 3: ZIP/Street geo functions — 15 tests
// ============================================================

describe('ZIP and street geo detection (15 tests)', () => {
  // ── getDepartmentFromZip ──

  it('T76: ZIP 11500 → Montevideo', () => {
    expect(getDepartmentFromZip('11500')).toBe('Montevideo');
  });

  it('T77: ZIP 15000 → Canelones', () => {
    expect(getDepartmentFromZip('15000')).toBe('Canelones');
  });

  it('T78: ZIP 20100 → Maldonado', () => {
    expect(getDepartmentFromZip('20100')).toBe('Maldonado');
  });

  it('T79: ZIP 70101 → Florida', () => {
    expect(getDepartmentFromZip('70101')).toBe('Florida');
  });

  it('T80: ZIP 75000 → Durazno', () => {
    expect(getDepartmentFromZip('75000')).toBe('Durazno');
  });

  it('T81: ZIP null → null', () => {
    expect(getDepartmentFromZip(null)).toBeNull();
  });

  it('T82: ZIP empty → null', () => {
    expect(getDepartmentFromZip('')).toBeNull();
  });

  it('T83: ZIP "1" (too short) → null', () => {
    expect(getDepartmentFromZip('1')).toBeNull();
  });

  // ── getBarriosFromZip ──

  it('T84: ZIP 11500 → includes "pocitos"', () => {
    const barrios = getBarriosFromZip('11500');
    expect(barrios).toContain('pocitos');
  });

  it('T85: ZIP 11800 → includes "carrasco"', () => {
    const barrios = getBarriosFromZip('11800');
    expect(barrios).toContain('carrasco');
  });

  it('T86: ZIP 11304 → rounds to 11300 → includes "tres cruces"', () => {
    const barrios = getBarriosFromZip('11304');
    expect(barrios).toContain('tres cruces');
  });

  it('T87: ZIP 50000 (Colonia) → null (not Montevideo)', () => {
    expect(getBarriosFromZip('50000')).toBeNull();
  });

  // ── getBarriosFromStreet ──

  it('T88: "18 de Julio 1500" → includes "centro"', () => {
    const barrios = getBarriosFromStreet('18 de Julio 1500');
    expect(barrios).toContain('centro');
  });

  it('T89: "Av Italia 3000" → includes "buceo"', () => {
    const barrios = getBarriosFromStreet('Av Italia 3000');
    expect(barrios).toContain('buceo');
  });

  it('T90: "Ruta 5 km 30" → null (not a known MVD street)', () => {
    expect(getBarriosFromStreet('Ruta 5 km 30')).toBeNull();
  });
});

// ============================================================
// SECTION 4: determinePaymentType — 10 tests
// ============================================================

describe('determinePaymentType — comprehensive (10 tests)', () => {
  it('T91: rule disabled → always DESTINATARIO regardless of amount', () => {
    expect(determinePaymentType(makeOrder('10000'), 3900, false)).toBe('DESTINATARIO');
  });

  it('T92: rule enabled, above threshold → REMITENTE', () => {
    expect(determinePaymentType(makeOrder('5000'), 3900, true)).toBe('REMITENTE');
  });

  it('T93: rule enabled, below threshold → DESTINATARIO', () => {
    expect(determinePaymentType(makeOrder('2000'), 3900, true)).toBe('DESTINATARIO');
  });

  it('T94: exactly at threshold → DESTINATARIO (not strictly greater)', () => {
    expect(determinePaymentType(makeOrder('3900'), 3900, true)).toBe('DESTINATARIO');
  });

  it('T95: 1 peso above threshold → REMITENTE', () => {
    expect(determinePaymentType(makeOrder('3901'), 3900, true)).toBe('REMITENTE');
  });

  it('T96: USD conversion — $100 USD * 42 = 4200 > 3900 → REMITENTE', () => {
    expect(determinePaymentType(makeOrder('100', 'USD'), 3900, true)).toBe('REMITENTE');
  });

  it('T97: USD below threshold — $50 * 42 = 2100 → DESTINATARIO', () => {
    expect(determinePaymentType(makeOrder('50', 'USD'), 3900, true)).toBe('DESTINATARIO');
  });

  it('T98: NaN total → defaults to 0 → DESTINATARIO', () => {
    expect(determinePaymentType(makeOrder('not-a-number'), 3900, true)).toBe('DESTINATARIO');
  });

  it('T99: negative total → DESTINATARIO', () => {
    expect(determinePaymentType(makeOrder('-500'), 3900, true)).toBe('DESTINATARIO');
  });

  it('T100: threshold 0 → DESTINATARIO (guard against invalid threshold)', () => {
    expect(determinePaymentType(makeOrder('1'), 0, true)).toBe('DESTINATARIO');
  });
});
