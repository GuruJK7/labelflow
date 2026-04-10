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
  calculateAICost,
  VALID_DEPARTMENTS,
  VALID_MVD_BARRIOS,
  AIResolverInput,
  TokenUsage,
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

// ───────────────────────────────────────────────────────────────────────────
// calculateAICost — verifies Haiku 4.5 pricing and prompt caching math
// ───────────────────────────────────────────────────────────────────────────

describe('calculateAICost', () => {
  it('computes base cost with no caching (matches Haiku 4.5 pricing)', () => {
    // 1000 input tokens × $1/MTok = $0.001
    // 200 output tokens × $5/MTok = $0.001
    // Total: $0.002
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 200,
    };
    expect(calculateAICost(usage)).toBeCloseTo(0.002, 6);
  });

  it('computes cost with cache_creation tokens (first call in batch)', () => {
    // Simulates the first call in a batch that writes the cache:
    //   - 100 uncached input tokens (user message) × $1/MTok = $0.0001
    //   - 2000 cache_creation tokens × $1.25/MTok = $0.0025
    //   - 150 output tokens × $5/MTok = $0.00075
    // Total: $0.00335
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 150,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 0,
    };
    expect(calculateAICost(usage)).toBeCloseTo(0.00335, 6);
  });

  it('computes cost with cache_read tokens (cached call within 5min)', () => {
    // Simulates subsequent calls that hit the cache:
    //   - 100 uncached input tokens × $1/MTok = $0.0001
    //   - 2000 cache_read tokens × $0.10/MTok = $0.0002
    //   - 150 output tokens × $5/MTok = $0.00075
    // Total: $0.00105 (69% cheaper than first call)
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
    };
    expect(calculateAICost(usage)).toBeCloseTo(0.00105, 6);
  });

  it('cached calls are cheaper than uncached calls', () => {
    // Same prompt, different caching state
    const uncached: TokenUsage = {
      input_tokens: 2100, // full prompt, no cache
      output_tokens: 150,
    };
    const cached: TokenUsage = {
      input_tokens: 100,
      output_tokens: 150,
      cache_read_input_tokens: 2000,
    };
    expect(calculateAICost(cached)).toBeLessThan(calculateAICost(uncached));
  });

  it('cache-read pricing is exactly 10% of base input price', () => {
    // 1M cache_read tokens should equal 10% of the cost of 1M base input tokens
    const baseOnly: TokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    const cachedOnly: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    };
    expect(calculateAICost(cachedOnly)).toBeCloseTo(
      calculateAICost(baseOnly) * 0.1,
      6,
    );
  });

  it('cache-write pricing is exactly 125% of base input price', () => {
    // 1M cache_creation tokens should equal 125% of the cost of 1M base input tokens
    const baseOnly: TokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    const writeOnly: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    };
    expect(calculateAICost(writeOnly)).toBeCloseTo(
      calculateAICost(baseOnly) * 1.25,
      6,
    );
  });

  it('handles zero cache fields (backwards compatible)', () => {
    const noCache: TokenUsage = { input_tokens: 1000, output_tokens: 200 };
    const explicitZero: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    expect(calculateAICost(noCache)).toBe(calculateAICost(explicitZero));
  });

  it('per-call cost for realistic AI resolver payload is around $0.001-$0.004', () => {
    // First call in batch (writes cache)
    const firstCall: TokenUsage = {
      input_tokens: 150, // user message (address data)
      output_tokens: 180, // tool_use response
      cache_creation_input_tokens: 2000, // system + tools
      cache_read_input_tokens: 0,
    };
    const firstCost = calculateAICost(firstCall);
    expect(firstCost).toBeGreaterThan(0.002);
    expect(firstCost).toBeLessThan(0.005);

    // Subsequent call (cache hit)
    const cachedCall: TokenUsage = {
      input_tokens: 150,
      output_tokens: 180,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
    };
    const cachedCost = calculateAICost(cachedCall);
    expect(cachedCost).toBeGreaterThan(0.0008);
    expect(cachedCost).toBeLessThan(0.0025);

    // Cache should save at least 25% vs first call
    expect(cachedCost).toBeLessThan(firstCost * 0.75);
  });

  it('cache savings in a 100-order batch reach at least 55%', () => {
    // Simulate: 1 cache write + 99 cache reads
    // With our token profile (2000 cached + 150 uncached input + 180 output)
    // the realistic savings are ~58% — the output cost is flat and drags the
    // total savings below the per-call input-only savings. 55% is a safe
    // floor that any regression in cache efficiency would trip.
    const firstCall: TokenUsage = {
      input_tokens: 150,
      output_tokens: 180,
      cache_creation_input_tokens: 2000,
    };
    const cachedCall: TokenUsage = {
      input_tokens: 150,
      output_tokens: 180,
      cache_read_input_tokens: 2000,
    };
    const uncachedCall: TokenUsage = {
      input_tokens: 2150, // full prompt
      output_tokens: 180,
    };

    const batchCostWithCache =
      calculateAICost(firstCall) + 99 * calculateAICost(cachedCall);
    const batchCostWithoutCache = 100 * calculateAICost(uncachedCall);

    const savings =
      (batchCostWithoutCache - batchCostWithCache) / batchCostWithoutCache;
    expect(savings).toBeGreaterThan(0.55); // at least 55% savings
  });
});
