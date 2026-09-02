import { describe, it, expect } from 'vitest';
import {
  TIERS,
  uyu,
  unitPriceFor,
  tierFor,
  periodTotalMilli,
  effectiveUnitPriceMilli,
  quote,
  assertTiersValid,
  usdMilliToUyuMilliAtBase,
  BASE_USD_UYU_RATE_MILLI,
  type Tier,
} from '../billing/tiers';

/** Rango de barrido. Cubre con margen el escalón más alto (5000). */
const SWEEP = 6000;

/** Constructor de tramos para los casos negativos de `assertTiersValid`. */
function t(minShipments: number, unitPriceUsdMilli: bigint, label: string): Tier {
  return {
    minShipments,
    unitPriceUsdMilli,
    unitPriceMilli: usdMilliToUyuMilliAtBase(unitPriceUsdMilli),
    label,
  };
}

describe('tarifario — estructura', () => {
  it('el tarifario vigente es válido', () => {
    expect(() => assertTiersValid()).not.toThrow();
  });

  it('rechaza un tarifario que sube de precio al subir el volumen', () => {
    expect(() =>
      assertTiersValid([t(0, 250n, 'a'), t(50, 300n, 'b')]),
    ).toThrow(/no es más barato/);
  });

  it('rechaza un tarifario que no arranca en 0', () => {
    expect(() =>
      assertTiersValid([t(10, 500n, 'a')]),
    ).toThrow(/arrancar en 0/);
  });

  it('rechaza tramos desordenados', () => {
    expect(() =>
      assertTiersValid([t(0, 500n, 'a'), t(100, 370n, 'b'), t(50, 300n, 'c')]),
    ).toThrow(/desordenados/);
  });

  it('la escalera en dólares es exactamente la de D35', () => {
    expect(TIERS.map((x) => [x.minShipments, Number(x.unitPriceUsdMilli)])).toEqual([
      [0, 500],
      [50, 420],
      [100, 370],
      [250, 300],
      [500, 250],
      [1000, 175],
      [2500, 140],
      [5000, 110],
    ]);
  });

  it('los pesos se derivan del dólar al tipo base, nunca se escriben a mano', () => {
    expect(BASE_USD_UYU_RATE_MILLI).toBe(40_000n);
    for (const tier of TIERS) {
      expect(tier.unitPriceMilli, `tramo ${tier.minShipments}`).toBe(
        usdMilliToUyuMilliAtBase(tier.unitPriceUsdMilli),
      );
    }
    // Y a tipo 40 dan estos pesos por envío.
    expect(TIERS.map((x) => Number(x.unitPriceMilli))).toEqual([
      20_000, 16_800, 14_800, 12_000, 10_000, 7_000, 5_600, 4_400,
    ]);
  });

  it('rechaza un tramo cuyo precio en pesos no salga del de dólares', () => {
    expect(() =>
      assertTiersValid([
        t(0, 500n, 'a'),
        { minShipments: 50, unitPriceUsdMilli: 420n, unitPriceMilli: uyu(17), label: 'b' },
      ]),
    ).toThrow(/desenganchado/);
  });

  it('unitPriceFor devuelve el precio del escalón, también en los nuevos', () => {
    expect(unitPriceFor(1)).toBe(usdMilliToUyuMilliAtBase(500n));
    expect(unitPriceFor(50)).toBe(usdMilliToUyuMilliAtBase(420n));
    expect(unitPriceFor(100)).toBe(usdMilliToUyuMilliAtBase(370n));
    expect(unitPriceFor(250)).toBe(usdMilliToUyuMilliAtBase(300n));
    expect(unitPriceFor(500)).toBe(usdMilliToUyuMilliAtBase(250n));
    expect(unitPriceFor(1000)).toBe(usdMilliToUyuMilliAtBase(175n));
    expect(unitPriceFor(2500)).toBe(usdMilliToUyuMilliAtBase(140n));
    expect(unitPriceFor(5000)).toBe(usdMilliToUyuMilliAtBase(110n));
    expect(unitPriceFor(99999)).toBe(usdMilliToUyuMilliAtBase(110n));
  });

  it('tierFor devuelve el tramo correcto en los bordes', () => {
    expect(tierFor(49).minShipments).toBe(0);
    expect(tierFor(50).minShipments).toBe(50);
    expect(tierFor(99).minShipments).toBe(50);
    expect(tierFor(100).minShipments).toBe(100);
    expect(tierFor(999).minShipments).toBe(500);
    expect(tierFor(1000).minShipments).toBe(1000);
    expect(tierFor(2499).minShipments).toBe(1000);
    expect(tierFor(2500).minShipments).toBe(2500);
    expect(tierFor(4999).minShipments).toBe(2500);
    expect(tierFor(5000).minShipments).toBe(5000);
  });
});

describe('tarifario — total del período', () => {
  it('cero envíos no cuestan nada', () => {
    expect(periodTotalMilli(0)).toBe(0n);
    expect(effectiveUnitPriceMilli(0)).toBe(0n);
  });

  it('MONÓTONA: hacer un envío más nunca puede bajar la factura', () => {
    // Es LA propiedad del tarifario. Si falla, existe un volumen donde al
    // cliente le conviene despachar de menos, y el primero que lo note tiene
    // razón en enojarse.
    let prev = periodTotalMilli(0);
    for (let n = 1; n <= SWEEP; n++) {
      const cur = periodTotalMilli(n);
      expect(cur, `total(${n}) < total(${n - 1})`).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('nunca cobra más que el precio de lista de su propio tramo', () => {
    for (let n = 1; n <= SWEEP; n++) {
      const lista = BigInt(n) * unitPriceFor(n);
      expect(periodTotalMilli(n), `n=${n}`).toBeLessThanOrEqual(lista);
    }
  });

  it('elimina las siete zonas muertas de la escalera', () => {
    // Con `n × precio(n)` a secas estos volúmenes pagaban MÁS que el piso del
    // tramo siguiente. Cada par de abajo es una zona muerta real del tarifario
    // que hoy está en producción.
    const zonasMuertas: Array<[number, number]> = [
      [43, 50],
      [49, 50],
      [89, 100],
      [99, 100],
      [203, 250],
      [249, 250],
      [417, 500],
      [499, 500],
      [701, 1000],
      [999, 1000],
      [2001, 2500],
      [2499, 2500],
      [3929, 5000],
      [4999, 5000],
    ];
    for (const [menos, mas] of zonasMuertas) {
      const ingenuo = BigInt(menos) * unitPriceFor(menos);
      const techo = BigInt(mas) * unitPriceFor(mas);
      // La zona muerta existía de verdad en el modelo ingenuo...
      expect(ingenuo, `zona muerta esperada en ${menos}`).toBeGreaterThan(techo);
      // ...y con periodTotalMilli ya no existe.
      expect(periodTotalMilli(menos), `${menos} sigue pagando de más`).toBeLessThanOrEqual(
        periodTotalMilli(mas),
      );
    }
  });

  it('en el piso de cada tramo cobra exactamente el total del tramo', () => {
    for (const t of TIERS) {
      if (t.minShipments === 0) continue;
      expect(periodTotalMilli(t.minShipments)).toBe(
        BigInt(t.minShipments) * t.unitPriceMilli,
      );
    }
  });

  it('los totales de referencia son los de D35 convertidos al tipo base', () => {
    // USD 5 / 21 / 37 / 75 / 125 / 175 / 350 / 550 a 40 UYU/USD.
    expect(periodTotalMilli(10)).toBe(uyu(200));
    expect(periodTotalMilli(50)).toBe(uyu(840));
    expect(periodTotalMilli(100)).toBe(uyu(1480));
    expect(periodTotalMilli(250)).toBe(uyu(3000));
    expect(periodTotalMilli(500)).toBe(uyu(5000));
    expect(periodTotalMilli(1000)).toBe(uyu(7000));
    expect(periodTotalMilli(2500)).toBe(uyu(14000));
    expect(periodTotalMilli(5000)).toBe(uyu(22000));
  });

  it('NINGÚN escalón cobra más que el tarifario viejo en pesos', () => {
    // La promesa de D35 es "ningún cliente actual paga más" y ahora se cumple
    // en los SEIS escalones viejos. El de 1.000 era la excepción mientras valía
    // 0,18 (7/40 redondeado para arriba → 7,20 UYU); con 0,175 da 7,00 clavado.
    // Decisión de Adrian del 2026-09-02; este test cae si alguien la revierte.
    const viejos: Array<[number, number]> = [
      [0, 20],
      [50, 17],
      [100, 15],
      [250, 12],
      [500, 10],
      [1000, 7],
    ];
    for (const [corte, precioViejo] of viejos) {
      expect(unitPriceFor(corte), `escalón ${corte}`).toBeLessThanOrEqual(uyu(precioViejo));
    }
    expect(unitPriceFor(1000)).toBe(uyu(7)); // 7,00 UYU exactos, no 7,20
  });

  it('el precio efectivo nunca supera al de lista', () => {
    for (let n = 1; n <= SWEEP; n++) {
      expect(effectiveUnitPriceMilli(n), `n=${n}`).toBeLessThanOrEqual(unitPriceFor(n));
    }
  });

  it('marca cuando el cliente está pagando el techo de un tramo mejor', () => {
    expect(quote(800).cappedByBetterTier).toBe(true);
    expect(quote(800).totalMilli).toBe(uyu(7000));
    expect(quote(1000).cappedByBetterTier).toBe(false);
    expect(quote(10).cappedByBetterTier).toBe(false);
  });

  it('rechaza entradas inválidas en vez de devolver basura', () => {
    expect(() => periodTotalMilli(-1)).toThrow(RangeError);
    expect(() => periodTotalMilli(1.5)).toThrow(RangeError);
    expect(() => periodTotalMilli(50_000_000)).toThrow(RangeError);
    expect(() => uyu(1.5)).toThrow(RangeError);
  });
});
