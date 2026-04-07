import { describe, it, expect } from 'vitest';
import { mergeAddress } from '../dac/shipment';

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

  it('does NOT duplicate door number when address2 equals the number already in address1', () => {
    const result = mergeAddress('18 De Julio 705', '705');
    expect(result.fullAddress).toBe('18 De Julio 705');
    expect(result.fullAddress).not.toContain('705 705');
  });

  it('does NOT duplicate when address2 is the last word of address1', () => {
    const result = mergeAddress('San Lorenzo 3247', '3247');
    expect(result.fullAddress).toBe('San Lorenzo 3247');
  });

  // ====== BUG: SLASH APT PATTERN (real case #11029) ======
  // address1="Echevarriarza 3274/801" — the /801 is apartment

  // NOTE: slash detection is done post-merge in createShipment, not in mergeAddress itself

  // ====== BUG: APARTMENT NOT IN OBSERVATIONS (real cases #11022, #11023) ======

  it('puts apartment info (Apto 5B) in BOTH address and observations', () => {
    const result = mergeAddress('Río Negro 1323', 'Apto 5B');
    expect(result.fullAddress).toBe('Río Negro 1323 Apto 5B');
    expect(result.extraObs).toBe('Apto 5B');
  });

  it('puts "Piso 3" in both address and observations', () => {
    const result = mergeAddress('Av Italia 500', 'Piso 3');
    expect(result.fullAddress).toBe('Av Italia 500 Piso 3');
    expect(result.extraObs).toBe('Piso 3');
  });

  it('puts "Depto 2A" in both address and observations', () => {
    const result = mergeAddress('Colonia 1234', 'Depto 2A');
    expect(result.fullAddress).toBe('Colonia 1234 Depto 2A');
    expect(result.extraObs).toBe('Depto 2A');
  });

  it('puts "Apt 10" in both address and observations', () => {
    const result = mergeAddress('Scoseria 2459', 'Apt 10');
    expect(result.fullAddress).toBe('Scoseria 2459 Apt 10');
    expect(result.extraObs).toBe('Apt 10');
  });

  it('puts "Torre 2 Apto 5" in both address and observations', () => {
    const result = mergeAddress('Av Brasil 2500', 'Torre 2 Apto 5');
    // starts with "torre" so matches aptPattern
    expect(result.fullAddress).toContain('Torre 2');
    expect(result.extraObs).toContain('Torre');
  });

  // ====== BUG: COMBINED DOOR+APT (e.g., "1502B") ======

  it('separates "1502B" into door and apt with observations', () => {
    const result = mergeAddress('Av Rivera', '1502B');
    expect(result.fullAddress).toBe('Av Rivera 1502 B');
    expect(result.extraObs).toBe('Apto B');
  });

  it('separates "304A" into door and apt', () => {
    const result = mergeAddress('Canelones 1234', '304A');
    expect(result.fullAddress).toBe('Canelones 1234 304 A');
    expect(result.extraObs).toBe('Apto A');
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
    // Non-standard address continuation — should go to both
    const result = mergeAddress('Andres y Yegros', 'Complejo América. Senda 4');
    expect(result.fullAddress).toContain('Andres y Yegros');
    expect(result.fullAddress).toContain('Complejo');
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
    expect(result.fullAddress.trim()).toBe('Apto 5');
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
    expect(result.fullAddress).toContain('puerta 3');
    expect(result.extraObs).toContain('puerta');
  });

  it('handles "local" keyword', () => {
    const result = mergeAddress('18 de Julio 1000', 'local 5');
    expect(result.fullAddress).toContain('local 5');
    expect(result.extraObs).toContain('local');
  });

  it('handles "oficina" keyword', () => {
    const result = mergeAddress('Plaza Independencia 800', 'oficina 302');
    expect(result.fullAddress).toContain('oficina 302');
    expect(result.extraObs).toContain('oficina');
  });
});
