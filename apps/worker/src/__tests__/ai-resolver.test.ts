/**
 * Tests for the AI Address Resolver.
 *
 * We test the pure functions (hashing, whitelist contents) without mocking
 * the Anthropic API — the API call itself is tested in integration tests
 * with a real key, not here.
 */

import { describe, it, expect } from 'vitest';
import {
  hashAddressInput,
  VALID_DEPARTMENTS,
  VALID_MVD_BARRIOS,
  AIResolverInput,
} from '../dac/ai-resolver';

describe('hashAddressInput', () => {
  it('produces a 16-char hex string', () => {
    const input: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: '18 de Julio 1234',
    };
    const hash = hashAddressInput(input);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces the same hash for identical inputs', () => {
    const a: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: '18 de Julio 1234',
      zip: '11200',
    };
    const b: AIResolverInput = { ...a };
    expect(hashAddressInput(a)).toBe(hashAddressInput(b));
  });

  it('produces the same hash regardless of case', () => {
    const upper: AIResolverInput = {
      tenantId: 't1',
      city: 'MONTEVIDEO',
      address1: '18 DE JULIO 1234',
    };
    const lower: AIResolverInput = {
      tenantId: 't1',
      city: 'montevideo',
      address1: '18 de julio 1234',
    };
    expect(hashAddressInput(upper)).toBe(hashAddressInput(lower));
  });

  it('produces the same hash regardless of accent marks', () => {
    const accented: AIResolverInput = {
      tenantId: 't1',
      city: 'Peñarol',
      address1: 'Camiño Máldonado 3000',
    };
    const plain: AIResolverInput = {
      tenantId: 't1',
      city: 'Penarol',
      address1: 'Camino Maldonado 3000',
    };
    expect(hashAddressInput(accented)).toBe(hashAddressInput(plain));
  });

  it('produces the same hash regardless of extra whitespace', () => {
    const spaced: AIResolverInput = {
      tenantId: 't1',
      city: '  Montevideo  ',
      address1: '18  de   Julio    1234',
    };
    const normal: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: '18 de Julio 1234',
    };
    expect(hashAddressInput(spaced)).toBe(hashAddressInput(normal));
  });

  it('produces different hashes for different addresses', () => {
    const a: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: '18 de Julio 1234',
    };
    const b: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: '18 de Julio 5678',
    };
    expect(hashAddressInput(a)).not.toBe(hashAddressInput(b));
  });

  it('produces different hashes when ZIP differs', () => {
    const a: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: 'Bulevar Artigas 100',
      zip: '11200',
    };
    const b: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: 'Bulevar Artigas 100',
      zip: '11300',
    };
    expect(hashAddressInput(a)).not.toBe(hashAddressInput(b));
  });

  it('ignores tenantId in hash (cache is namespaced by tenantId separately)', () => {
    const a: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: '18 de Julio 1234',
    };
    const b: AIResolverInput = {
      tenantId: 't2',
      city: 'Montevideo',
      address1: '18 de Julio 1234',
    };
    expect(hashAddressInput(a)).toBe(hashAddressInput(b));
  });

  it('handles empty address2 gracefully (null and undefined match)', () => {
    const withUndefined: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: 'Rivera 4000',
      address2: undefined,
    };
    const withEmpty: AIResolverInput = {
      tenantId: 't1',
      city: 'Montevideo',
      address1: 'Rivera 4000',
      address2: '',
    };
    expect(hashAddressInput(withUndefined)).toBe(hashAddressInput(withEmpty));
  });
});

describe('VALID_DEPARTMENTS', () => {
  it('contains exactly 19 departments', () => {
    expect(VALID_DEPARTMENTS).toHaveLength(19);
  });

  it('contains Montevideo', () => {
    expect(VALID_DEPARTMENTS).toContain('Montevideo');
  });

  it('contains all main Uruguay departments', () => {
    const required = [
      'Montevideo',
      'Canelones',
      'Maldonado',
      'Rocha',
      'Colonia',
      'San Jose',
      'Florida',
      'Durazno',
      'Flores',
      'Lavalleja',
      'Treinta y Tres',
      'Cerro Largo',
      'Rivera',
      'Artigas',
      'Salto',
      'Paysandu',
      'Rio Negro',
      'Soriano',
      'Tacuarembo',
    ];
    for (const dept of required) {
      expect(VALID_DEPARTMENTS).toContain(dept);
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(VALID_DEPARTMENTS);
    expect(unique.size).toBe(VALID_DEPARTMENTS.length);
  });
});

describe('VALID_MVD_BARRIOS', () => {
  it('contains the main Montevideo barrios', () => {
    const required = [
      'pocitos',
      'punta carretas',
      'carrasco',
      'carrasco norte',
      'centro',
      'ciudad vieja',
      'cordon',
      'parque rodo',
      'parque batlle',
      'malvin',
      'buceo',
      'la blanqueada',
      'tres cruces',
      'union',
      'prado',
      'aguada',
      'palermo',
    ];
    for (const barrio of required) {
      expect(VALID_MVD_BARRIOS).toContain(barrio);
    }
  });

  it('all entries are lowercase (matches DAC K_Barrio dropdown keys)', () => {
    for (const barrio of VALID_MVD_BARRIOS) {
      expect(barrio).toBe(barrio.toLowerCase());
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(VALID_MVD_BARRIOS);
    expect(unique.size).toBe(VALID_MVD_BARRIOS.length);
  });

  it('contains at least 50 barrios', () => {
    // Montevideo has 62 official barrios; we track the ones DAC supports in its dropdown
    expect(VALID_MVD_BARRIOS.length).toBeGreaterThanOrEqual(50);
  });
});
