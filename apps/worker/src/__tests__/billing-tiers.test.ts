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
} from '../billing/tiers';

/** Rango de barrido. Cubre con margen el tramo más alto (1000). */
const SWEEP = 2000;

describe('tarifario — estructura', () => {
  it('el tarifario vigente es válido', () => {
    expect(() => assertTiersValid()).not.toThrow();
  });

  it('rechaza un tarifario que sube de precio al subir el volumen', () => {
    expect(() =>
      assertTiersValid([
        { minShipments: 0, unitPriceMilli: uyu(10), label: 'a' },
        { minShipments: 50, unitPriceMilli: uyu(12), label: 'b' },
      ]),
    ).toThrow(/no es más barato/);
  });

  it('rechaza un tarifario que no arranca en 0', () => {
    expect(() =>
      assertTiersValid([{ minShipments: 10, unitPriceMilli: uyu(20), label: 'a' }]),
    ).toThrow(/arrancar en 0/);
  });

  it('rechaza tramos desordenados', () => {
    expect(() =>
      assertTiersValid([
        { minShipments: 0, unitPriceMilli: uyu(20), label: 'a' },
        { minShipments: 100, unitPriceMilli: uyu(15), label: 'b' },
        { minShipments: 50, unitPriceMilli: uyu(12), label: 'c' },
      ]),
    ).toThrow(/desordenados/);
  });

  it('conserva exactamente los precios que ya cobra credit-packs.ts', () => {
    expect(unitPriceFor(1)).toBe(uyu(20));
    expect(unitPriceFor(50)).toBe(uyu(17));
    expect(unitPriceFor(100)).toBe(uyu(15));
    expect(unitPriceFor(250)).toBe(uyu(12));
    expect(unitPriceFor(500)).toBe(uyu(10));
    expect(unitPriceFor(1000)).toBe(uyu(7));
    expect(unitPriceFor(99999)).toBe(uyu(7));
  });

  it('tierFor devuelve el tramo correcto en los bordes', () => {
    expect(tierFor(49).minShipments).toBe(0);
    expect(tierFor(50).minShipments).toBe(50);
    expect(tierFor(99).minShipments).toBe(50);
    expect(tierFor(100).minShipments).toBe(100);
    expect(tierFor(999).minShipments).toBe(500);
    expect(tierFor(1000).minShipments).toBe(1000);
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

  it('elimina las cinco zonas muertas del tarifario original', () => {
    // Con `n × precio(n)` a secas estos volúmenes pagaban MÁS que el piso del
    // tramo siguiente. Cada par de abajo es una zona muerta real del tarifario
    // que hoy está en producción.
    const zonasMuertas: Array<[number, number]> = [
      [43, 50],
      [49, 50],
      [89, 100],
      [99, 100],
      [201, 250],
      [249, 250],
      [417, 500],
      [499, 500],
      [701, 1000],
      [999, 1000],
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

  it('los totales de referencia coinciden con la tabla comercial vigente', () => {
    // Los mismos números que hoy muestra credit-packs.ts, para que la
    // migración no cambie ningún precio anunciado.
    expect(periodTotalMilli(10)).toBe(uyu(200));
    expect(periodTotalMilli(50)).toBe(uyu(850));
    expect(periodTotalMilli(100)).toBe(uyu(1500));
    expect(periodTotalMilli(250)).toBe(uyu(3000));
    expect(periodTotalMilli(500)).toBe(uyu(5000));
    expect(periodTotalMilli(1000)).toBe(uyu(7000));
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
