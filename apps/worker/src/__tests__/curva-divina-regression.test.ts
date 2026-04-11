/**
 * Regression tests for the 8 bugs found during the Curva Divina (Luciano Uraga)
 * historical replay on 2026-04-10.
 *
 * Each test corresponds to a real Shopify order from the Curva Divina store
 * that exhibited a specific mergeAddress bug. The test name includes the order
 * number, customer name, and short bug description so failures are easy to
 * trace back to the original report.
 *
 * The user reported these bugs in chat with the wording:
 *   #11084 — apt left in address instead of obs
 *   #11085 — wrong zone, delivery hours not in obs
 *   #11087 — long clarification cut because not in obs
 *   #11090 — "retiro en dac maldonado" used as address (should go to agencia)
 *   #11091 — apt not in obs, wrong zone
 *   #11094 — clarifications not in obs, wrong zone
 *   #11095 — clarifications not in obs, wrong zone
 *   #11098 — no clarifications, no apt, no zone
 *   #11104 — wrong zone, apt not in obs
 *   #11107 — wrong zone, apt not in obs
 *   #11108 — wrong zone, wrong address, no obs
 *   #11109 — wrong zone
 *   #11110 — wrong zone
 *   #11111 — didn't create label, used another order's
 *   #11117 — obs ok but wrong zone
 *   #11119 — label ok but not put in shopify
 *   #11120 — wrong zone (and trailing apt number not stripped)
 *   #11121 — door number incorrectly extracted as apt
 *   #11125/#11126 — consecutive orders should consolidate to REMITENTE
 *
 * The audit on 2026-04-10 confirmed that 8 of these still had wrong behavior
 * AFTER all the previous fixes. This file pins down the v3 mergeAddress fixes
 * (postProcessAddress + isLikelyAptNumber + slash apt detection) to prevent
 * regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeAddress,
  stripTrailingAptPattern,
  stripTrailingPorteriaPattern,
  stripTrailingKnownPlaces,
  isAddress2DuplicateOfDoor,
  isLikelyAptNumber,
  postProcessAddress,
} from '../dac/shipment';

// ──────────────────────────────────────────────────────────────────────────
// Helper unit tests for the new functions in isolation
// ──────────────────────────────────────────────────────────────────────────

describe('stripTrailingAptPattern', () => {
  it('strips ", apto X" from end of address', () => {
    expect(stripTrailingAptPattern('Antonio bachini 7122, apto 110')).toEqual({
      cleaned: 'Antonio bachini 7122',
      apt: 'Apto 110',
    });
  });

  it('strips " Apto X" from end of address', () => {
    expect(stripTrailingAptPattern('Oviedo 4795 Apto 1202')).toEqual({
      cleaned: 'Oviedo 4795',
      apt: 'Apto 1202',
    });
  });

  it('strips alphanumeric apt values', () => {
    expect(stripTrailingAptPattern('Calle X 100 apt 5B')).toEqual({
      cleaned: 'Calle X 100',
      apt: 'Apto 5B',
    });
  });

  it('strips dpto/depto variants', () => {
    expect(stripTrailingAptPattern('Calle X 100 dpto 304')).toEqual({
      cleaned: 'Calle X 100',
      apt: 'Apto 304',
    });
    expect(stripTrailingAptPattern('Calle X 100 depto 304')).toEqual({
      cleaned: 'Calle X 100',
      apt: 'Apto 304',
    });
  });

  it('strips apartamento (full word)', () => {
    expect(stripTrailingAptPattern('Calle X 100 apartamento 7')).toEqual({
      cleaned: 'Calle X 100',
      apt: 'Apto 7',
    });
  });

  it('does NOT strip if no apt pattern at end', () => {
    expect(stripTrailingAptPattern('18 De Julio 705')).toEqual({
      cleaned: '18 De Julio 705',
      apt: '',
    });
  });

  it('does NOT strip "ap" appearing inside a word like "playa"', () => {
    expect(stripTrailingAptPattern('Calle Playa 1234')).toEqual({
      cleaned: 'Calle Playa 1234',
      apt: '',
    });
  });
});

describe('stripTrailingPorteriaPattern', () => {
  it('strips trailing "Porteria X"', () => {
    expect(stripTrailingPorteriaPattern('Isidoro De Maria 410 Porteria 410')).toEqual({
      cleaned: 'Isidoro De Maria 410',
      porteria: 'Porteria 410',
    });
  });

  it('strips Spanish accented "Portería"', () => {
    expect(stripTrailingPorteriaPattern('Calle X 100 Portería 5')).toEqual({
      cleaned: 'Calle X 100',
      porteria: 'Porteria 5',
    });
  });

  it('does NOT strip if no porteria pattern', () => {
    expect(stripTrailingPorteriaPattern('Calle X 100')).toEqual({
      cleaned: 'Calle X 100',
      porteria: '',
    });
  });
});

describe('stripTrailingKnownPlaces', () => {
  it('strips trailing ", el pinar, ciudad de la costa"', () => {
    expect(stripTrailingKnownPlaces('Guenoas, manzana L6, solar 8, El Pinar, ciudad de la costa'))
      .toBe('Guenoas, manzana L6, solar 8');
  });

  it('strips a single trailing known place', () => {
    expect(stripTrailingKnownPlaces('Calle X 100, montevideo')).toBe('Calle X 100');
  });

  it('does NOT strip if last segment is not a known place', () => {
    expect(stripTrailingKnownPlaces('Calle X 100, casa amarilla')).toBe('Calle X 100, casa amarilla');
  });

  it('handles addresses without commas', () => {
    expect(stripTrailingKnownPlaces('Calle X 100')).toBe('Calle X 100');
  });
});

describe('isAddress2DuplicateOfDoor', () => {
  it('returns true when address1 has exactly one number that matches address2', () => {
    expect(isAddress2DuplicateOfDoor('Cuató 3117', '3117')).toBe(true);
  });

  it('returns false when address1 has two numbers (one matches address2)', () => {
    // 18 De Julio has TWO numbers (18 and 705), so not a single-number duplicate
    expect(isAddress2DuplicateOfDoor('18 De Julio 705', '705')).toBe(false);
  });

  it('returns false when address2 is not a bare number', () => {
    expect(isAddress2DuplicateOfDoor('Cuató 3117', 'Apto 5')).toBe(false);
  });

  it('returns false when numbers do not match', () => {
    expect(isAddress2DuplicateOfDoor('Cuató 3117', '5')).toBe(false);
  });
});

describe('isLikelyAptNumber', () => {
  it('returns true for leading-zero numbers (002, 012, 005)', () => {
    expect(isLikelyAptNumber('002')).toBe(true);
    expect(isLikelyAptNumber('012')).toBe(true);
    expect(isLikelyAptNumber('005')).toBe(true);
  });

  it('returns true for 1-2 digit numbers', () => {
    expect(isLikelyAptNumber('1')).toBe(true);
    expect(isLikelyAptNumber('5')).toBe(true);
    expect(isLikelyAptNumber('12')).toBe(true);
    expect(isLikelyAptNumber('99')).toBe(true);
  });

  it('returns false for ambiguous 3+ digit numbers without leading zero', () => {
    expect(isLikelyAptNumber('100')).toBe(false);
    expect(isLikelyAptNumber('705')).toBe(false);
    expect(isLikelyAptNumber('1234')).toBe(false);
  });

  it('returns false for non-numeric strings', () => {
    expect(isLikelyAptNumber('Apto 5')).toBe(false);
    expect(isLikelyAptNumber('5B')).toBe(false);
  });
});

describe('postProcessAddress', () => {
  it('is idempotent (applying twice gives same result)', () => {
    const r1 = postProcessAddress('Calle X 100', 'Apto 5');
    const r2 = postProcessAddress(r1.fullAddress, r1.extraObs);
    expect(r1).toEqual(r2);
  });

  it('does not duplicate apt info when extraObs already has it', () => {
    const r = postProcessAddress('Oviedo 4795 Apto 1202', 'Apto 1202');
    expect(r.fullAddress).toBe('Oviedo 4795');
    expect(r.extraObs).toBe('Apto 1202'); // not "Apto 1202 | Apto 1202"
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Real-world regression tests — one per Curva Divina order
// ──────────────────────────────────────────────────────────────────────────

describe('Curva Divina regression — real Shopify orders that previously had bugs', () => {
  it('#11084 Macarena Pineiro — "Batlle y ordoñez 1607" + "303 apto" → apt extracted to obs', () => {
    const r = mergeAddress('Batlle y ordoñez 1607', '303 apto');
    expect(r.fullAddress).toBe('Batlle y ordoñez 1607');
    expect(r.extraObs).toContain('303');
  });

  it('#11085 Denisse Hartwig — "Luis a de Herrera 1183/204" + "Lunes a viernes 9-16" → split slash + hours in obs', () => {
    const r = mergeAddress('Luis a de Herrera 1183/204', 'Lunes a viernes 9-16');
    expect(r.fullAddress).toBe('Luis a de Herrera 1183');
    expect(r.extraObs).toContain('Apto 204');
    expect(r.extraObs).toContain('Lunes a viernes 9-16');
  });

  it('#11087 Ada Reyes — long address with embedded city/dept → strip city/dept, keep clarifications', () => {
    const r = mergeAddress(
      'Guenoas, manzana L6, solar 8, El Pinar, ciudad de la costa',
      'Casa con cerco de polines, pegada al almacen',
    );
    expect(r.fullAddress).toBe('Guenoas, manzana L6, solar 8');
    expect(r.extraObs).toBe('Casa con cerco de polines, pegada al almacen');
  });

  it('#11091 Valentina Selios — "Rambla República de Chile 4427" + "504" → apt extracted (504 is short)', () => {
    const r = mergeAddress('Rambla República de Chile 4427', '504');
    expect(r.fullAddress).toBe('Rambla República de Chile 4427');
    expect(r.extraObs).toBe('Apto 504');
  });

  it('#11094 Karina Tovaglearo — "Colonia 834" + "oficina 1209 dejar en porteria" → clarifications in obs', () => {
    const r = mergeAddress('Colonia 834', 'oficina 1209 dejar en porteria');
    expect(r.fullAddress).toBe('Colonia 834');
    expect(r.extraObs).toContain('oficina');
    expect(r.extraObs).toContain('porteria');
  });

  it('#11095 Margarita Cordoba — "Oviedo 4795 Apto 1202" + "1202" → strip apt from address1, keep in obs', () => {
    const r = mergeAddress('Oviedo 4795 Apto 1202', '1202');
    expect(r.fullAddress).toBe('Oviedo 4795');
    expect(r.extraObs).toBe('Apto 1202');
  });

  it('#11098 Maité Larroca — "Doctor José Scosería 2565" + long instructions → all in obs', () => {
    const r = mergeAddress(
      'Doctor José Scosería 2565',
      '804. Dejar en portería con Foxys por favor! :)',
    );
    expect(r.fullAddress).toBe('Doctor José Scosería 2565');
    expect(r.extraObs).toContain('804');
    expect(r.extraObs).toContain('Dejar en portería');
  });

  it('#11104 Valeria Donadío — "Isidoro De Maria 410 Porteria 410" + "410 porteria" → strip Porteria 410 from addr, put in obs', () => {
    const r = mergeAddress('Isidoro De Maria 410 Porteria 410', '410 porteria');
    expect(r.fullAddress).toBe('Isidoro De Maria 410');
    expect(r.extraObs).toContain('Porteria');
  });

  it('#11107 Florencia Polcaro — "Antonio bachini 7122, apto 110" + "110" → strip apto 110 from address1', () => {
    const r = mergeAddress('Antonio bachini 7122, apto 110', '110');
    expect(r.fullAddress).toBe('Antonio bachini 7122');
    expect(r.extraObs).toBe('Apto 110');
  });

  it('#11108 Gulma Silva — "Vitoria  150" + "202 A" → apt 202 A in obs', () => {
    const r = mergeAddress('Vitoria  150', '202 A');
    expect(r.fullAddress.replace(/\s+/g, ' ').trim()).toBe('Vitoria 150');
    expect(r.extraObs).toContain('202 A');
  });

  it('#11109 Valeria Bartaburu — "Garibaldi 1814" + "" → clean address, no obs', () => {
    const r = mergeAddress('Garibaldi 1814', '');
    expect(r.fullAddress).toBe('Garibaldi 1814');
    expect(r.extraObs).toBe('');
  });

  it('#11110 Adriana Alvarez — "Galvani 4821" + "Casa" → "Casa" in obs only', () => {
    const r = mergeAddress('Galvani 4821', 'Casa');
    expect(r.fullAddress).toBe('Galvani 4821');
    expect(r.extraObs).toBe('Casa');
  });

  it('#11111 Marcela Romero — "Bulevar España 2729" + "Apto 601" → apt in obs', () => {
    const r = mergeAddress('Bulevar España 2729', 'Apto 601');
    expect(r.fullAddress).toBe('Bulevar España 2729');
    expect(r.extraObs).toBe('Apto 601');
  });

  it('#11117 Edgardo Miranda — "Av. Libertador 1748" + "Valparaiso" → cross street in obs', () => {
    const r = mergeAddress('Av. Libertador 1748', 'Valparaiso');
    expect(r.fullAddress).toBe('Av. Libertador 1748');
    expect(r.extraObs).toBe('Valparaiso');
  });

  it('#11119 Maria Dinegri — "Formoso 1118" + "Formoso 1118" → dedup, no obs', () => {
    const r = mergeAddress('Formoso 1118', 'Formoso 1118');
    expect(r.fullAddress).toBe('Formoso 1118');
    expect(r.extraObs).toBe('');
  });

  it('#11120 Silvia Napoli — "Rbla. República de Chile 4507 002" + "002" → strip 002 from address (leading zero = apt)', () => {
    const r = mergeAddress('Rbla. República de Chile 4507 002', '002');
    expect(r.fullAddress).toBe('Rbla. República de Chile 4507');
    expect(r.extraObs).toBe('Apto 002');
  });

  it('#11121 Mariana Patrón — "Cuató 3117" + "3117" → 3117 is door, NOT extracted as apt (single-number duplicate)', () => {
    const r = mergeAddress('Cuató 3117', '3117');
    expect(r.fullAddress).toBe('Cuató 3117');
    expect(r.extraObs).toBe(''); // critical: NOT "Apto 3117"
  });

  it('#11125 SILVIA NOBLE (consecutive 1/2) — "Ubaldina Maurente" + "Maldonado" → city stripped from address2', () => {
    const r = mergeAddress('Ubaldina Maurente', 'Maldonado');
    expect(r.fullAddress).toBe('Ubaldina Maurente');
    expect(r.extraObs).toBe('');
  });

  it('#11126 SILVIA NOBLE (consecutive 2/2) — same as #11125', () => {
    const r = mergeAddress('Ubaldina Maurente', 'Maldonado');
    expect(r.fullAddress).toBe('Ubaldina Maurente');
    expect(r.extraObs).toBe('');
  });
});
