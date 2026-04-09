import { describe, it, expect } from 'vitest';
import { determinePaymentType } from '../rules/payment';

function makeOrder(totalPrice: string, currency = 'UYU') {
  return {
    id: 123,
    name: '#11020',
    total_price: totalPrice,
    currency,
    shipping_address: { address1: 'Test', city: 'Montevideo', province: 'Montevideo' },
  } as any;
}

describe('determinePaymentType', () => {
  // ====== RULE DISABLED ======

  it('returns DESTINATARIO when rule is disabled regardless of amount', () => {
    expect(determinePaymentType(makeOrder('5000'), 3900, false)).toBe('DESTINATARIO');
    expect(determinePaymentType(makeOrder('10000'), 3900, false)).toBe('DESTINATARIO');
    expect(determinePaymentType(makeOrder('100'), 3900, false)).toBe('DESTINATARIO');
  });

  it('returns DESTINATARIO when rule is disabled by default', () => {
    expect(determinePaymentType(makeOrder('5000'), 3900)).toBe('DESTINATARIO');
  });

  // ====== RULE ENABLED — THRESHOLD 3900 ======

  it('returns REMITENTE when order > 3900 and rule enabled', () => {
    expect(determinePaymentType(makeOrder('3901'), 3900, true)).toBe('REMITENTE');
    expect(determinePaymentType(makeOrder('5000'), 3900, true)).toBe('REMITENTE');
    expect(determinePaymentType(makeOrder('10000'), 3900, true)).toBe('REMITENTE');
  });

  it('returns DESTINATARIO when order <= 3900 and rule enabled', () => {
    expect(determinePaymentType(makeOrder('3900'), 3900, true)).toBe('DESTINATARIO');
    expect(determinePaymentType(makeOrder('3899'), 3900, true)).toBe('DESTINATARIO');
    expect(determinePaymentType(makeOrder('1991'), 3900, true)).toBe('DESTINATARIO');
    expect(determinePaymentType(makeOrder('100'), 3900, true)).toBe('DESTINATARIO');
  });

  it('returns DESTINATARIO for exactly the threshold amount', () => {
    expect(determinePaymentType(makeOrder('3900'), 3900, true)).toBe('DESTINATARIO');
  });

  it('returns REMITENTE for 1 peso above threshold', () => {
    expect(determinePaymentType(makeOrder('3901'), 3900, true)).toBe('REMITENTE');
  });

  // ====== REAL ORDER DATA ======

  it('correctly handles real order #11019 (2491 UYU < 3900)', () => {
    expect(determinePaymentType(makeOrder('2491'), 3900, true)).toBe('DESTINATARIO');
  });

  it('correctly handles real order #11020 (1991 UYU < 3900)', () => {
    expect(determinePaymentType(makeOrder('1991'), 3900, true)).toBe('DESTINATARIO');
  });

  it('correctly handles a high-value order (4500 UYU > 3900)', () => {
    expect(determinePaymentType(makeOrder('4500'), 3900, true)).toBe('REMITENTE');
  });

  // ====== USD CONVERSION ======

  it('converts USD to UYU using multiplier of 42', () => {
    // $100 USD * 42 = 4200 UYU > 3900 → REMITENTE
    expect(determinePaymentType(makeOrder('100', 'USD'), 3900, true)).toBe('REMITENTE');
  });

  it('USD order below threshold stays DESTINATARIO', () => {
    // $50 USD * 42 = 2100 UYU < 3900 → DESTINATARIO
    expect(determinePaymentType(makeOrder('50', 'USD'), 3900, true)).toBe('DESTINATARIO');
  });

  it('USD order at threshold boundary (rate=43)', () => {
    // $92.86 * 43 = 3992.98 > 3900 → REMITENTE
    expect(determinePaymentType(makeOrder('92.86', 'USD'), 3900, true)).toBe('REMITENTE');
    // $90 * 43 = 3870 < 3900 → DESTINATARIO
    expect(determinePaymentType(makeOrder('90', 'USD'), 3900, true)).toBe('DESTINATARIO');
  });

  // ====== EDGE CASES ======

  it('handles NaN total_price gracefully', () => {
    expect(determinePaymentType(makeOrder('not-a-number'), 3900, true)).toBe('DESTINATARIO');
  });

  it('handles empty string total_price', () => {
    expect(determinePaymentType(makeOrder(''), 3900, true)).toBe('DESTINATARIO');
  });

  it('handles zero total', () => {
    expect(determinePaymentType(makeOrder('0'), 3900, true)).toBe('DESTINATARIO');
  });

  it('handles negative total', () => {
    expect(determinePaymentType(makeOrder('-100'), 3900, true)).toBe('DESTINATARIO');
  });

  // ====== DIFFERENT THRESHOLDS ======

  it('works with threshold of 4000 (default)', () => {
    expect(determinePaymentType(makeOrder('4001'), 4000, true)).toBe('REMITENTE');
    expect(determinePaymentType(makeOrder('4000'), 4000, true)).toBe('DESTINATARIO');
  });

  it('works with threshold of 0 (guard: defaults to DESTINATARIO)', () => {
    // threshold=0 is invalid — code guards against it, always DESTINATARIO
    expect(determinePaymentType(makeOrder('1'), 0, true)).toBe('DESTINATARIO');
    expect(determinePaymentType(makeOrder('0'), 0, true)).toBe('DESTINATARIO');
  });
});
