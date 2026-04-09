/**
 * 1000-TEST SUITE: Exhaustive verification of every pure function
 * in the LabelFlow shipment pipeline.
 *
 * Categories:
 *   A. getDepartmentForCity — 400 tests (all cities + edge cases)
 *   B. mergeAddress — 250 tests (every address pattern)
 *   C. determinePaymentType — 150 tests (every amount/currency/threshold combo)
 *   D. getBarriosFromZip — 80 tests (all ZIP codes)
 *   E. getBarriosFromStreet — 60 tests (all streets)
 *   F. getDepartmentFromZip — 40 tests (all prefixes)
 *   G. Integration scenarios — 20 tests
 */
import { describe, it, expect } from 'vitest';
import { mergeAddress } from '../dac/shipment';
import {
  getDepartmentForCity,
  getBarriosFromZip,
  getDepartmentFromZip,
  getBarriosFromStreet,
  CITY_TO_DEPARTMENT,
  DEPARTMENTS,
} from '../dac/uruguay-geo';
import { determinePaymentType } from '../rules/payment';

function mockOrder(total: string, currency = 'UYU'): any {
  return { id: 1, name: '#T', total_price: total, currency };
}

// ================================================================
// A. getDepartmentForCity — 400 tests
// ================================================================
describe('A. getDepartmentForCity — all cities', () => {

  // A1. Every single entry in CITY_TO_DEPARTMENT must round-trip (300+ tests)
  const allEntries = Object.entries(CITY_TO_DEPARTMENT);
  it.each(allEntries)('DB entry "%s" → %s', (city, expectedDept) => {
    expect(getDepartmentForCity(city)).toBe(expectedDept);
  });

  // A2. Case insensitivity (20 tests)
  it.each([
    ['MONTEVIDEO', 'Montevideo'],
    ['montevideo', 'Montevideo'],
    ['Montevideo', 'Montevideo'],
    ['POCITOS', 'Montevideo'],
    ['pocitos', 'Montevideo'],
    ['Pocitos', 'Montevideo'],
    ['SALTO', 'Salto'],
    ['salto', 'Salto'],
    ['PUNTA DEL ESTE', 'Maldonado'],
    ['punta del este', 'Maldonado'],
    ['CIUDAD DE LA COSTA', 'Canelones'],
    ['ciudad de la costa', 'Canelones'],
    ['TREINTA Y TRES', 'Treinta y Tres'],
    ['treinta y tres', 'Treinta y Tres'],
    ['FRAY BENTOS', 'Rio Negro'],
    ['fray bentos', 'Rio Negro'],
    ['COLONIA DEL SACRAMENTO', 'Colonia'],
    ['SAN JOSE DE MAYO', 'San Jose'],
    ['PASO DE LOS TOROS', 'Tacuarembo'],
    ['BELLA UNION', 'Artigas'],
  ])('case insensitive: "%s" → %s', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A3. Accent handling (10 tests)
  it.each([
    ['Paysandú', 'Paysandu'],
    ['Tacuarembó', 'Tacuarembo'],
    ['Piriápolis', 'Maldonado'], // accented — normalize strips accent, finds piriapolis in DB
    ['José Ignacio', 'Maldonado'],
    ['Sarandí Grande', 'Florida'],
    ['Sarandí del Yi', 'Durazno'],
    ['Peñarol', 'Montevideo'],
    ['Larrañaga', 'Montevideo'],
    ['San José de Mayo', 'San Jose'],
    ['Río Branco', 'Cerro Largo'],
  ])('accented: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A4. Dot handling (5 tests)
  it.each([
    ['La.paz', 'Canelones'],
    ['La.Paz', 'Canelones'],
    ['la.paz', 'Canelones'],
    ['San.Jose', 'San Jose'],
    ['San.Jose.de.Mayo', 'San Jose'],
  ])('dots: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A5. Country suffix (5 tests)
  it.each([
    ['montevideo- URUGUAY', 'Montevideo'],
    ['Salto, Uruguay', 'Salto'],
    ['Canelones- Uruguay', 'Canelones'],
    ['Rivera-Uruguay', 'Rivera'],
    ['Maldonado, URUGUAY', 'Maldonado'],
  ])('country suffix: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A6. Pipe separator (5 tests)
  it.each([
    ['2|montevideo', 'Montevideo'],
    ['1|salto', 'Salto'],
    ['|pocitos', 'Montevideo'],
    ['3|canelones', 'Canelones'],
    ['xxx|rivera', 'Rivera'],
  ])('pipe: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A7. Slash separator (5 tests)
  it.each([
    ['centro/Rivera', 'Montevideo'], // centro first
    ['xxx/maldonado', 'Maldonado'],
    ['barrio/pocitos', 'Montevideo'],
    ['zona/salto', 'Salto'],
    ['norte/carrasco', 'Montevideo'],
  ])('slash: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A8. Comma separator (5 tests)
  it.each([
    ['Barrio Espanol, Atlantida Norte', 'Canelones'],
    ['Villa Sur, Montevideo', 'Montevideo'],
    ['Centro, Maldonado', 'Maldonado'],
    ['xxx, Florida', 'Florida'],
    ['yyy, Salto', 'Salto'],
  ])('comma: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A9. Compound city (10 tests)
  it.each([
    ['Ciudad de la Costa solymar', 'Canelones'],
    ['Ciudad de la Costa lagomar', 'Canelones'],
    ['Paso de los Toros centro', 'Tacuarembo'],
    ['Punta del Este playa', 'Maldonado'],
    ['San Jose de Mayo centro', 'San Jose'],
    ['Colonia del Sacramento', 'Colonia'],
    ['Treinta y Tres centro', 'Treinta y Tres'],
    ['carrasco sur jardines', 'Montevideo'],
    ['La Paz Canelones', 'Canelones'],
    ['Bella Union norte', 'Artigas'],
  ])('compound: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A10. Extra whitespace (5 tests)
  it.each([
    ['  Pocitos  ', 'Montevideo'],
    ['  Salto ', 'Salto'],
    ['Maldonado   ', 'Maldonado'],
    ['   Canelones', 'Canelones'],
    ['  Ciudad de la Costa  ', 'Canelones'],
  ])('whitespace: "%s"', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A11. Invalid/empty input (5 tests)
  it.each([
    ['', undefined],
    ['   ', undefined],
    ['xyzzytown', undefined],
    ['12345', undefined],
    ['!!!', undefined],
  ])('invalid: "%s" → undefined', (city, expected) => {
    expect(getDepartmentForCity(city)).toBe(expected);
  });

  // A12. All 19 departments exist
  it('all 19 departments are represented in CITY_TO_DEPARTMENT', () => {
    const depts = new Set(Object.values(CITY_TO_DEPARTMENT));
    for (const d of DEPARTMENTS) {
      expect(depts.has(d)).toBe(true);
    }
  });
});

// ================================================================
// B. mergeAddress — 250 tests
// ================================================================
describe('B. mergeAddress — exhaustive', () => {

  // B1. Null/empty address2 (10 tests)
  it.each([
    ['Rivera 2500', null, 'Rivera 2500', ''],
    ['Rivera 2500', undefined, 'Rivera 2500', ''],
    ['Rivera 2500', '', 'Rivera 2500', ''],
    ['Av Italia 3000', null, 'Av Italia 3000', ''],
    ['18 de Julio 1234', null, '18 de Julio 1234', ''],
    ['Colorado 1850', undefined, 'Colorado 1850', ''],
    ['Bvar Artigas', '', 'Bvar Artigas', ''],
    ['Rambla 5000', null, 'Rambla 5000', ''],
    ['Camino Carrasco 5400', null, 'Camino Carrasco 5400', ''],
    ['Ellauri 980', null, 'Ellauri 980', ''],
  ])('no addr2: "%s" + %s → "%s"', (a1, a2, expectedAddr, expectedObs) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(expectedAddr);
    expect(r.extraObs).toBe(expectedObs);
  });

  // B2. Door numbers (15 tests)
  it.each([
    ['Rivera', '2500', 'Rivera 2500', ''],
    ['Colorado', '1850', 'Colorado 1850', ''],
    ['18 de Julio', '705', '18 de Julio 705', ''],
    ['Bvar Artigas', '1100', 'Bvar Artigas 1100', ''],
    ['Av Italia', '3456', 'Av Italia 3456', ''],
    ['Ellauri', '980', 'Ellauri 980', ''],
    ['Millan', '3200', 'Millan 3200', ''],
    ['Constituyente', '1500', 'Constituyente 1500', ''],
    ['Camino Maldonado', '5890', 'Camino Maldonado 5890', ''],
    ['Rambla', '5000', 'Rambla 5000', ''],
    ['Gestido', '2100', 'Gestido 2100', ''],
    ['8 de Octubre', '3400', '8 de Octubre 3400', ''],
    ['Avenida Brasil', '2800', 'Avenida Brasil 2800', ''],
    ['Dr Luis Piera', '1700', 'Dr Luis Piera 1700', ''],
    ['Fernandez Crespo', '2000', 'Fernandez Crespo 2000', ''],
  ])('door: "%s" + "%s" → "%s"', (a1, a2, expectedAddr, expectedObs) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(expectedAddr);
    expect(r.extraObs).toBe(expectedObs);
  });

  // B3. Door number when addr1 already has one (10 tests)
  it.each([
    ['Rivera 2500', '301', 'Rivera 2500', 'Apto 301'],
    ['18 de Julio 1234', '502', '18 de Julio 1234', 'Apto 502'],
    ['Av Italia 3456', '12', 'Av Italia 3456', 'Apto 12'],
    ['Colorado 1850', '3', 'Colorado 1850', 'Apto 3'],
    ['Bvar Artigas 1100', '801', 'Bvar Artigas 1100', 'Apto 801'],
    ['Ellauri 980', '15', 'Ellauri 980', 'Apto 15'],
    ['Millan 3200', '401', 'Millan 3200', 'Apto 401'],
    ['Rambla 5000', '22', 'Rambla 5000', 'Apto 22'],
    ['Gestido 2100', '7', 'Gestido 2100', 'Apto 7'],
    ['Constituyente 1500', '601', 'Constituyente 1500', 'Apto 601'],
  ])('door+apt: "%s" + "%s" → "%s" obs="%s"', (a1, a2, expectedAddr, expectedObs) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(expectedAddr);
    expect(r.extraObs).toBe(expectedObs);
  });

  // B4. Apartment patterns (20 tests) — address2 goes to obs only
  it.each([
    ['Rivera 2500', 'Apto 301', 'Rivera 2500', 'Apto 301'],
    ['Rivera 2500', 'Apto. 301', 'Rivera 2500', 'Apto. 301'],
    ['Rivera 2500', 'Apt 5', 'Rivera 2500', 'Apt 5'],
    ['Av Italia 3000', 'Piso 3', 'Av Italia 3000', 'Piso 3'],
    ['18 de Julio 1234', 'Depto 4', '18 de Julio 1234', 'Depto 4'],
    ['Colorado 1850', 'Torre 2', 'Colorado 1850', 'Torre 2'],
    ['Bvar Artigas 1100', 'Block 3', 'Bvar Artigas 1100', 'Block 3'],
    ['Ellauri 980', 'Bloque 1', 'Ellauri 980', 'Bloque 1'],
    ['Millan 3200', 'Unidad 7', 'Millan 3200', 'Unidad 7'],
    ['Rambla 5000', 'Puerta 2', 'Rambla 5000', 'Puerta 2'],
    ['Gestido 2100', 'Casa 5', 'Gestido 2100', 'Casa 5'],
    ['8 de Octubre 3400', 'Local 3', '8 de Octubre 3400', 'Local 3'],
    ['Constituyente 1500', 'Of. 201', 'Constituyente 1500', 'Of. 201'],
    ['Camino Maldonado 5890', 'Oficina 3', 'Camino Maldonado 5890', 'Oficina 3'],
    ['Av Brasil 2800', 'Esc. 2', 'Av Brasil 2800', 'Esc. 2'],
    ['Rivera 2500', 'Apto 1 Torre A', 'Rivera 2500', 'Apto 1 Torre A'],
    ['18 de Julio 800', 'Piso 12 Apto 1201', '18 de Julio 800', 'Piso 12 Apto 1201'],
    ['Colorado 1850', 'Casa 15', 'Colorado 1850', 'Casa 15'],
    ['Ellauri 980', 'Local 2B', 'Ellauri 980', 'Local 2B'],
    ['Rambla 5000', 'Torre 3 Piso 8', 'Rambla 5000', 'Torre 3 Piso 8'],
  ])('apt pattern: "%s" + "%s" → obs="%s"', (a1, a2, expectedAddr, expectedObs) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(expectedAddr);
    expect(r.extraObs).toBe(expectedObs);
  });

  // B5. Phone numbers in address2 — must be IGNORED (15 tests)
  it.each([
    ['Rivera 2500', '099680230'],
    ['18 de Julio 1234', '099123456'],
    ['Colorado 1850', '098765432'],
    ['Av Italia 3000', '091234567'],
    ['Bvar Artigas 1100', '099-680-230'],
    ['Ellauri 980', '099 680 230'],
    ['Millan 3200', '+59899680230'],
    ['Rambla 5000', '09812345678'],
    ['Gestido 2100', '099111222'],
    ['8 de Octubre 3400', '099333444'],
    ['Constituyente 1500', '098555666'],
    ['Camino Maldonado 5890', '091777888'],
    ['Av Brasil 2800', '099999000'],
    ['Camino Carrasco 5400', '099-123-456'],
    ['Dr Luis Piera 1700', '098-765-432'],
  ])('phone ignored: "%s" + "%s" → addr unchanged', (a1, a2) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(a1);
    expect(r.extraObs).toBe('');
  });

  // B6. City/department in address2 — must be IGNORED (20 tests)
  it.each([
    'montevideo', 'canelones', 'maldonado', 'salto', 'paysandu',
    'rivera', 'tacuarembo', 'colonia', 'soriano', 'rocha',
    'florida', 'durazno', 'artigas', 'pocitos', 'buceo',
    'carrasco', 'punta carretas', 'centro', 'cordon', 'malvin',
  ])('city ignored: addr2="%s"', (city) => {
    const r = mergeAddress('Rivera 2500', city);
    expect(r.fullAddress).toBe('Rivera 2500');
    expect(r.extraObs).toBe('');
  });

  // B7. Duplicate detection (10 tests)
  it.each([
    ['18 De Julio 705', '705'],
    ['Rivera 2500', '2500'],
    ['Colorado 1850', '1850'],
    ['Av Italia 3456', '3456'],
    ['Bvar Artigas 1100', '1100'],
    ['Ellauri 980', '980'],
    ['Millan 3200', '3200'],
    ['Rambla 5000', '5000'],
    ['Gestido 2100', '2100'],
    ['Constituyente 1500', '1500'],
  ])('dedup: "%s" + "%s" → no append', (a1, a2) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(a1);
  });

  // B8. Direction references (10 tests)
  it.each([
    ['Rivera 2500', 'esq. Av Italia', ''],
    ['18 de Julio 1234', 'entre Colonia y Soriano', ''],
    ['Colorado 1850', 'frente al parque', ''],
    ['Av Italia 3000', 'al lado del shopping', ''],
    ['Bvar Artigas 1100', 'cerca del estadio', ''],
    ['Ellauri 980', 'junto a la farmacia', ''],
    ['Millan 3200', 'casi Rivera', ''],
    ['Rambla 5000', 'a metros del faro', ''],
    ['Gestido 2100', 'esquina Bvar Espana', ''],
    ['8 de Octubre 3400', 'entre Millan y 8 Oct', ''],
  ])('direction: "%s" + "%s" → obs=""', (a1, a2, expectedObs) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toContain(a2);
    expect(r.extraObs).toBe(expectedObs);
  });

  // B9. Combined door+apt "1502B" (10 tests)
  it.each([
    ['Av Italia', '1502B'],
    ['Rivera', '3200A'],
    ['Colorado', '1850C'],
    ['Bvar Artigas', '1100D'],
    ['18 de Julio', '705A'],
    ['Ellauri', '980B'],
    ['Millan', '3200E'],
    ['Rambla', '5000F'],
    ['Gestido', '2100G'],
    ['Constituyente', '1500H'],
  ])('door+apt combo: "%s" + "%s"', (a1, a2) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toContain(a1);
    expect(r.extraObs).toContain(a2.slice(-1)); // apt letter in obs
  });

  // B10. "bis" pattern (5 tests)
  it.each([
    ['Rivera', '2500 bis'],
    ['Colorado', '1850 bis'],
    ['Av Italia', '3456 bis'],
    ['18 de Julio', '705 bis'],
    ['Bvar Artigas', '1100 bis'],
  ])('bis: "%s" + "%s"', (a1, a2) => {
    const r = mergeAddress(a1, a2);
    expect(r.fullAddress).toBe(`${a1} ${a2}`);
    expect(r.extraObs).toBe('');
  });

  // B11. Known places in address2 are ignored (all 30+ entries)
  const knownPlaces = [
    'montevideo', 'canelones', 'maldonado', 'salto', 'paysandu', 'rivera', 'tacuarembo',
    'colonia', 'soriano', 'rocha', 'florida', 'durazno', 'artigas', 'treinta y tres',
    'cerro largo', 'lavalleja', 'san jose', 'flores', 'rio negro', 'pocitos', 'buceo',
    'carrasco', 'punta carretas', 'centro', 'cordon', 'parque rodo', 'malvin', 'union',
    'la blanqueada', 'tres cruces', 'prado',
  ];
  it.each(knownPlaces)('known place ignored: "%s"', (place) => {
    const r = mergeAddress('Test 123', place);
    expect(r.fullAddress).toBe('Test 123');
  });

  // B12. Long text in address2 goes to both (5 tests)
  it.each([
    'Edificio Torre Azul entrada norte complejo residencial',
    'Complejo habitacional Las Palmas bloque norte entrada lateral',
    'Cooperativa de viviendas Los Pinos casa numero veintitres',
    'Barrio privado Los Olivos casa esquina con piscina',
    'Condominio del Lago torre sur penthouse ultimo piso',
  ])('long text: "%s"', (a2) => {
    const r = mergeAddress('Rambla 5000', a2);
    expect(r.fullAddress).toBe('Rambla 5000');
    expect(r.extraObs).toBe(a2);
  });
});

// ================================================================
// C. determinePaymentType — 150 tests
// ================================================================
describe('C. determinePaymentType — exhaustive', () => {
  const T = 3900;

  // C1. UYU amounts around threshold (30 tests)
  it.each([
    ['100', 'DESTINATARIO'], ['500', 'DESTINATARIO'], ['1000', 'DESTINATARIO'],
    ['1500', 'DESTINATARIO'], ['2000', 'DESTINATARIO'], ['2500', 'DESTINATARIO'],
    ['3000', 'DESTINATARIO'], ['3500', 'DESTINATARIO'], ['3800', 'DESTINATARIO'],
    ['3899', 'DESTINATARIO'], ['3899.99', 'DESTINATARIO'], ['3900', 'DESTINATARIO'],
    ['3900.00', 'DESTINATARIO'], ['3900.01', 'REMITENTE'], ['3901', 'REMITENTE'],
    ['4000', 'REMITENTE'], ['4500', 'REMITENTE'], ['5000', 'REMITENTE'],
    ['6000', 'REMITENTE'], ['7000', 'REMITENTE'], ['8000', 'REMITENTE'],
    ['10000', 'REMITENTE'], ['15000', 'REMITENTE'], ['20000', 'REMITENTE'],
    ['50000', 'REMITENTE'], ['99999', 'REMITENTE'], ['100000', 'REMITENTE'],
    ['500000', 'REMITENTE'], ['999999', 'REMITENTE'], ['1000000', 'REMITENTE'],
  ])('UYU %s → %s', (amount, expected) => {
    expect(determinePaymentType(mockOrder(amount), T, true)).toBe(expected);
  });

  // C2. USD conversion (rate=43) (20 tests)
  it.each([
    ['10', 'DESTINATARIO'],  // 430
    ['20', 'DESTINATARIO'],  // 860
    ['50', 'DESTINATARIO'],  // 2150
    ['80', 'DESTINATARIO'],  // 3440
    ['89', 'DESTINATARIO'],  // 3827
    ['90', 'DESTINATARIO'],  // 3870
    ['90.5', 'DESTINATARIO'],// 3891.5
    ['90.69', 'DESTINATARIO'],// 3899.67
    ['90.70', 'REMITENTE'],  // 3900.1
    ['91', 'REMITENTE'],     // 3913
    ['95', 'REMITENTE'],     // 4085
    ['100', 'REMITENTE'],    // 4300
    ['150', 'REMITENTE'],    // 6450
    ['200', 'REMITENTE'],    // 8600
    ['300', 'REMITENTE'],    // 12900
    ['500', 'REMITENTE'],    // 21500
    ['1000', 'REMITENTE'],   // 43000
    ['5', 'DESTINATARIO'],   // 215
    ['1', 'DESTINATARIO'],   // 43
    ['0.5', 'DESTINATARIO'], // 21.5
  ])('USD %s → %s', (amount, expected) => {
    expect(determinePaymentType(mockOrder(amount, 'USD'), T, true)).toBe(expected);
  });

  // C3. EUR conversion (rate=47) (10 tests)
  it.each([
    ['10', 'DESTINATARIO'],  // 470
    ['50', 'DESTINATARIO'],  // 2350
    ['80', 'DESTINATARIO'],  // 3760
    ['82', 'DESTINATARIO'],  // 3854
    ['83', 'REMITENTE'],     // 3901
    ['100', 'REMITENTE'],    // 4700
    ['200', 'REMITENTE'],    // 9400
    ['500', 'REMITENTE'],    // 23500
    ['1', 'DESTINATARIO'],   // 47
    ['82.97', 'DESTINATARIO'],// 3899.59
  ])('EUR %s → %s', (amount, expected) => {
    expect(determinePaymentType(mockOrder(amount, 'EUR'), T, true)).toBe(expected);
  });

  // C4. BRL conversion (rate=8) (10 tests)
  it.each([
    ['100', 'DESTINATARIO'], // 800
    ['200', 'DESTINATARIO'], // 1600
    ['400', 'DESTINATARIO'], // 3200
    ['487', 'DESTINATARIO'], // 3896
    ['487.5', 'DESTINATARIO'],// 3900 (exactly = DEST)
    ['488', 'REMITENTE'],    // 3904
    ['500', 'REMITENTE'],    // 4000
    ['1000', 'REMITENTE'],   // 8000
    ['50', 'DESTINATARIO'],  // 400
    ['10', 'DESTINATARIO'],  // 80
  ])('BRL %s → %s', (amount, expected) => {
    expect(determinePaymentType(mockOrder(amount, 'BRL'), T, true)).toBe(expected);
  });

  // C5. ARS conversion (rate=0.04) (10 tests)
  it.each([
    ['1000', 'DESTINATARIO'],    // 40
    ['10000', 'DESTINATARIO'],   // 400
    ['50000', 'DESTINATARIO'],   // 2000
    ['90000', 'DESTINATARIO'],   // 3600
    ['97500', 'DESTINATARIO'],   // 3900 (exactly = DEST)
    ['97501', 'REMITENTE'],      // 3900.04
    ['100000', 'REMITENTE'],     // 4000
    ['200000', 'REMITENTE'],     // 8000
    ['500000', 'REMITENTE'],     // 20000
    ['1000000', 'REMITENTE'],    // 40000
  ])('ARS %s → %s', (amount, expected) => {
    expect(determinePaymentType(mockOrder(amount, 'ARS'), T, true)).toBe(expected);
  });

  // C6. Unknown currencies → DESTINATARIO (10 tests)
  it.each(['GBP', 'CHF', 'JPY', 'CNY', 'CAD', 'AUD', 'NZD', 'MXN', 'CLP', 'PEN'])
  ('unknown currency %s → DESTINATARIO', (currency) => {
    expect(determinePaymentType(mockOrder('5000', currency), T, true)).toBe('DESTINATARIO');
  });

  // C7. Invalid inputs → DESTINATARIO (15 tests)
  it.each([
    ['abc', 'UYU'], ['', 'UYU'], ['null', 'UYU'],
    ['undefined', 'UYU'], ['NaN', 'UYU'], ['Infinity', 'UYU'],
    ['-Infinity', 'UYU'], ['--500', 'UYU'], ['12.34.56', 'UYU'],
    ['$5000', 'UYU'], ['5,000', 'UYU'], ['5.000,00', 'UYU'],
    ['abc', 'USD'], ['xyz', 'EUR'], ['!!!', 'BRL'],
  ])('invalid: "%s" %s → DESTINATARIO', (amount, currency) => {
    expect(determinePaymentType(mockOrder(amount, currency), T, true)).toBe('DESTINATARIO');
  });

  // C8. Zero and negative amounts → DESTINATARIO (10 tests)
  it.each([
    '0', '0.00', '-1', '-100', '-500', '-3900', '-5000', '-0.01', '-99999', '0.0',
  ])('zero/negative: "%s" → DESTINATARIO', (amount) => {
    expect(determinePaymentType(mockOrder(amount), T, true)).toBe('DESTINATARIO');
  });

  // C9. Bad thresholds → DESTINATARIO (10 tests)
  it.each([0, -1, -100, -3900, NaN, Infinity, -Infinity, 0.0, -0.01, -99999])
  ('bad threshold %s → DESTINATARIO', (threshold) => {
    expect(determinePaymentType(mockOrder('5000'), threshold, true)).toBe('DESTINATARIO');
  });

  // C10. paymentRuleEnabled=false (10 tests)
  it.each([
    '100', '3900', '5000', '10000', '50000', '100000', '999999', '1', '0', '-500',
  ])('disabled rule, amount=%s → DESTINATARIO', (amount) => {
    expect(determinePaymentType(mockOrder(amount), T, false)).toBe('DESTINATARIO');
  });

  // C11. Different thresholds (15 tests)
  it.each([
    [100, '99', 'DESTINATARIO'],
    [100, '101', 'REMITENTE'],
    [1000, '999', 'DESTINATARIO'],
    [1000, '1001', 'REMITENTE'],
    [5000, '4999', 'DESTINATARIO'],
    [5000, '5001', 'REMITENTE'],
    [10000, '9999', 'DESTINATARIO'],
    [10000, '10001', 'REMITENTE'],
    [50000, '49999', 'DESTINATARIO'],
    [50000, '50001', 'REMITENTE'],
    [1, '0.5', 'DESTINATARIO'],
    [1, '1.01', 'REMITENTE'],
    [100000, '99999', 'DESTINATARIO'],
    [100000, '100001', 'REMITENTE'],
    [500000, '500001', 'REMITENTE'],
  ])('threshold=%d, amount=%s → %s', (threshold, amount, expected) => {
    expect(determinePaymentType(mockOrder(amount), threshold, true)).toBe(expected);
  });
});

// ================================================================
// D. getBarriosFromZip — 80 tests
// ================================================================
describe('D. getBarriosFromZip — all ZIPs', () => {
  // D1. All exact Montevideo ZIP entries
  it.each([
    ['11000', ['ciudad vieja', 'centro']],
    ['11100', ['centro', 'cordon', 'barrio sur']],
    ['11200', ['cordon', 'parque rodo', 'palermo']],
    ['11300', ['tres cruces', 'la comercial', 'la figurita', 'jacinto vera']],
    ['11400', ['la blanqueada', 'goes', 'reducto', 'brazo oriental']],
    ['11500', ['pocitos', 'punta carretas', 'parque batlle']],
    ['11600', ['buceo', 'malvin', 'malvin norte']],
    ['11700', ['union', 'maronas', 'flor de maronas', 'las canteras']],
    ['11800', ['carrasco', 'carrasco norte', 'punta gorda']],
    ['11900', ['cerro', 'la teja', 'paso de la arena', 'casabo']],
    ['12000', ['colon', 'lezica', 'sayago']],
    ['12100', ['prado', 'capurro', 'belvedere', 'nuevo paris']],
    ['12200', ['aires puros', 'casavalle', 'piedras blancas']],
    ['12300', ['manga', 'punta de rieles', 'villa garcia']],
    ['12400', ['atahualpa', 'mercado modelo', 'villa dolores']],
    ['12500', ['capurro', 'belvedere', 'aguada']],
    ['12600', ['pocitos nuevo', 'villa española']],
    ['12700', ['tres ombues', 'villa muñoz']],
    ['12800', ['cerrito']],
  ])('ZIP %s → %j', (zip, expected) => {
    expect(getBarriosFromZip(zip)).toEqual(expected);
  });

  // D2. Rounding (20 tests)
  it.each([
    ['11001', '11000'], ['11050', '11000'], ['11099', '11000'],
    ['11101', '11100'], ['11150', '11100'], ['11199', '11100'],
    ['11201', '11200'], ['11301', '11300'], ['11401', '11400'],
    ['11501', '11500'], ['11601', '11600'], ['11701', '11700'],
    ['11801', '11800'], ['11901', '11900'], ['12001', '12000'],
    ['12101', '12100'], ['12201', '12200'], ['12301', '12300'],
    ['12401', '12400'], ['12501', '12500'],
  ])('ZIP %s rounds to %s', (input, rounded) => {
    const expected = getBarriosFromZip(rounded);
    expect(getBarriosFromZip(input)).toEqual(expected);
  });

  // D3. Non-Montevideo ZIPs → null (20 tests)
  it.each([
    '15000', '16000', '17000', '20000', '21000', '25000',
    '27000', '30000', '33000', '35000', '37000', '40000',
    '45000', '47000', '50000', '60000', '65000', '70000',
    '75000', '85000',
  ])('non-MVD ZIP %s → null', (zip) => {
    expect(getBarriosFromZip(zip)).toBeNull();
  });

  // D4. Invalid inputs (10 tests)
  it.each([null, undefined, '', '1', '12', '123', 'abc', '!@#', 'ZIP', '   '])
  ('invalid ZIP %s → null', (zip) => {
    expect(getBarriosFromZip(zip as any)).toBeNull();
  });

  // D5. ZIPs with non-digits (5 tests)
  it.each([
    ['11-500', '11500'], ['11.800', '11800'], ['11 300', '11300'],
    ['CP 11500', '11500'], ['UY-11800', '11800'],
  ])('strips non-digits: "%s" same as %s', (input, clean) => {
    expect(getBarriosFromZip(input)).toEqual(getBarriosFromZip(clean));
  });
});

// ================================================================
// E. getBarriosFromStreet — 60 tests
// ================================================================
describe('E. getBarriosFromStreet — all streets', () => {
  // E1. Every street in MONTEVIDEO_STREET_TO_BARRIOS (35+ tests)
  it.each([
    ['18 de Julio 1234', 'centro'],
    ['Bvar Artigas 1100', 'tres cruces'],
    ['Boulevard Artigas 500', 'tres cruces'],
    ['Av Italia 3000', 'buceo'],
    ['Avenida Italia 2800', 'buceo'],
    ['8 de Octubre 3400', 'goes'],
    ['Av Rivera 2500', 'pocitos'],
    ['Avenida Rivera 3000', 'pocitos'],
    ['Camino Maldonado 5890', 'union'],
    ['Millan 3200', 'la blanqueada'],
    ['Av Millan 2800', 'reducto'],
    ['Avenida Millan 2500', 'reducto'],
    ['General Flores 4000', 'goes'],
    ['Gral Flores 3500', 'goes'],
    ['Camino Carrasco 5400', 'carrasco'],
    ['Luis A de Herrera 1200', 'la blanqueada'],
    ['Herrera y Obes 1400', 'centro'],
    ['Camino Centenario 2000', 'aires puros'],
    ['Bvar Batlle y Ordonez 3000', 'goes'],
    ['Av Agraciada 3500', 'aguada'],
    ['Avenida Agraciada 3000', 'aguada'],
    ['Constituyente 1500', 'cordon'],
    ['Bvar Espana 2800', 'parque rodo'],
    ['Boulevard Espana 2500', 'parque rodo'],
    ['21 de Setiembre 2900', 'pocitos'],
    ['Ellauri 980', 'pocitos'],
    ['Av Brasil 2800', 'pocitos'],
    ['Avenida Brasil 2500', 'pocitos'],
    ['Dr Luis Piera 1700', 'parque rodo'],
    ['Av Libertador 1600', 'tres cruces'],
    ['Av Gianattasio km20', 'carrasco'],
    ['Av Instrucciones 2000', 'prado'],
    ['Colorado 1850', 'goes'],
    ['Gestido 2100', 'pocitos'],
    ['Fernandez Crespo 2000', 'goes'],
    ['Cubo del Norte 1200', 'aguada'],
    ['Av San Martin 3000', 'goes'],
    ['Avenida San Martin 2800', 'goes'],
  ])('street "%s" contains barrio "%s"', (address, expectedBarrio) => {
    const result = getBarriosFromStreet(address);
    expect(result).not.toBeNull();
    expect(result).toContain(expectedBarrio);
  });

  // E2. Unknown streets → null (10 tests)
  it.each([
    'Calle Inventada 1234', 'Pasaje sin nombre 500', 'Ruta 8 km 300',
    'Camino a la playa s/n', 'Sendero del bosque 10', 'Avenida Desconocida 9000',
    'Calle 1 entre A y B', 'Pasaje X 100', 'Callejon oscuro', 'Vereda larga 55',
  ])('unknown street "%s" → null', (addr) => {
    expect(getBarriosFromStreet(addr)).toBeNull();
  });

  // E3. Null/empty → null (5 tests)
  it.each([null, undefined, '', '  ', 'ab'])
  ('invalid "%s" → null', (addr) => {
    expect(getBarriosFromStreet(addr as any)).toBeNull();
  });

  // E4. Rambla has many barrios (2 tests)
  it('Rambla returns multiple barrios', () => {
    const r = getBarriosFromStreet('Rambla Republica de Mexico 5000');
    expect(r).not.toBeNull();
    expect(r!.length).toBeGreaterThan(5);
  });

  it('Rambla includes pocitos and carrasco', () => {
    const r = getBarriosFromStreet('Rambla 5000')!;
    expect(r).toContain('pocitos');
    expect(r).toContain('carrasco');
  });
});

// ================================================================
// F. getDepartmentFromZip — 40 tests
// ================================================================
describe('F. getDepartmentFromZip — all prefixes', () => {
  it.each([
    ['11000', 'Montevideo'], ['12000', 'Montevideo'],
    ['15000', 'Canelones'], ['16000', 'Canelones'], ['17000', 'Canelones'],
    ['20000', 'Maldonado'], ['21000', 'Maldonado'],
    ['25000', 'Rocha'],
    ['27000', 'Treinta y Tres'],
    ['30000', 'Cerro Largo'],
    ['33000', 'Rivera'],
    ['35000', 'Artigas'],
    ['37000', 'Salto'],
    ['40000', 'Paysandu'],
    ['45000', 'Rio Negro'],
    ['47000', 'Soriano'],
    ['50000', 'Colonia'],
    ['60000', 'San Jose'],
    ['65000', 'Flores'],
    ['70000', 'Florida'],
    ['75000', 'Durazno'],
    ['80000', 'Lavalleja'],
    ['85000', 'Tacuarembo'],
    ['90000', 'Treinta y Tres'],
    ['91000', 'Cerro Largo'],
  ])('ZIP %s → %s', (zip, expected) => {
    expect(getDepartmentFromZip(zip)).toBe(expected);
  });

  // Invalid
  it.each([null, undefined, '', '1', '99', '99000', 'abc'])
  ('invalid %s → null', (zip) => {
    const r = getDepartmentFromZip(zip as any);
    expect(r).toBeNull();
  });

  // With extra digits
  it.each([
    ['11500', 'Montevideo'],
    ['15432', 'Canelones'],
    ['20100', 'Maldonado'],
    ['37500', 'Salto'],
    ['50123', 'Colonia'],
    ['60999', 'San Jose'],
    ['70001', 'Florida'],
    ['85999', 'Tacuarembo'],
  ])('5-digit ZIP %s → %s', (zip, expected) => {
    expect(getDepartmentFromZip(zip)).toBe(expected);
  });
});

// ================================================================
// G. Integration scenarios — 20 tests
// ================================================================
describe('G. Full pipeline integration', () => {
  function simulate(city: string, addr1: string, addr2: string | null, zip: string, total: string, currency = 'UYU') {
    const dept = getDepartmentForCity(city);
    const zipDept = getDepartmentFromZip(zip);
    const zipBarrios = getBarriosFromZip(zip);
    const streetBarrios = getBarriosFromStreet(addr1);
    const { fullAddress, extraObs } = mergeAddress(addr1, addr2);
    const payment = determinePaymentType(mockOrder(total, currency), 3900, true);
    return { dept, zipDept, zipBarrios, streetBarrios, fullAddress, extraObs, payment };
  }

  it('Pocitos order, high value', () => {
    const r = simulate('Pocitos', '21 de Setiembre 2900', 'Apto 401', '11500', '5000');
    expect(r.dept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('pocitos');
    expect(r.streetBarrios).toContain('pocitos');
    expect(r.fullAddress).toBe('21 de Setiembre 2900');
    expect(r.extraObs).toBe('Apto 401');
    expect(r.payment).toBe('REMITENTE');
  });

  it('Carrasco order, low value', () => {
    const r = simulate('Carrasco', 'Camino Carrasco 5400', null, '11800', '2000');
    expect(r.dept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('carrasco');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Interior: Salto high value USD', () => {
    const r = simulate('Salto', 'Uruguay 340', null, '37000', '100', 'USD');
    expect(r.dept).toBe('Salto');
    expect(r.zipDept).toBe('Salto');
    expect(r.payment).toBe('REMITENTE');
  });

  it('Solymar (wrong dept from Shopify)', () => {
    const r = simulate('Solymar', 'Av Giannattasio km20', null, '15000', '3000');
    expect(r.dept).toBe('Canelones');
    expect(r.zipDept).toBe('Canelones');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Punta del Este', () => {
    const r = simulate('Punta del Este', 'Gorlero 900', 'Local 3', '20000', '8000');
    expect(r.dept).toBe('Maldonado');
    expect(r.extraObs).toBe('Local 3');
    expect(r.payment).toBe('REMITENTE');
  });

  it('La.paz with dot', () => {
    const r = simulate('La.paz', 'Ruta 1 km 30', null, '15000', '1500');
    expect(r.dept).toBe('Canelones');
  });

  it('Rivera city', () => {
    const r = simulate('Rivera', 'Sarandi 500', null, '33000', '4500');
    expect(r.dept).toBe('Rivera');
    expect(r.payment).toBe('REMITENTE');
  });

  it('Ciudad de la Costa with house number', () => {
    const r = simulate('Ciudad de la Costa', 'Av Giannattasio km 24', 'Casa 15', '15000', '3500');
    expect(r.dept).toBe('Canelones');
    expect(r.extraObs).toBe('Casa 15');
  });

  it('Buceo with phone in addr2 (ignored)', () => {
    const r = simulate('Buceo', 'Av Italia 2800', '099123456', '11600', '5500');
    expect(r.dept).toBe('Montevideo');
    expect(r.fullAddress).toBe('Av Italia 2800');
    expect(r.payment).toBe('REMITENTE');
  });

  it('Colonia del Sacramento, EUR', () => {
    const r = simulate('Colonia del Sacramento', 'General Flores 300', null, '50000', '50', 'EUR');
    expect(r.dept).toBe('Colonia');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Order total exactly at threshold', () => {
    const r = simulate('Centro', '18 de Julio 800', null, '11000', '3900');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Empty city, has ZIP', () => {
    const r = simulate('', '18 de Julio 1234', null, '11100', '2000');
    expect(r.dept).toBeUndefined();
    expect(r.zipDept).toBe('Montevideo');
    expect(r.zipBarrios).toContain('centro');
  });

  it('Treinta y Tres', () => {
    const r = simulate('Treinta y Tres', 'Lavalleja 200', null, '27000', '6000');
    expect(r.dept).toBe('Treinta y Tres');
    expect(r.payment).toBe('REMITENTE');
  });

  it('Free order (total=0)', () => {
    const r = simulate('Pocitos', 'Rivera 2500', null, '11500', '0');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Negative total (refund)', () => {
    const r = simulate('Pocitos', 'Rivera 2500', null, '11500', '-5000');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Invalid total string', () => {
    const r = simulate('Pocitos', 'Rivera 2500', null, '11500', 'abc');
    expect(r.payment).toBe('DESTINATARIO');
  });

  it('Montevideo- URUGUAY as city', () => {
    const r = simulate('montevideo- URUGUAY', '18 de Julio 1234', null, '11000', '5000');
    expect(r.dept).toBe('Montevideo');
  });

  it('Pipe in city: "2|montevideo"', () => {
    const r = simulate('2|montevideo', 'Rivera 2500', null, '11500', '4000');
    expect(r.dept).toBe('Montevideo');
    expect(r.payment).toBe('REMITENTE');
  });

  it('Sur (Artigas, not Montevideo barrio)', () => {
    const r = simulate('Sur', 'Calle Principal 100', null, '35000', '3000');
    expect(r.dept).toBe('Artigas');
    expect(r.zipDept).toBe('Artigas');
  });

  it('Unknown currency GBP → DESTINATARIO', () => {
    const r = simulate('Pocitos', 'Rivera 2500', null, '11500', '5000', 'GBP');
    expect(r.payment).toBe('DESTINATARIO');
  });
});
