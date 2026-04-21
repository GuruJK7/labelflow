/**
 * Unit tests for the customer-recurrence deterministic shortcut.
 *
 * The shortcut asks: "has this customer shipped to a street+number close to
 * today's address before?" If yes, trust that prior resolution — the
 * customer's own history beats AI inference on borderline geography.
 *
 * Two goals in tension (same pattern as hash-normalization tests):
 *   1. MATCH when the prior and the current address are plausibly the same
 *      destination (same street, number drift ≤ MAX_DIFF = 2000).
 *   2. DO NOT MATCH when they are genuinely different — either different
 *      street, or same street but far apart (e.g. Av. Italia 4500 and 8000
 *      are different barrios entirely).
 *
 * Every test below encodes one of those goals. The shortcut is the only
 * deterministic path that can recover F03 ("Rambla O'Higgins 14500" when
 * the customer has prior shipments at 14000).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveByCustomerRecurrence,
  type AIResolverInput,
} from '../ai-resolver';

const baseInput = (overrides: Partial<AIResolverInput> = {}): AIResolverInput => ({
  tenantId: 't1',
  city: 'Montevideo',
  address1: 'Rambla O\'Higgins 14500',
  address2: '',
  zip: '',
  province: 'Montevideo',
  country: 'Uruguay',
  customerFirstName: 'Returning',
  customerLastName: 'Customer',
  customerEmail: 'repeat@example.com',
  customerPhone: '099111222',
  orderNotes: '',
  ...overrides,
});

// ─── MATCH cases ────────────────────────────────────────────────────────

describe('resolveByCustomerRecurrence — MATCH cases', () => {
  it('exact number match → confidence "high"', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4500' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 4500' },
      ],
      'hash1',
    );
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe('high');
    expect(r!.department).toBe('Montevideo');
    // Italia 4500 maps to malvin via MVD_STREET_RANGES
    expect(r!.barrio).toBe('malvin');
    expect(r!.source).toBe('deterministic');
  });

  it('F03: near match (±500) → "medium" + barrio derived from new addr', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Rambla O\'Higgins 14500' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Rivera 6500' },
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Rambla O\'Higgins 14000' },
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Schroeder 6400' },
      ],
      'hashF03',
    );
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe('medium');
    expect(r!.department).toBe('Montevideo');
    // O'Higgins 14500 falls in the 14000-20000 carrasco range
    expect(r!.barrio).toBe('carrasco');
    expect(r!.city).toBe('Montevideo');
  });

  it('prefix variants collide (Av. vs bare)', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4520' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Italia 4500' },
      ],
      'h',
    );
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe('medium'); // delta=20, not exact
    expect(r!.barrio).toBe('malvin');
  });

  it('interior match: adopts prior department + canonical city', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({
        city: '',
        address1: 'Av. Artigas 250',
        province: '',
      }),
      [
        { department: 'Canelones', city: 'Las Piedras', deliveryAddress: 'Av. Artigas 200' },
      ],
      'h',
    );
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Canelones');
    expect(r!.city).toBe('Las Piedras'); // trust the prior's canonical city
    expect(r!.barrio).toBeNull();        // interior has no barrio
    expect(r!.confidence).toBe('medium');
  });

  it('picks the closest prior when multiple same-street hits', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4520' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 4000' }, // delta 520
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 4500' }, // delta 20 ← winner
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 5000' }, // delta 480
      ],
      'h',
    );
    expect(r).not.toBeNull();
    expect(r!.reasoning).toContain('Av. Italia 4500');
  });
});

// ─── NO-MATCH cases ─────────────────────────────────────────────────────

describe('resolveByCustomerRecurrence — NO-MATCH cases', () => {
  it('empty history → null', () => {
    const r = resolveByCustomerRecurrence(baseInput(), [], 'h');
    expect(r).toBeNull();
  });

  it('different street → null', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4500' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Brasil 4500' },
      ],
      'h',
    );
    expect(r).toBeNull();
  });

  it('same street but drift > MAX_DIFF (2000) → null', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 8000' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 4500' },
      ],
      'h',
    );
    // delta = 3500 > 2000 — different barrios on a long avenue
    expect(r).toBeNull();
  });

  it('current address unparseable → null', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia s/n' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 4500' },
      ],
      'h',
    );
    expect(r).toBeNull();
  });

  it('prior address unparseable → skipped', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4500' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: '(no address)' },
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Italia 4500' },
      ],
      'h',
    );
    // the unparseable prior is silently skipped; the parseable one matches
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe('high');
  });

  it('no same-street priors at all → null (multiple different streets)', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4500' }),
      [
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Brasil 2500' },
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Bulevar Artigas 1300' },
        { department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Gral. Flores 2400' },
      ],
      'h',
    );
    expect(r).toBeNull();
  });
});

// ─── MVD-specific behavior ──────────────────────────────────────────────

describe('resolveByCustomerRecurrence — MVD barrio derivation', () => {
  it('MVD + known street → barrio populated', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Brasil 2500' }),
      [{ department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Av. Brasil 2500' }],
      'h',
    );
    expect(r!.barrio).toBe('pocitos');
    expect(r!.city).toBe('Montevideo');
  });

  it('MVD + unknown street → barrio null, dept still set', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Calle Inventada 100' }),
      [{ department: 'Montevideo', city: 'Montevideo', deliveryAddress: 'Calle Inventada 100' }],
      'h',
    );
    // exact match → still a hit, but barrio can't be derived
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Montevideo');
    expect(r!.city).toBe('Montevideo');
    expect(r!.barrio).toBeNull();
    expect(r!.confidence).toBe('high'); // exact number match → high
  });

  it('non-MVD dept → barrio always null regardless of address', () => {
    const r = resolveByCustomerRecurrence(
      baseInput({ address1: 'Av. Italia 4500' }),
      [
        { department: 'Maldonado', city: 'Punta Del Este', deliveryAddress: 'Av. Italia 4500' },
      ],
      'h',
    );
    expect(r).not.toBeNull();
    expect(r!.department).toBe('Maldonado');
    expect(r!.city).toBe('Punta Del Este');
    expect(r!.barrio).toBeNull();
  });
});
