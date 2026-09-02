import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PRICING_TIERS,
  BASE_USD_UYU_RATE_MILLI,
  LEGACY_UNIT_PRICE_UYU,
  USD_UYU_RATE_ENV,
  assertPricingTiersValid,
  divRoundHalfUp,
  effectiveUnitUsdMilli,
  formatRate,
  formatUsdMilli,
  getUsdUyuRateMilli,
  legacyPriceRegressions,
  maxRateWithoutIncreaseMilli,
  nextTierHint,
  parseRateMilli,
  periodTotalUsdMilli,
  quoteUsd,
  tierFor,
  unitPriceUsdMilliFor,
  usdMilliToUyuMilli,
  usdMilliToUyuWhole,
  _resetPricingWarnings,
} from '@/lib/pricing';

/**
 * La escalera en dólares de D35. Barrido hasta 6.000 para cubrir con margen el
 * último escalón (5.000).
 */
const SWEEP = 6000;

afterEach(() => {
  _resetPricingWarnings();
});

describe('escalera D35 — los ocho escalones', () => {
  it('son exactamente los valores decididos', () => {
    expect(PRICING_TIERS.map((t) => [t.minShipments, Number(t.unitPriceUsdMilli)])).toEqual([
      [0, 500],
      [50, 420],
      [100, 370],
      [250, 300],
      [500, 250],
      [1000, 180],
      [2500, 140],
      [5000, 110],
    ]);
  });

  it('la estructura es válida y se valida al importar', () => {
    expect(() => assertPricingTiersValid()).not.toThrow();
  });

  it('rechaza una escalera que sube de precio', () => {
    expect(() =>
      assertPricingTiersValid([
        { minShipments: 0, unitPriceUsdMilli: 100n, label: 'a' },
        { minShipments: 50, unitPriceUsdMilli: 200n, label: 'b' },
      ]),
    ).toThrow(/no es más barato/);
  });

  it('rechaza una escalera que no arranca en 0', () => {
    expect(() =>
      assertPricingTiersValid([{ minShipments: 10, unitPriceUsdMilli: 500n, label: 'a' }]),
    ).toThrow(/arrancar en 0/);
  });

  it('rechaza escalones desordenados', () => {
    expect(() =>
      assertPricingTiersValid([
        { minShipments: 0, unitPriceUsdMilli: 500n, label: 'a' },
        { minShipments: 100, unitPriceUsdMilli: 370n, label: 'b' },
        { minShipments: 50, unitPriceUsdMilli: 300n, label: 'c' },
      ]),
    ).toThrow(/desordenados/);
  });

  it('unitPriceUsdMilliFor y tierFor aciertan en cada borde', () => {
    const bordes: Array<[number, number, number]> = [
      // [envíos, minShipments esperado, precio de lista esperado]
      [0, 0, 500],
      [49, 0, 500],
      [50, 50, 420],
      [99, 50, 420],
      [100, 100, 370],
      [249, 100, 370],
      [250, 250, 300],
      [499, 250, 300],
      [500, 500, 250],
      [999, 500, 250],
      [1000, 1000, 180],
      [2499, 1000, 180],
      [2500, 2500, 140],
      [4999, 2500, 140],
      [5000, 5000, 110],
      [999_999, 5000, 110],
    ];
    for (const [n, min, precio] of bordes) {
      expect(tierFor(n).minShipments, `tierFor(${n})`).toBe(min);
      expect(Number(unitPriceUsdMilliFor(n)), `unitPriceFor(${n})`).toBe(precio);
    }
  });
});

describe('total del período — monotonía', () => {
  it('cero envíos no cuestan nada', () => {
    expect(periodTotalUsdMilli(0)).toBe(0n);
    expect(effectiveUnitUsdMilli(0)).toBe(0n);
  });

  it('MONÓTONA: de 0 a 6000, hacer un envío más nunca baja la factura', () => {
    // Es LA propiedad de la escalera. Si falla, existe un volumen donde al
    // cliente le conviene despachar de menos.
    let prev = periodTotalUsdMilli(0);
    for (let n = 1; n <= SWEEP; n++) {
      const cur = periodTotalUsdMilli(n);
      expect(cur >= prev, `total(${n}) < total(${n - 1})`).toBe(true);
      prev = cur;
    }
  });

  it('nunca cobra más que el total del escalón siguiente', () => {
    for (let n = 0; n <= SWEEP; n++) {
      const next = PRICING_TIERS.find((t) => t.minShipments > n);
      if (!next) continue;
      expect(
        periodTotalUsdMilli(n) <= periodTotalUsdMilli(next.minShipments),
        `n=${n} paga más que el piso de ${next.minShipments}`,
      ).toBe(true);
    }
  });

  it('nunca cobra más que el precio de lista de su propio escalón', () => {
    for (let n = 1; n <= SWEEP; n++) {
      expect(periodTotalUsdMilli(n) <= BigInt(n) * unitPriceUsdMilliFor(n), `n=${n}`).toBe(true);
    }
  });

  it('el precio por envío NUNCA sube al aumentar el volumen', () => {
    let prev = effectiveUnitUsdMilli(1);
    for (let n = 2; n <= SWEEP; n++) {
      const cur = effectiveUnitUsdMilli(n);
      expect(cur <= prev, `efectivo(${n}) > efectivo(${n - 1})`).toBe(true);
      prev = cur;
    }
  });

  it('en el piso de cada escalón el total es envíos × precio del escalón', () => {
    for (const t of PRICING_TIERS) {
      if (t.minShipments === 0) continue;
      expect(periodTotalUsdMilli(t.minShipments)).toBe(
        BigInt(t.minShipments) * t.unitPriceUsdMilli,
      );
    }
  });

  it('elimina las siete zonas muertas de la escalera', () => {
    // Con `n × precio(n)` a secas, estos volúmenes pagaban MÁS que el piso del
    // escalón siguiente. Cada par es una zona muerta real de la escalera D35.
    const zonasMuertas: Array<[number, number]> = [
      [43, 50],
      [49, 50],
      [89, 100],
      [99, 100],
      [203, 250],
      [249, 250],
      [417, 500],
      [499, 500],
      [721, 1000],
      [999, 1000],
      [1945, 2500],
      [2499, 2500],
      [3929, 5000],
      [4999, 5000],
    ];
    for (const [menos, mas] of zonasMuertas) {
      const ingenuo = BigInt(menos) * unitPriceUsdMilliFor(menos);
      const techo = BigInt(mas) * unitPriceUsdMilliFor(mas);
      expect(ingenuo > techo, `la zona muerta en ${menos} tenía que existir`).toBe(true);
      expect(
        periodTotalUsdMilli(menos) <= periodTotalUsdMilli(mas),
        `${menos} sigue pagando de más que ${mas}`,
      ).toBe(true);
    }
  });

  it('los totales de referencia son los de D35', () => {
    const esperados: Array<[number, number]> = [
      [10, 5_000],
      [50, 21_000],
      [100, 37_000],
      [250, 75_000],
      [500, 125_000],
      [1000, 180_000],
      [2500, 350_000],
      [5000, 550_000],
    ];
    for (const [n, milli] of esperados) {
      expect(Number(periodTotalUsdMilli(n)), `total(${n})`).toBe(milli);
    }
  });

  it('marca cuando el cliente paga el techo de un escalón mejor', () => {
    expect(quoteUsd(800).cappedByBetterTier).toBe(true);
    expect(Number(quoteUsd(800).totalUsdMilli)).toBe(180_000);
    expect(Number(quoteUsd(800).effectiveUnitUsdMilli)).toBe(225); // 180/800
    expect(quoteUsd(1000).cappedByBetterTier).toBe(false);
    expect(quoteUsd(10).cappedByBetterTier).toBe(false);
  });

  it('rechaza entradas inválidas en vez de devolver basura', () => {
    expect(() => periodTotalUsdMilli(-1)).toThrow(RangeError);
    expect(() => periodTotalUsdMilli(1.5)).toThrow(RangeError);
    expect(() => periodTotalUsdMilli(50_000_000)).toThrow(RangeError);
  });
});

describe('nextTierHint — el empujón al escalón siguiente', () => {
  it('acierta en los bordes 49/50, 249/250, 999/1000 y 4999/5000', () => {
    // 49: ya paga el techo del escalón de 50 (21,00/49 = 0,428), así que le
    // falta 1 envío y el ahorro REAL es apenas 0,008 — no los 0,08 de lista.
    const h49 = nextTierHint(49)!;
    expect(h49.tier.minShipments).toBe(50);
    expect(h49.shipmentsMore).toBe(1);
    expect(Number(h49.savesPerShipmentUsdMilli)).toBe(8);
    expect(Number(h49.listSavesPerShipmentUsdMilli)).toBe(80);

    // 50: recién entrado al escalón, el siguiente es 100.
    const h50 = nextTierHint(50)!;
    expect(h50.tier.minShipments).toBe(100);
    expect(h50.shipmentsMore).toBe(50);
    expect(Number(h50.savesPerShipmentUsdMilli)).toBe(50); // 0,420 → 0,370

    const h249 = nextTierHint(249)!;
    expect(h249.tier.minShipments).toBe(250);
    expect(h249.shipmentsMore).toBe(1);
    // 249 paga 75,00 (techo de 250) → efectivo 0,301; en 250 es 0,300.
    expect(Number(h249.savesPerShipmentUsdMilli)).toBe(1);

    const h999 = nextTierHint(999)!;
    expect(h999.tier.minShipments).toBe(1000);
    expect(h999.shipmentsMore).toBe(1);
    // 999 paga 180,00 (techo de 1000) → efectivo 0,180; en 1000 también.
    expect(Number(h999.savesPerShipmentUsdMilli)).toBe(0);

    const h4999 = nextTierHint(4999)!;
    expect(h4999.tier.minShipments).toBe(5000);
    expect(h4999.shipmentsMore).toBe(1);
    expect(Number(h4999.savesPerShipmentUsdMilli)).toBe(0);
    expect(Number(h4999.totalAtTierUsdMilli)).toBe(550_000);
  });

  it('en el último escalón no hay empujón', () => {
    expect(nextTierHint(5000)).toBeNull();
    expect(nextTierHint(99_999)).toBeNull();
  });

  it('el ahorro nunca es negativo, en ningún volumen', () => {
    for (let n = 0; n <= SWEEP; n++) {
      const h = nextTierHint(n);
      if (!h) continue;
      expect(h.savesPerShipmentUsdMilli >= 0n, `n=${n}`).toBe(true);
      expect(h.listSavesPerShipmentUsdMilli > 0n, `n=${n}`).toBe(true);
      expect(h.shipmentsMore >= 1, `n=${n}`).toBe(true);
    }
  });

  it('con 0 envíos compara contra el precio de lista, no contra cero', () => {
    const h = nextTierHint(0)!;
    expect(Number(h.savesPerShipmentUsdMilli)).toBe(80); // 0,50 → 0,42
  });
});

describe('conversión a pesos', () => {
  it('divRoundHalfUp redondea la mitad para arriba', () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
    expect(divRoundHalfUp(3n, 2n)).toBe(2n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => divRoundHalfUp(-1n, 2n)).toThrow(RangeError);
  });

  it('al tipo base, los totales de los packs dan pesos redondos', () => {
    const esperados: Array<[number, number]> = [
      [10, 200],
      [50, 840],
      [100, 1480],
      [250, 3000],
      [500, 5000],
      [1000, 7200],
      [2500, 14000],
      [5000, 22000],
    ];
    for (const [n, uyu] of esperados) {
      expect(
        usdMilliToUyuWhole(periodTotalUsdMilli(n), BASE_USD_UYU_RATE_MILLI),
        `pack de ${n}`,
      ).toBe(uyu);
    }
  });

  it('a un tipo con decimales redondea a peso entero, mitad para arriba', () => {
    // USD 37,00 × 41,5 = 1.535,50 → 1.536.
    expect(usdMilliToUyuWhole(37_000n, 41_500n)).toBe(1536);
    // USD 5,00 × 41,5 = 207,50 → 208.
    expect(usdMilliToUyuWhole(5_000n, 41_500n)).toBe(208);
    // USD 5,00 × 41,4 = 207,00 → 207, exacto.
    expect(usdMilliToUyuWhole(5_000n, 41_400n)).toBe(207);
  });

  it('el monto en pesos SIEMPRE es un entero, en todo el rango de packs y tipos', () => {
    for (const rate of [38_000n, 40_000n, 41_500n, 44_000n, 55_750n]) {
      for (const n of [10, 50, 100, 250, 500, 1000, 2500, 5000]) {
        const v = usdMilliToUyuWhole(periodTotalUsdMilli(n), rate);
        expect(Number.isSafeInteger(v), `rate=${rate} n=${n} → ${v}`).toBe(true);
      }
    }
  });

  it('usdMilliToUyuMilli conserva los milésimos', () => {
    expect(usdMilliToUyuMilli(500n, 40_000n)).toBe(20_000n); // 0,50 × 40 = 20 UYU
    expect(usdMilliToUyuMilli(180n, 40_000n)).toBe(7_200n); // 0,18 × 40 = 7,20 UYU
  });

  it('rechaza tipos de cambio implausibles', () => {
    expect(() => usdMilliToUyuMilli(500n, 999n)).toThrow(RangeError);
    expect(() => usdMilliToUyuMilli(500n, 1_000_001n)).toThrow(RangeError);
  });
});

describe('USD_UYU_RATE — la env var', () => {
  it('sin la var usa el tipo base', () => {
    expect(getUsdUyuRateMilli({})).toBe(BASE_USD_UYU_RATE_MILLI);
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: '  ' })).toBe(BASE_USD_UYU_RATE_MILLI);
  });

  it('parsea enteros y decimales, con punto o coma', () => {
    expect(parseRateMilli('40')).toBe(40_000n);
    expect(parseRateMilli('41.5')).toBe(41_500n);
    expect(parseRateMilli('41,5')).toBe(41_500n);
    expect(parseRateMilli('38.875')).toBe(38_875n);
    expect(parseRateMilli(' 44 ')).toBe(44_000n);
  });

  it('rechaza lo que no es un tipo de cambio plausible', () => {
    for (const malo of ['', 'cuarenta', '40.1234', '0.5', '1001', '-40', '4e1', '40..5']) {
      expect(parseRateMilli(malo), malo).toBeNull();
    }
  });

  it('con una var ilegible avisa UNA vez y sigue cobrando al tipo base', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: 'ochenta' })).toBe(BASE_USD_UYU_RATE_MILLI);
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: 'ochenta' })).toBe(BASE_USD_UYU_RATE_MILLI);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('la promesa de D35: ningún cliente actual paga más', () => {
  it('el techo para que se cumpla sin asterisco es 38,888 UYU/USD', () => {
    expect(maxRateWithoutIncreaseMilli()).toBe(38_888n);
    expect(legacyPriceRegressions(38_888n)).toEqual([]);
  });

  it('al tipo base (40) sube UN solo escalón: el de 1000', () => {
    // 🔴 Es la única excepción de D35 y está asumida: 0,18 es 7/40 = 0,175
    // redondeado para arriba. Este test existe para que no se olvide ni crezca.
    const subas = legacyPriceRegressions(BASE_USD_UYU_RATE_MILLI);
    expect(subas).toHaveLength(1);
    expect(subas[0].minShipments).toBe(1000);
    expect(subas[0].legacyUyu).toBe(7);
    expect(Number(subas[0].newUyuMilli)).toBe(7_200); // 7,20 UYU: +2,86 %
  });

  it('los otros cinco escalones viejos bajan o quedan igual al tipo base', () => {
    for (const [corte, viejo] of LEGACY_UNIT_PRICE_UYU) {
      if (corte === 1000) continue;
      const nuevo = usdMilliToUyuMilli(unitPriceUsdMilliFor(corte), BASE_USD_UYU_RATE_MILLI);
      expect(nuevo <= BigInt(viejo) * 1000n, `escalón ${corte}`).toBe(true);
    }
  });

  it('a 44 UYU/USD (el tipo hardcodeado en otros repos) suben LOS SEIS escalones', () => {
    // Deja constancia de la consecuencia de subir la env: el precio en dólares
    // es fijo, así que todo movimiento del tipo de cambio se traslada al peso.
    // A 44 ningún cliente actual conserva su precio.
    expect(legacyPriceRegressions(44_000n).map((r) => r.minShipments)).toEqual([
      0, 50, 100, 250, 500, 1000,
    ]);
  });
});

describe('formato', () => {
  it('formatUsdMilli da dos decimales con coma', () => {
    expect(formatUsdMilli(500n)).toBe('0,50');
    expect(formatUsdMilli(110n)).toBe('0,11');
    expect(formatUsdMilli(37_000n)).toBe('37,00');
    expect(formatUsdMilli(550_000n)).toBe('550,00');
    expect(formatUsdMilli(0n)).toBe('0,00');
    expect(formatUsdMilli(225n)).toBe('0,23'); // 0,225 → mitad para arriba
  });

  it('formatRate no deja ceros decorativos', () => {
    expect(formatRate(40_000n)).toBe('40');
    expect(formatRate(41_500n)).toBe('41,5');
    expect(formatRate(38_875n)).toBe('38,875');
  });
});
