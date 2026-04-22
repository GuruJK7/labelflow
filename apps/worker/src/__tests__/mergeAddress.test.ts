import { describe, it, expect } from 'vitest';
import { mergeAddress, maybeSwapSwappedFields } from '../dac/shipment';

describe('mergeAddress', () => {
  // ====== BASIC CASES ======

  it('returns address1 when address2 is empty', () => {
    expect(mergeAddress('18 De Julio 705', '')).toEqual({
      fullAddress: '18 De Julio 705',
      extraObs: '',
    });
  });

  it('returns address1 when address2 is null', () => {
    expect(mergeAddress('Av Italia 500', null)).toEqual({
      fullAddress: 'Av Italia 500',
      extraObs: '',
    });
  });

  it('returns address1 when address2 is undefined', () => {
    expect(mergeAddress('Av Italia 500', undefined)).toEqual({
      fullAddress: 'Av Italia 500',
      extraObs: '',
    });
  });

  // ====== BUG: DUPLICATE DOOR NUMBER (real case #11019) ======
  // address1="18 De Julio 705", address2="705" → was producing "18 De Julio 705 705"
  // v3 (2026-04-10): also verify the obs is empty (705 is door, not apt — see
  // isLikelyAptNumber heuristic)

  it('does NOT duplicate door number when address2 equals the number already in address1', () => {
    const result = mergeAddress('18 De Julio 705', '705');
    expect(result.fullAddress).toBe('18 De Julio 705');
    expect(result.fullAddress).not.toContain('705 705');
    // 705 is 3 digits no leading zero → ambiguous → treated as duplicate door, not apt
    expect(result.extraObs).toBe('');
  });

  it('does NOT duplicate when address2 is the last word of address1', () => {
    const result = mergeAddress('San Lorenzo 3247', '3247');
    expect(result.fullAddress).toBe('San Lorenzo 3247');
  });

  // ====== BUG: SLASH APT PATTERN (real case #11029) ======
  // address1="Echevarriarza 3274/801" — the /801 is apartment

  // NOTE: slash detection is done post-merge in createShipment, not in mergeAddress itself

  // ====== BUG: APARTMENT NOT IN OBSERVATIONS (real cases #11022, #11023) ======

  it('puts apartment info (Apto 5B) in observations only', () => {
    const result = mergeAddress('Río Negro 1323', 'Apto 5B');
    expect(result.fullAddress).toBe('Río Negro 1323');
    expect(result.extraObs).toBe('Apto 5B');
  });

  it('puts "Piso 3" in observations only', () => {
    const result = mergeAddress('Av Italia 500', 'Piso 3');
    expect(result.fullAddress).toBe('Av Italia 500');
    expect(result.extraObs).toBe('Piso 3');
  });

  it('puts "Depto 2A" in observations only', () => {
    const result = mergeAddress('Colonia 1234', 'Depto 2A');
    expect(result.fullAddress).toBe('Colonia 1234');
    expect(result.extraObs).toBe('Depto 2A');
  });

  it('puts "Apt 10" in observations only', () => {
    const result = mergeAddress('Scoseria 2459', 'Apt 10');
    expect(result.fullAddress).toBe('Scoseria 2459');
    expect(result.extraObs).toBe('Apt 10');
  });

  it('puts "Torre 2 Apto 5" in observations only', () => {
    const result = mergeAddress('Av Brasil 2500', 'Torre 2 Apto 5');
    expect(result.fullAddress).toBe('Av Brasil 2500');
    expect(result.extraObs).toBe('Torre 2 Apto 5');
  });

  // ====== BUG: COMBINED DOOR+APT (e.g., "1502B") ======

  it('separates "1502B" into door and apt with observations', () => {
    const result = mergeAddress('Av Rivera', '1502B');
    expect(result.fullAddress).toBe('Av Rivera 1502');
    expect(result.extraObs).toBe('Apto B');
  });

  it('separates "304A" — address1 already has number, so all goes to obs', () => {
    const result = mergeAddress('Canelones 1234', '304A');
    expect(result.fullAddress).toBe('Canelones 1234');
    expect(result.extraObs).toBe('Apto 304A');
  });

  // ====== PURE DOOR NUMBER ======

  it('appends pure door number when address1 has no number at end', () => {
    const result = mergeAddress('Av Italia', '500');
    expect(result.fullAddress).toBe('Av Italia 500');
    expect(result.extraObs).toBe('');
  });

  it('treats address2 as apartment when address1 already has a door number', () => {
    // address1="Salto 1032", address2="4" → "4" is apartment, not another door
    const result = mergeAddress('Salto 1032', '4');
    expect(result.fullAddress).toContain('1032');
    expect(result.extraObs).toContain('Apto 4');
  });

  it('treats address2 as apartment when address1 ends with number', () => {
    // address1="Demostenes 3481", address2="801" → apt 801
    const result = mergeAddress('Demostenes 3481', '801');
    expect(result.fullAddress).toContain('3481');
    expect(result.extraObs).toContain('Apto 801');
  });

  // ====== DIRECTION REFERENCES ======

  it('appends direction reference without observations', () => {
    const result = mergeAddress('18 de Julio 2000', 'esquina Convención');
    expect(result.fullAddress).toBe('18 de Julio 2000 esquina Convención');
    expect(result.extraObs).toBe('');
  });

  it('handles "entre X y Y"', () => {
    const result = mergeAddress('Colonia 1234', 'entre Yi y Ejido');
    expect(result.fullAddress).toBe('Colonia 1234 entre Yi y Ejido');
    expect(result.extraObs).toBe('');
  });

  // ====== COMPLEX REAL-WORLD CASES ======

  it('handles "Complejo América. Senda 4" in address2 (real case #11027)', () => {
    // Non-standard address continuation — goes to extraObs only
    const result = mergeAddress('Andres y Yegros', 'Complejo América. Senda 4');
    expect(result.fullAddress).toBe('Andres y Yegros');
    expect(result.extraObs).toContain('Complejo');
  });

  it('handles address2 as different door number (real case #11035)', () => {
    // address1="José Bonaparte 3179", address2="3171" — different door number
    // This is ambiguous but since address1 already has a number, treat as apt
    const result = mergeAddress('José Bonaparte 3179', '3171');
    expect(result.extraObs).toContain('3171');
  });

  // ====== EDGE CASES ======

  it('handles empty address1', () => {
    const result = mergeAddress('', 'Apto 5');
    expect(result.fullAddress).toBe('');
    expect(result.extraObs).toBe('Apto 5');
  });

  it('handles both empty', () => {
    const result = mergeAddress('', '');
    expect(result.fullAddress).toBe('');
    expect(result.extraObs).toBe('');
  });

  it('handles "bis" suffix', () => {
    const result = mergeAddress('Colonia 1234', '1234 bis');
    expect(result.fullAddress).toContain('bis');
  });

  it('handles "puerta" keyword', () => {
    const result = mergeAddress('Av Brasil 2500', 'puerta 3');
    expect(result.fullAddress).toBe('Av Brasil 2500');
    expect(result.extraObs).toBe('puerta 3');
  });

  it('handles "local" keyword', () => {
    const result = mergeAddress('18 de Julio 1000', 'local 5');
    expect(result.fullAddress).toBe('18 de Julio 1000');
    expect(result.extraObs).toBe('local 5');
  });

  it('handles "oficina" keyword', () => {
    const result = mergeAddress('Plaza Independencia 800', 'oficina 302');
    expect(result.fullAddress).toBe('Plaza Independencia 800');
    expect(result.extraObs).toBe('oficina 302');
  });

  // ====== PHONE NUMBER FILTERING ======

  it('filters out phone number "099680230" from address2', () => {
    const result = mergeAddress('Canelones 1450', '099680230');
    expect(result.fullAddress).toBe('Canelones 1450');
    expect(result.extraObs).toBe('');
  });

  it('filters out phone number "09X" pattern', () => {
    const result = mergeAddress('Av Italia 3000', '091234567');
    expect(result.fullAddress).toBe('Av Italia 3000');
    expect(result.extraObs).toBe('');
  });

  it('filters out phone number with country code', () => {
    const result = mergeAddress('Colonia 1234', '+59899123456');
    expect(result.fullAddress).toBe('Colonia 1234');
    expect(result.extraObs).toBe('');
  });

  // ====== CITY/DEPARTMENT FILTERING ======

  it('filters out "Montevideo" as city name in address2', () => {
    const result = mergeAddress('Luis Bonavita 1266 WTC', 'Montevideo');
    expect(result.fullAddress).toBe('Luis Bonavita 1266 WTC');
    expect(result.extraObs).toBe('');
  });

  it('filters out "Canelones" as department name', () => {
    const result = mergeAddress('Ruta 8 km 30', 'Canelones');
    expect(result.fullAddress).toBe('Ruta 8 km 30');
    expect(result.extraObs).toBe('');
  });

  it('filters out "Pocitos" as barrio name', () => {
    const result = mergeAddress('Dr Puyol 1687', 'Pocitos');
    expect(result.fullAddress).toBe('Dr Puyol 1687');
    expect(result.extraObs).toBe('');
  });

  it('does NOT filter real address that happens to contain city name', () => {
    const result = mergeAddress('Av Rivera', 'Apto 5 Montevideo 1234');
    expect(result.fullAddress).toBe('Av Rivera');
    expect(result.extraObs).toBe('Apto 5 Montevideo 1234');
  });

  // ====== v4 FIELD SWAP DETECTION (2026-04-22 post-run audit) ======
  // Real case: order #11480 Mariana Gestal. Customer typed the delivery
  // observation in address1 and the real street in address2.

  it('detects swapped fields: observation in address1, street in address2', () => {
    const result = mergeAddress(
      'Portón De Garaje Gris(contenedor De Basura En La Puerta)',
      'Dolores Pereira De Rosell 1474',
    );
    expect(result.fullAddress).toBe('Dolores Pereira De Rosell 1474');
    expect(result.extraObs).toBe(
      'Portón De Garaje Gris(contenedor De Basura En La Puerta)',
    );
  });

  it('does NOT swap when address1 has a digit (normal case)', () => {
    // address1 has a number → assumed to be a real street, no swap
    const result = mergeAddress('Av Italia 500', 'Portón gris con rejas negras');
    expect(result.fullAddress).toBe('Av Italia 500');
    expect(result.extraObs).toBe('Portón gris con rejas negras');
  });

  it('does NOT swap short no-digit address1 (<3 words) — preserves existing Av Rivera case', () => {
    // "Av Rivera" = 2 alpha words < 3 → not enough to trust as observation.
    // Matches the existing "real address that contains city" contract above.
    const swap = maybeSwapSwappedFields('Av Rivera', 'Apto 5 Montevideo 1234');
    expect(swap.swapped).toBe(false);
  });

  it('does NOT swap when address2 has no digit', () => {
    const swap = maybeSwapSwappedFields(
      'Portón negro con rejas altas de hierro',
      'Pocitos',
    );
    expect(swap.swapped).toBe(false);
  });

  it('does NOT swap when address2 is a bare phone number', () => {
    // address2 has digits but no alpha words → 2-word alpha requirement fails.
    const swap = maybeSwapSwappedFields(
      'Portón rojo con cerco blanco muy alto',
      '099123456',
    );
    expect(swap.swapped).toBe(false);
  });

  it('does NOT swap when either field is empty', () => {
    expect(maybeSwapSwappedFields('', 'Dolores Pereira 1474').swapped).toBe(false);
    expect(maybeSwapSwappedFields('Portón gris grande largo', '').swapped).toBe(false);
    expect(maybeSwapSwappedFields('', '').swapped).toBe(false);
  });

  it('swap exposes correctedAddress1/2 for logging', () => {
    const swap = maybeSwapSwappedFields(
      'Casa verde con timbre a la derecha del portón',
      'Av Italia 1234',
    );
    expect(swap.swapped).toBe(true);
    expect(swap.address1).toBe('Av Italia 1234');
    expect(swap.address2).toBe(
      'Casa verde con timbre a la derecha del portón',
    );
  });
});
