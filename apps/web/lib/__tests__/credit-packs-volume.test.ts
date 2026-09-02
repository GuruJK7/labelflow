import { describe, it, expect } from 'vitest';
import {
  PACK_SHIPMENTS,
  LEGACY_PACK_IDS,
  VOLUME_PRESETS,
  MAX_MONTHLY_SHIPMENTS,
  getPack,
  listPacks,
  listPricingSteps,
  packIdList,
  quoteForVolume,
  tierLabelFor,
} from '@/lib/credit-packs';
import { BASE_USD_UYU_RATE_MILLI, periodTotalUsdMilli } from '@/lib/pricing';

/**
 * Catálogo de compra sobre la escalera en dólares de D35. Los precios ya no
 * viven acá: salen de `lib/pricing.ts`. Este archivo fija que la conversión a
 * pesos, la recomendación de pack y la compatibilidad con los ids ya vendidos
 * no se muevan sin que alguien lo note.
 *
 * Todo se evalúa al tipo BASE (40 UYU/USD) pasado explícito: `process.env` en
 * el runner no es el de producción.
 */
const RATE = BASE_USD_UYU_RATE_MILLI;

describe('catálogo', () => {
  it('los ocho paquetes, con su precio en dólares y su total en pesos al tipo base', () => {
    expect(
      listPacks(RATE).map((p) => [
        p.id,
        p.shipments,
        p.pricePerShipmentUsdMilli,
        p.totalPriceUsdMilli,
        p.totalPriceUyu,
        p.pricePerShipmentUyu,
      ]),
    ).toEqual([
      ['pack_10', 10, 500, 5_000, 200, 20],
      ['pack_50', 50, 420, 21_000, 840, 16.8],
      ['pack_100', 100, 370, 37_000, 1_480, 14.8],
      ['pack_250', 250, 300, 75_000, 3_000, 12],
      ['pack_500', 500, 250, 125_000, 5_000, 10],
      ['pack_1000', 1000, 180, 180_000, 7_200, 7.2],
      ['pack_2500', 2500, 140, 350_000, 14_000, 5.6],
      ['pack_5000', 5000, 110, 550_000, 22_000, 4.4],
    ]);
  });

  it('COMPATIBILIDAD: los seis ids ya vendidos siguen existiendo y con los mismos envíos', () => {
    // `CreditPurchase.packId` está persistido en compras reales. Si un id
    // desaparece, el historial deja de resolver y el checkout de un link viejo
    // devuelve 400. Los precios de esas compras viejas NO se recalculan: cada
    // fila guarda su propio importe.
    for (const id of LEGACY_PACK_IDS) {
      const pack = getPack(id, RATE);
      expect(pack, id).not.toBeNull();
      expect(pack!.id).toBe(id);
      expect(pack!.shipments).toBe(Number(id.replace('pack_', '')));
    }
    expect(LEGACY_PACK_IDS.every((id) => (PACK_SHIPMENTS as readonly number[]).includes(
      Number(id.replace('pack_', '')),
    ))).toBe(true);
  });

  it('los dos paquetes nuevos de D35 existen', () => {
    expect(getPack('pack_2500', RATE)?.shipments).toBe(2500);
    expect(getPack('pack_5000', RATE)?.shipments).toBe(5000);
  });

  it('rechaza ids inventados sin romperse', () => {
    for (const malo of ['pack_7', 'pack_', 'pack_1e3', '../pack_10', 'PACK_10', '', 'pack_010']) {
      expect(getPack(malo, RATE), malo).toBeNull();
    }
    expect(packIdList()).toBe(
      'pack_10, pack_50, pack_100, pack_250, pack_500, pack_1000, pack_2500, pack_5000',
    );
  });

  it('el total en pesos sigue al tipo de cambio', () => {
    expect(getPack('pack_100', 41_500n)!.totalPriceUyu).toBe(1_536); // 37 × 41,5 = 1.535,50
    expect(getPack('pack_100', 44_000n)!.totalPriceUyu).toBe(1_628); // 37 × 44
    // El precio en dólares NO se mueve: es la denominación.
    expect(getPack('pack_100', 44_000n)!.totalPriceUsdMilli).toBe(37_000);
  });

  it('los presets del selector son cantidades comprables', () => {
    expect([...VOLUME_PRESETS]).toEqual([50, 100, 250, 500, 1000, 2500, 5000]);
    for (const n of VOLUME_PRESETS) expect(quoteForVolume(n, RATE).pack.shipments).toBe(n);
  });
});

describe('listPricingSteps', () => {
  it('devuelve los ocho escalones con el mes completo en USD y en pesos', () => {
    expect(listPricingSteps(RATE)).toEqual([
      { minShipments: 0, label: 'Hasta 49 envíos por mes', unitPriceUsdMilli: 500, totalAtStepUsdMilli: 500, totalAtStepUyu: 20 },
      { minShipments: 50, label: 'Desde 50 envíos por mes', unitPriceUsdMilli: 420, totalAtStepUsdMilli: 21_000, totalAtStepUyu: 840 },
      { minShipments: 100, label: 'Desde 100 envíos por mes', unitPriceUsdMilli: 370, totalAtStepUsdMilli: 37_000, totalAtStepUyu: 1_480 },
      { minShipments: 250, label: 'Desde 250 envíos por mes', unitPriceUsdMilli: 300, totalAtStepUsdMilli: 75_000, totalAtStepUyu: 3_000 },
      { minShipments: 500, label: 'Desde 500 envíos por mes', unitPriceUsdMilli: 250, totalAtStepUsdMilli: 125_000, totalAtStepUyu: 5_000 },
      { minShipments: 1000, label: 'Desde 1000 envíos por mes', unitPriceUsdMilli: 180, totalAtStepUsdMilli: 180_000, totalAtStepUyu: 7_200 },
      { minShipments: 2500, label: 'Desde 2500 envíos por mes', unitPriceUsdMilli: 140, totalAtStepUsdMilli: 350_000, totalAtStepUyu: 14_000 },
      { minShipments: 5000, label: 'Desde 5000 envíos por mes', unitPriceUsdMilli: 110, totalAtStepUsdMilli: 550_000, totalAtStepUyu: 22_000 },
    ]);
  });
});

describe('quoteForVolume', () => {
  it.each([
    // n, pack, qty, efectivo USD milli, mes USD milli, mes UYU, tramo
    [1, 'pack_10', 1, 500, 500, 20, 'Hasta 49 envíos por mes'],
    [10, 'pack_10', 1, 500, 5_000, 200, 'Hasta 49 envíos por mes'],
    [11, 'pack_50', 1, 500, 5_500, 220, 'Hasta 49 envíos por mes'],
    [49, 'pack_50', 1, 428, 21_000, 840, 'Hasta 49 envíos por mes'],
    [50, 'pack_50', 1, 420, 21_000, 840, 'Desde 50 envíos por mes'],
    [99, 'pack_100', 1, 373, 37_000, 1_480, 'Desde 50 envíos por mes'],
    [100, 'pack_100', 1, 370, 37_000, 1_480, 'Desde 100 envíos por mes'],
    [250, 'pack_250', 1, 300, 75_000, 3_000, 'Desde 250 envíos por mes'],
    [500, 'pack_500', 1, 250, 125_000, 5_000, 'Desde 500 envíos por mes'],
    [800, 'pack_1000', 1, 225, 180_000, 7_200, 'Desde 500 envíos por mes'],
    [1000, 'pack_1000', 1, 180, 180_000, 7_200, 'Desde 1000 envíos por mes'],
    [2500, 'pack_2500', 1, 140, 350_000, 14_000, 'Desde 2500 envíos por mes'],
    [5000, 'pack_5000', 1, 110, 550_000, 22_000, 'Desde 5000 envíos por mes'],
    [5001, 'pack_5000', 2, 110, 550_110, 22_004, 'Desde 5000 envíos por mes'],
  ])(
    'n=%i → %s ×%i, efectivo %i milésimos de USD, mes USD %i / UYU %i (%s)',
    (n, packId, qty, efectivo, mesUsd, mesUyu, tramo) => {
      const q = quoteForVolume(n, RATE);
      expect(q.pack.id).toBe(packId);
      expect(q.quantity).toBe(qty);
      expect(q.effectiveUnitUsdMilli).toBe(efectivo);
      expect(q.monthlyTotalUsdMilli).toBe(mesUsd);
      expect(q.monthlyTotalUyu).toBe(mesUyu);
      expect(q.tierLabel).toBe(tramo);
      expect(q.usdUyuRateMilli).toBe(Number(RATE));
    },
  );

  it('el pack recomendado puede costar más que el mes declarado: lo que sobra queda', () => {
    const q = quoteForVolume(11, RATE);
    expect(q.monthlyTotalUsdMilli).toBe(5_500); // 11 envíos sueltos
    expect(q.totalPriceUsdMilli).toBe(21_000); // pero se compra el de 50
    expect(q.totalPriceUyu).toBe(840);
  });

  it('marca cuando el volumen ya paga el techo de un escalón mejor', () => {
    expect(quoteForVolume(800, RATE).cappedByBetterTier).toBe(true);
    expect(quoteForVolume(49, RATE).cappedByBetterTier).toBe(true);
    expect(quoteForVolume(1000, RATE).cappedByBetterTier).toBe(false);
    expect(quoteForVolume(10, RATE).cappedByBetterTier).toBe(false);
  });

  it('ahorro frente al precio de entrada: n × 0,50 − total del mes', () => {
    for (const n of [1, 10, 50, 100, 250, 500, 1000, 2500, 5000]) {
      const q = quoteForVolume(n, RATE);
      expect(q.savingsVsBaseUsdMilli, `n=${n}`).toBe(n * 500 - Number(periodTotalUsdMilli(n)));
    }
    expect(quoteForVolume(100, RATE).savingsVsBaseUsdMilli).toBe(13_000); // USD 13
  });

  it('el empujón al escalón siguiente, con el ahorro REAL por envío', () => {
    const q = quoteForVolume(100, RATE);
    expect(q.nextStep).toEqual({
      minShipments: 250,
      label: 'Desde 250 envíos por mes',
      shipmentsMore: 150,
      savesPerShipmentUsdMilli: 70, // 0,370 efectivo → 0,300
      unitPriceUsdMilli: 300,
      totalAtStepUsdMilli: 75_000,
      totalAtStepUyu: 3_000,
    });
    expect(quoteForVolume(5000, RATE).nextStep).toBeNull();
    // En la zona de tope el ahorro real es 0: la UI no muestra el empujón.
    expect(quoteForVolume(4999, RATE).nextStep!.savesPerShipmentUsdMilli).toBe(0);
  });

  it('acepta el máximo y rechaza uno más', () => {
    expect(() => quoteForVolume(MAX_MONTHLY_SHIPMENTS, RATE)).not.toThrow();
    expect(() => quoteForVolume(MAX_MONTHLY_SHIPMENTS + 1, RATE)).toThrow(RangeError);
    expect(() => quoteForVolume(0, RATE)).toThrow(RangeError);
    expect(() => quoteForVolume(1.5, RATE)).toThrow(RangeError);
  });

  it('invariante: el efectivo nunca sube, el mes nunca baja, y los pesos son enteros', () => {
    let prevUnit = quoteForVolume(1, RATE).effectiveUnitUsdMilli;
    let prevMes = quoteForVolume(1, RATE).monthlyTotalUyu;
    for (let n = 2; n <= 6000; n++) {
      const q = quoteForVolume(n, RATE);
      expect(q.effectiveUnitUsdMilli, `efectivo subió en ${n}`).toBeLessThanOrEqual(prevUnit);
      expect(q.monthlyTotalUyu, `el mes bajó en ${n}`).toBeGreaterThanOrEqual(prevMes);
      expect(Number.isInteger(q.monthlyTotalUyu), `n=${n}`).toBe(true);
      expect(Number.isInteger(q.totalPriceUyu), `n=${n}`).toBe(true);
      prevUnit = q.effectiveUnitUsdMilli;
      prevMes = q.monthlyTotalUyu;
    }
  });
});

describe('tierLabelFor', () => {
  it.each([
    [1, 'Hasta 49 envíos por mes'],
    [49, 'Hasta 49 envíos por mes'],
    [50, 'Desde 50 envíos por mes'],
    [999, 'Desde 500 envíos por mes'],
    [1000, 'Desde 1000 envíos por mes'],
    [2500, 'Desde 2500 envíos por mes'],
    [5000, 'Desde 5000 envíos por mes'],
    [50_000, 'Desde 5000 envíos por mes'],
  ])('%i → %s', (n, label) => {
    expect(tierLabelFor(n)).toBe(label);
  });
});
