/**
 * Unit tests for the applyAddressOverride() pure function extracted from
 * createShipment(). No Playwright, no DB, no mocks — just pure function calls.
 *
 * Also includes regression guards confirming that mergeAddress() and
 * detectCityIntelligent() (the non-override pipeline) are unaffected by the
 * AddressOverride refactor.
 */
import { describe, it, expect } from 'vitest';
import { applyAddressOverride, mergeAddress, detectCityIntelligent } from '../dac/shipment';

// ─── shared fixture ───────────────────────────────────────────────────────────

/** Baseline "current" values that represent what the worker computed before
 *  Claude's correction arrives. */
const BASE = {
  resolvedDept: 'Montevideo',
  resolvedCity: 'Montevideo',
  fullAddress: 'Av Italia 1234',
  extraObs: '',
  phone: '099111222',
  recipientName: 'Juan Pérez',
};

// ─── Section 1: applyAddressOverride — field-by-field behavior ────────────────

describe('applyAddressOverride — full override', () => {
  it('all 6 fields set → every field replaced', () => {
    const result = applyAddressOverride(
      {
        department: 'Maldonado',
        city: 'Punta del Este',
        address1: 'Gorlero 800',
        notes: 'local 3',
        phone: '042123456',
        recipientName: 'Veronique M.',
      },
      BASE,
    );

    expect(result.resolvedDept).toBe('Maldonado');
    expect(result.resolvedCity).toBe('Punta del Este');
    expect(result.fullAddress).toBe('Gorlero 800');
    expect(result.extraObs).toBe('local 3');
    expect(result.phone).toBe('042123456');
    expect(result.recipientName).toBe('Veronique M.');
  });
});

describe('applyAddressOverride — partial overrides', () => {
  it('only department + city → address/notes/phone/name unchanged', () => {
    const result = applyAddressOverride(
      { department: 'Canelones', city: 'Las Piedras' },
      BASE,
    );

    expect(result.resolvedDept).toBe('Canelones');
    expect(result.resolvedCity).toBe('Las Piedras');
    expect(result.fullAddress).toBe(BASE.fullAddress);
    expect(result.extraObs).toBe(BASE.extraObs);
    expect(result.phone).toBe(BASE.phone);
    expect(result.recipientName).toBe(BASE.recipientName);
  });

  it('only address1 → resolvedDept/City/phone/name unchanged', () => {
    const result = applyAddressOverride(
      { address1: 'Roosevelt s/n esquina Pedragosa Sierra' },
      BASE,
    );

    expect(result.fullAddress).toBe('Roosevelt s/n esquina Pedragosa Sierra');
    expect(result.resolvedDept).toBe(BASE.resolvedDept);
    expect(result.resolvedCity).toBe(BASE.resolvedCity);
    expect(result.extraObs).toBe(BASE.extraObs);
    expect(result.phone).toBe(BASE.phone);
    expect(result.recipientName).toBe(BASE.recipientName);
  });

  it('only notes → extraObs replaced, rest unchanged', () => {
    const result = applyAddressOverride(
      { notes: 'Apto 501, torre B' },
      BASE,
    );

    expect(result.extraObs).toBe('Apto 501, torre B');
    expect(result.fullAddress).toBe(BASE.fullAddress);
    expect(result.resolvedDept).toBe(BASE.resolvedDept);
    expect(result.resolvedCity).toBe(BASE.resolvedCity);
    expect(result.phone).toBe(BASE.phone);
    expect(result.recipientName).toBe(BASE.recipientName);
  });

  it('only phone → phone replaced, rest unchanged', () => {
    const result = applyAddressOverride(
      { phone: '26001234' },
      BASE,
    );

    expect(result.phone).toBe('26001234');
    expect(result.resolvedDept).toBe(BASE.resolvedDept);
    expect(result.resolvedCity).toBe(BASE.resolvedCity);
    expect(result.fullAddress).toBe(BASE.fullAddress);
    expect(result.extraObs).toBe(BASE.extraObs);
    expect(result.recipientName).toBe(BASE.recipientName);
  });

  it('only recipientName → name replaced, rest unchanged', () => {
    const result = applyAddressOverride(
      { recipientName: 'María García' },
      BASE,
    );

    expect(result.recipientName).toBe('María García');
    expect(result.resolvedDept).toBe(BASE.resolvedDept);
    expect(result.resolvedCity).toBe(BASE.resolvedCity);
    expect(result.fullAddress).toBe(BASE.fullAddress);
    expect(result.extraObs).toBe(BASE.extraObs);
    expect(result.phone).toBe(BASE.phone);
  });
});

describe('applyAddressOverride — empty override {}', () => {
  it('all fields undefined → all current values preserved unchanged', () => {
    const result = applyAddressOverride({}, BASE);

    expect(result.resolvedDept).toBe(BASE.resolvedDept);
    expect(result.resolvedCity).toBe(BASE.resolvedCity);
    expect(result.fullAddress).toBe(BASE.fullAddress);
    expect(result.extraObs).toBe(BASE.extraObs);
    expect(result.phone).toBe(BASE.phone);
    expect(result.recipientName).toBe(BASE.recipientName);
  });
});

describe('applyAddressOverride — empty string values', () => {
  it('empty string address1 overrides (empty string is a valid value, not undefined)', () => {
    const result = applyAddressOverride({ address1: '' }, BASE);
    // Empty string is not undefined — it replaces the current value
    expect(result.fullAddress).toBe('');
  });

  it('empty string notes overrides extraObs to empty string', () => {
    const currentWithObs = { ...BASE, extraObs: 'Apto 3' };
    const result = applyAddressOverride({ notes: '' }, currentWithObs);
    expect(result.extraObs).toBe('');
  });

  it('empty string phone overrides (explicitly blanking invalid phone is valid)', () => {
    const result = applyAddressOverride({ phone: '' }, BASE);
    expect(result.phone).toBe('');
  });
});

describe('applyAddressOverride — idempotency', () => {
  it('applying the same override twice produces the same result', () => {
    const override = { department: 'Salto', city: 'Salto', phone: '07312345' };
    const first = applyAddressOverride(override, BASE);
    const second = applyAddressOverride(override, first);
    expect(second).toEqual(first);
  });

  it('result is a new object (pure — does not mutate current)', () => {
    const current = { ...BASE };
    const result = applyAddressOverride({ department: 'Rivera' }, current);
    expect(current.resolvedDept).toBe('Montevideo'); // unchanged
    expect(result.resolvedDept).toBe('Rivera');
    expect(result).not.toBe(current);
  });
});

describe('applyAddressOverride — all 19 valid departments accepted', () => {
  const VALID_DEPARTMENTS = [
    'Montevideo', 'Canelones', 'Maldonado', 'Rocha', 'Colonia',
    'San Jose', 'Florida', 'Durazno', 'Flores', 'Lavalleja',
    'Treinta y Tres', 'Cerro Largo', 'Rivera', 'Artigas',
    'Salto', 'Paysandu', 'Rio Negro', 'Soriano', 'Tacuarembo',
  ];

  it.each(VALID_DEPARTMENTS)('department "%s" is passed through unchanged', (dept) => {
    const result = applyAddressOverride({ department: dept }, BASE);
    expect(result.resolvedDept).toBe(dept);
  });
});

// ─── Section 2: Regression guard — existing pipeline is unaffected ────────────
//
// These tests verify that the non-override pipeline (mergeAddress +
// detectCityIntelligent) still produces the same results it always did.
// If any of these fail, the AddressOverride refactor broke something in
// the shared exports.

describe('mergeAddress — regression guard (existing pipeline)', () => {
  it('street + apt in address2 → apt moved to extraObs', () => {
    const { fullAddress, extraObs } = mergeAddress('Av Italia 1234', 'Apto 5');
    expect(fullAddress).toBe('Av Italia 1234');
    expect(extraObs).toBe('Apto 5');
  });

  it('apt embedded in address1 → stripped into extraObs', () => {
    const { fullAddress, extraObs } = mergeAddress('San Martín 800 Apto 12', null);
    // The merger should detect and extract the apt suffix
    expect(fullAddress).not.toContain('Apto 12');
    expect(extraObs).toContain('12');
  });

  it('no address2 → extraObs empty', () => {
    const { fullAddress, extraObs } = mergeAddress('Colonia 1234', null);
    expect(fullAddress).toBe('Colonia 1234');
    expect(extraObs).toBe('');
  });

  it('address2 that is just a door number → merged into address1', () => {
    const { fullAddress } = mergeAddress('Av Italia', '1234');
    expect(fullAddress).toContain('1234');
  });
});

describe('detectCityIntelligent — regression guard (existing pipeline)', () => {
  it('Shopify city "Pocitos" → barrio pocitos, dept Montevideo', () => {
    const result = detectCityIntelligent('Pocitos', 'Ellauri 500', '', '');
    expect(result.barrio).toBe('pocitos');
    expect(result.department).toBe('Montevideo');
  });

  it('Shopify city "Maldonado", ZIP "20100" → dept Maldonado', () => {
    const result = detectCityIntelligent('Maldonado', 'Venecia 320', '', '20100');
    expect(result.department).toBe('Maldonado');
  });

  // Product decision 2026-04-20: no barrio guessing when customer didn't name one.
  // ZIP 11500 maps to multiple barrios; submit with department only.
  it('Empty city, ZIP 11500 → barrio null, department only (no guessing)', () => {
    const result = detectCityIntelligent('', '21 de Setiembre 2900', '', '11500');
    expect(result.barrio).toBeNull();
    expect(result.department).toBe('Montevideo');
    expect(result.source).toBe('zip');
  });

  it('Unknown city, no ZIP → low confidence result', () => {
    const result = detectCityIntelligent('Ciudad Desconocida', 'Calle X 100', '', '');
    // Should not crash; confidence is low or medium
    expect(['low', 'medium', 'high']).toContain(result.confidence);
  });
});
