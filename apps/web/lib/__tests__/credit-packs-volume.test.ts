import { describe, it, expect } from 'vitest';
import {
  CREDIT_PACKS,
  VOLUME_PRESETS,
  MAX_MONTHLY_SHIPMENTS,
  listPacks,
  quoteForVolume,
  tierLabelFor,
} from '@/lib/credit-packs';

/**
 * Selector por volumen (D34). Los precios 20/17/15/12/10/7 son los de
 * `apps/worker/src/billing/tiers.ts`; acá se fija que la tabla web no se
 * mueva sin que alguien lo note.
 */
describe('tabla de precios', () => {
  it('20/17/15/12/10/7 UYU por envío, en packs de 10/50/100/250/500/1000', () => {
    expect(listPacks().map((p) => [p.shipments, p.pricePerShipmentUyu])).toEqual([
      [10, 20], [50, 17], [100, 15], [250, 12], [500, 10], [1000, 7],
    ]);
    for (const p of listPacks()) expect(p.totalPriceUyu).toBe(p.shipments * p.pricePerShipmentUyu);
  });

  it('los presets del selector son packs reales', () => {
    expect([...VOLUME_PRESETS]).toEqual([50, 100, 250, 500, 1000]);
    for (const n of VOLUME_PRESETS) expect(quoteForVolume(n).pack.shipments).toBe(n);
  });
});

describe('quoteForVolume', () => {
  it.each([
    // n, pack, qty, unit, total, tramo
    [1, 'pack_10', 1, 20, 200, 'Hasta 49 envíos por mes'],
    [10, 'pack_10', 1, 20, 200, 'Hasta 49 envíos por mes'],
    [11, 'pack_50', 1, 17, 850, 'Desde 50 envíos por mes'],
    [49, 'pack_50', 1, 17, 850, 'Desde 50 envíos por mes'],
    [50, 'pack_50', 1, 17, 850, 'Desde 50 envíos por mes'],
    [99, 'pack_100', 1, 15, 1500, 'Desde 100 envíos por mes'],
    [100, 'pack_100', 1, 15, 1500, 'Desde 100 envíos por mes'],
    [249, 'pack_250', 1, 12, 3000, 'Desde 250 envíos por mes'],
    [250, 'pack_250', 1, 12, 3000, 'Desde 250 envíos por mes'],
    [499, 'pack_500', 1, 10, 5000, 'Desde 500 envíos por mes'],
    [500, 'pack_500', 1, 10, 5000, 'Desde 500 envíos por mes'],
    [999, 'pack_1000', 1, 7, 7000, 'Desde 1000 envíos por mes'],
    [1000, 'pack_1000', 1, 7, 7000, 'Desde 1000 envíos por mes'],
    [1001, 'pack_1000', 2, 7, 14000, 'Desde 1000 envíos por mes'],
    [2500, 'pack_1000', 3, 7, 21000, 'Desde 1000 envíos por mes'],
  ])('n=%i → %s ×%i a $%i = $%i (%s)', (n, packId, qty, unit, total, tier) => {
    const q = quoteForVolume(n);
    expect(q.pack.id).toBe(packId);
    expect(q.quantity).toBe(qty);
    expect(q.pricePerShipmentUyu).toBe(unit);
    expect(q.totalPriceUyu).toBe(total);
    expect(q.tierLabel).toBe(tier);
    expect(q.monthlyShipments).toBe(n);
  });

  it('ahorro frente a comprar de a 10: (envíos del pack × 20) − total', () => {
    expect(quoteForVolume(10).savingsVsBaseUyu).toBe(0);
    expect(quoteForVolume(80).savingsVsBaseUyu).toBe(100 * 20 - 1500); // 500
    expect(quoteForVolume(1000).savingsVsBaseUyu).toBe(20000 - 7000); // 13000
    expect(quoteForVolume(2500).savingsVsBaseUyu).toBe(3 * 1000 * 20 - 21000); // 39000
  });

  it('tramo siguiente: cuántos envíos más para pagar menos por envío', () => {
    expect(quoteForVolume(80).nextTier).toEqual({
      pack: CREDIT_PACKS.pack_250,
      shipmentsMore: 170,
      pricePerShipmentUyu: 12,
      totalPriceUyu: 3000,
    });
    expect(quoteForVolume(100).nextTier?.shipmentsMore).toBe(150);
    expect(quoteForVolume(1).nextTier?.pack.id).toBe('pack_50');
    // En el último tramo o comprando varios packs no hay nada más barato.
    expect(quoteForVolume(1000).nextTier).toBeNull();
    expect(quoteForVolume(1500).nextTier).toBeNull();
  });

  it.each([0, -1, 1.5, 1e9, Number.NaN, Number.POSITIVE_INFINITY])('rechaza %s con RangeError', (n) => {
    expect(() => quoteForVolume(n)).toThrow(RangeError);
    expect(() => tierLabelFor(n)).toThrow(RangeError);
  });

  it('acepta el máximo y rechaza uno más', () => {
    expect(quoteForVolume(MAX_MONTHLY_SHIPMENTS).quantity).toBe(100);
    expect(() => quoteForVolume(MAX_MONTHLY_SHIPMENTS + 1)).toThrow(RangeError);
  });

  it('invariante: el precio por envío nunca sube con el volumen, y el total es entero', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let n = 1; n <= 3000; n++) {
      const q = quoteForVolume(n);
      expect(q.pricePerShipmentUyu).toBeLessThanOrEqual(prev);
      expect(Number.isInteger(q.totalPriceUyu)).toBe(true);
      expect(q.pack.shipments * q.quantity).toBeGreaterThanOrEqual(n);
      prev = q.pricePerShipmentUyu;
    }
  });
});

describe('tierLabelFor', () => {
  it.each([
    [1, 'Hasta 49 envíos por mes'], [49, 'Hasta 49 envíos por mes'],
    [50, 'Desde 50 envíos por mes'], [99, 'Desde 50 envíos por mes'],
    [100, 'Desde 100 envíos por mes'], [249, 'Desde 100 envíos por mes'],
    [250, 'Desde 250 envíos por mes'], [499, 'Desde 250 envíos por mes'],
    [500, 'Desde 500 envíos por mes'], [999, 'Desde 500 envíos por mes'],
    [1000, 'Desde 1000 envíos por mes'], [5000, 'Desde 1000 envíos por mes'],
  ])('%i → %s', (n, label) => {
    expect(tierLabelFor(n)).toBe(label);
  });
});
