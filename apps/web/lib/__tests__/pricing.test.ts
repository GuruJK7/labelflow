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
  unexpectedLegacyRegressions,
  formatPercent,
  formatUyuMilli,
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
      [1000, 175],
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
      [1000, 1000, 175],
      [2499, 1000, 175],
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
      [701, 1000],
      [999, 1000],
      [2001, 2500],
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
      [1000, 175_000],
      [2500, 350_000],
      [5000, 550_000],
    ];
    for (const [n, milli] of esperados) {
      expect(Number(periodTotalUsdMilli(n)), `total(${n})`).toBe(milli);
    }
  });

  it('marca cuando el cliente paga el techo de un escalón mejor', () => {
    expect(quoteUsd(800).cappedByBetterTier).toBe(true);
    expect(Number(quoteUsd(800).totalUsdMilli)).toBe(175_000);
    // 175,00/800 = 0,21875; el efectivo trunca para no mostrar de más.
    expect(Number(quoteUsd(800).effectiveUnitUsdMilli)).toBe(218);
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
      [1000, 7000],
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
    expect(usdMilliToUyuMilli(175n, 40_000n)).toBe(7_000n); // 0,175 × 40 = 7 UYU exactos
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
  it('el techo para que se cumpla es 40 UYU/USD: EXACTO el tipo base', () => {
    // 🔴 Antes de que el escalón de 1.000 pasara a 0,175 este techo era 38,888
    // y el tipo base (40) ya estaba POR ENCIMA — de ahí salía la excepción.
    // Ahora el techo lo fijan cuatro escalones a la vez, todos los que caen
    // redondos: 20/0,50 · 12/0,30 · 10/0,25 · 7/0,175 dan los cuatro 40.000.
    expect(maxRateWithoutIncreaseMilli()).toBe(BASE_USD_UYU_RATE_MILLI);
    expect(maxRateWithoutIncreaseMilli()).toBe(40_000n);
    expect(legacyPriceRegressions(40_000n)).toEqual([]);
    // Y no hay margen: 40,001 ya encarece al primer escalón. Los otros tres
    // que empatan en 40 aguantan un poquito más sólo porque la suba todavía no
    // llega al milésimo de peso y el redondeo half-up se la come; a 40,1 ya
    // suben los cuatro.
    expect(legacyPriceRegressions(40_001n).map((r) => r.minShipments)).toEqual([0]);
    expect(legacyPriceRegressions(40_100n).map((r) => r.minShipments)).toEqual([0, 250, 500, 1000]);
  });

  it('al tipo base (40) NO sube ningún escalón: la promesa vale sin asterisco', () => {
    // 🔴 Este es el test de la decisión de Adrian del 2026-09-02. Con el
    // escalón de 1.000 en 0,18 acá había exactamente una suba (7,00 → 7,20,
    // +2,86 %); con 0,175 no hay ninguna. Si alguien vuelve a mover ese
    // número para arriba, esta lista deja de estar vacía y el test cae.
    expect(legacyPriceRegressions(BASE_USD_UYU_RATE_MILLI)).toEqual([]);
  });

  it('los seis escalones viejos bajan o quedan igual al tipo base', () => {
    for (const [corte, viejo] of LEGACY_UNIT_PRICE_UYU) {
      const nuevo = usdMilliToUyuMilli(unitPriceUsdMilliFor(corte), BASE_USD_UYU_RATE_MILLI);
      expect(nuevo <= BigInt(viejo) * 1000n, `escalón ${corte}`).toBe(true);
    }
    // El de 1.000 es el que se movió: 7 UYU clavados, ni un milésimo más.
    expect(usdMilliToUyuMilli(unitPriceUsdMilliFor(1000), BASE_USD_UYU_RATE_MILLI)).toBe(7_000n);
  });

  it('NINGÚN escalón se redondea para arriba: dos para abajo y cuatro exactos', () => {
    // Lo que arregló la decisión de Adrian: de los seis escalones viejos, el
    // borrador de D35 redondeaba DOS para abajo (0,425 → 0,42 y 0,375 → 0,37,
    // a favor del cliente) y UNO para arriba (0,175 → 0,18) — justo el que
    // rompía la promesa. Con 0,175 no queda ningún redondeo en contra del
    // cliente, y este test cae si aparece uno.
    const direccion = [...LEGACY_UNIT_PRICE_UYU].map(([corte, viejoUyu]) => {
      // El precio en USD exacto que sale de dividir por el tipo base, en milésimos.
      const exactoUsdMilli = (BigInt(viejoUyu) * 1_000_000n) / BASE_USD_UYU_RATE_MILLI;
      const enD35 = unitPriceUsdMilliFor(corte);
      return [
        corte,
        Number(exactoUsdMilli),
        Number(enD35),
        enD35 > exactoUsdMilli ? 'arriba' : enD35 < exactoUsdMilli ? 'abajo' : 'exacto',
      ];
    });
    expect(direccion).toEqual([
      [0, 500, 500, 'exacto'],
      [50, 425, 420, 'abajo'],
      [100, 375, 370, 'abajo'],
      [250, 300, 300, 'exacto'],
      [500, 250, 250, 'exacto'],
      [1000, 175, 175, 'exacto'],
    ]);
    expect(direccion.filter((d) => d[3] === 'arriba')).toHaveLength(0);
    expect(direccion.filter((d) => d[3] === 'abajo')).toHaveLength(2);
  });

  it('CONTRAFÁCTICO: con el 0,18 del borrador la promesa se rompía', () => {
    // El valor descartado, medido, para que nadie lo reponga "porque queda más
    // redondo". Es lo único que queda del 0,18 en el repo.
    const conEscalon = (usdMilli: bigint) =>
      PRICING_TIERS.map((t) =>
        t.minShipments === 1000 ? { ...t, unitPriceUsdMilli: usdMilli } : t,
      );

    const conViejo = legacyPriceRegressions(BASE_USD_UYU_RATE_MILLI, conEscalon(180n));
    expect(conViejo).toHaveLength(1);
    expect(conViejo[0].minShipments).toBe(1000);
    expect(Number(conViejo[0].newUyuMilli)).toBe(7_200); // 7,20 en vez de 7,00
    expect(formatPercent(conViejo[0].newUyuMilli, 7_000n)).toBe('2,9'); // +2,86 %

    // Y lo vigente, contra lo que se comparó: 0,175 no rompe nada.
    expect(legacyPriceRegressions(BASE_USD_UYU_RATE_MILLI, conEscalon(175n))).toEqual([]);
    expect(usdMilliToUyuMilli(175n, BASE_USD_UYU_RATE_MILLI)).toBe(7_000n);
    expect(() => assertPricingTiersValid(conEscalon(175n))).not.toThrow();
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

describe('guardarraíl: mover USD_UYU_RATE deja rastro', () => {
  /**
   * `USD_UYU_RATE` se cambia con `vercel env add`: sin PR, sin redeploy y sin
   * que falle un solo test, porque los tests corren con tipos literales y no
   * con el valor de la env. Antes de esto, subir la env a 44 encarecía los seis
   * escalones viejos entre 8,7 % y 13,1 % sin dejar una línea de log.
   */
  it('la línea de base quedó vacía: la escalera ya no tiene subas asumidas', () => {
    expect(unexpectedLegacyRegressions(BASE_USD_UYU_RATE_MILLI)).toEqual([]);
    // Y por debajo del techo tampoco, obviamente.
    expect(unexpectedLegacyRegressions(38_888n)).toEqual([]);
    expect(unexpectedLegacyRegressions(20_000n)).toEqual([]);
  });

  it('a 44 las SEIS subas son nuevas: ya no hay ninguna descontada de antes', () => {
    // Con el escalón de 1.000 en 0,18 este test esperaba cinco: la del de
    // 1.000 estaba en la línea de base y se descontaba. Ahora no se descuenta
    // ninguna, así que el aviso reporta el daño completo.
    expect(unexpectedLegacyRegressions(44_000n).map((r) => r.minShipments)).toEqual([
      0, 50, 100, 250, 500, 1000,
    ]);
  });

  it('al tipo base el checkout NO grita: al tipo base no sube nadie', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: '40' })).toBe(40_000n);
    expect(getUsdUyuRateMilli({})).toBe(40_000n);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('con la env en 44 avisa UNA vez, nombra los escalones que suben y el techo', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: '44' })).toBe(44_000n);
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: '44' })).toBe(44_000n);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    // Los SEIS escalones que suben, no sólo los nuevos: el aviso tiene que
    // alcanzar para decidir sin ir a buscar nada más.
    for (const corte of [0, 50, 100, 250, 500, 1000]) {
      expect(msg, `escalón ${corte}`).toContain(`${corte}+ envíos`);
    }
    expect(msg).toContain('22,00 UYU'); // 0,50 × 44
    expect(msg).toContain('+10,0 %');
    expect(msg).toContain('7,70 UYU'); // el de 1000: 0,175 × 44
    expect(msg).toContain('+8,7 %'); // el de 50: 17 → 18,48
    expect(msg).toContain('sube es 40 UYU/USD'); // el techo, ahora igual al base
    expect(msg).toContain('ALERTA DE PRECIO');
    spy.mockRestore();
  });

  it('el aviso no sale si el tipo baja', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getUsdUyuRateMilli({ [USD_UYU_RATE_ENV]: '36' })).toBe(36_000n);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('formatPercent y formatUyuMilli son enteros, no floats', () => {
    expect(formatUyuMilli(7_920n)).toBe('7,92');
    expect(formatUyuMilli(22_000n)).toBe('22,00');
    expect(formatPercent(7_200n, 7_000n)).toBe('2,9'); // +2,86 % → 2,9
    expect(formatPercent(22_000n, 20_000n)).toBe('10,0');
    expect(formatPercent(7_920n, 7_000n)).toBe('13,1');
    expect(() => formatPercent(1n, 0n)).toThrow(RangeError);
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
