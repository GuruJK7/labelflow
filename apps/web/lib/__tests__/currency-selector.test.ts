import { describe, it, expect } from 'vitest';
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  PRICING_TIERS,
  UYU_SYMBOL,
  USD_SYMBOL,
  currencyNote,
  formatTotalPrice,
  formatUnitPrice,
  isCurrency,
  periodTotalUsdMilli,
  usdMilliToUyuWhole,
} from '@/lib/pricing';
import { listPacks, listPricingSteps } from '@/lib/credit-packs';
import {
  CURRENCY_STORAGE_KEY,
  readStoredCurrency,
  writeStoredCurrency,
} from '@/app/_components/CurrencyToggle';

/**
 * El selector de moneda: conversión, formato y persistencia.
 *
 * LO QUE ESTO CUIDA. Mostrar un precio en dos monedas es una oportunidad de
 * decir dos números distintos por la misma cosa. Los pesos que ve el cliente
 * en la pantalla de compra tienen que ser EXACTAMENTE los que MercadoPago le
 * va a cobrar — mismo redondeo, mismo tipo de cambio, mismo entero— y el
 * precio por envío no puede redondearse a un número que no cierre con el
 * total. Eso es lo que se verifica acá, contra el catálogo real y no contra
 * una conversión reescrita para el test.
 */

const BASE = 40_000n;

describe('la moneda como tipo', () => {
  it('son dos y el default es UYU: el cliente es uruguayo', () => {
    expect([...CURRENCIES]).toEqual(['USD', 'UYU']);
    expect(DEFAULT_CURRENCY).toBe('UYU');
  });

  it('isCurrency rechaza cualquier otra cosa, incluida basura de localStorage', () => {
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('UYU')).toBe(true);
    for (const malo of ['usd', 'uyu', 'EUR', '', null, undefined, 0, {}, ['USD']]) {
      expect(isCurrency(malo), String(malo)).toBe(false);
    }
  });
});

describe('formato del precio POR ENVÍO', () => {
  it('los ocho escalones en las dos monedas, al tipo base', () => {
    const usd = PRICING_TIERS.map((t) => formatUnitPrice(t.unitPriceUsdMilli, {
      currency: 'USD',
      rateMilli: BASE,
    }));
    expect(usd).toEqual([
      'USD 0,50',
      'USD 0,42',
      'USD 0,37',
      'USD 0,30',
      'USD 0,25',
      'USD 0,175',
      'USD 0,14',
      'USD 0,11',
    ]);

    const uyu = PRICING_TIERS.map((t) => formatUnitPrice(t.unitPriceUsdMilli, {
      currency: 'UYU',
      rateMilli: BASE,
    }));
    expect(uyu).toEqual([
      '$U 20,00',
      '$U 16,80',
      '$U 14,80',
      '$U 12,00',
      '$U 10,00',
      '$U 7,00',
      '$U 5,60',
      '$U 4,40',
    ]);
  });

  it('en USD NO redondea a dos decimales: 0,175 no puede leerse 0,18', () => {
    // Es el punto entero de `formatUsdUnitMilli`. Con dos decimales el cliente
    // multiplica 0,18 × 40, le da 7,20 y le cobran 7,00.
    expect(formatUnitPrice(175n, { currency: 'USD', rateMilli: BASE })).toBe('USD 0,175');
    expect(formatUnitPrice(175n, { currency: 'UYU', rateMilli: BASE })).toBe('$U 7,00');
    // Y el efectivo con 800 envíos: 175,00/800 = 0,21875 → trunca a 0,218.
    expect(formatUnitPrice(218n, { currency: 'USD', rateMilli: BASE })).toBe('USD 0,218');
  });

  it('$U y no $: en Uruguay el peso y el dólar comparten símbolo', () => {
    expect(UYU_SYMBOL).toBe('$U');
    expect(USD_SYMBOL).toBe('USD');
    expect(formatUnitPrice(500n, { currency: 'UYU', rateMilli: BASE })).not.toContain('USD');
  });

  it('el redondeo del peso es half-up y no arrastra float', () => {
    // 0,37 × 41,5 = 15,355 → 15,36 (half-up sobre el milésimo, no 15,35).
    expect(formatUnitPrice(370n, { currency: 'UYU', rateMilli: 41_500n })).toBe('$U 15,36');
    // 0,11 × 38,875 = 4,27625 → 4,276 milésimos → 4,28.
    expect(formatUnitPrice(110n, { currency: 'UYU', rateMilli: 38_875n })).toBe('$U 4,28');
  });

  it('rechaza montos negativos en vez de imprimir un guion suelto', () => {
    expect(() => formatUnitPrice(-1n, { currency: 'USD', rateMilli: BASE })).toThrow(RangeError);
    expect(() => formatTotalPrice(-1n, { currency: 'UYU', rateMilli: BASE })).toThrow(RangeError);
  });
});

describe('formato del TOTAL', () => {
  it('en pesos va al peso entero, con separador de miles', () => {
    expect(formatTotalPrice(175_000n, { currency: 'UYU', rateMilli: BASE })).toBe('$U 7.000');
    expect(formatTotalPrice(550_000n, { currency: 'UYU', rateMilli: BASE })).toBe('$U 22.000');
    expect(formatTotalPrice(175_000n, { currency: 'USD', rateMilli: BASE })).toBe('USD 175,00');
  });

  it('🔴 EL PESO QUE SE MUESTRA ES EL QUE COBRA EL CHECKOUT', () => {
    // `pack.totalPriceUyu` es literalmente el `unit_price` que
    // `app/api/credit-packs/checkout/route.ts` le manda a MercadoPago. Si esta
    // igualdad se rompe, la pantalla promete un precio y la pasarela cobra otro.
    for (const rate of [BASE, 38_875n, 41_500n, 44_000n]) {
      for (const pack of listPacks(rate, { largePacks: true })) {
        expect(
          formatTotalPrice(BigInt(pack.totalPriceUsdMilli), { currency: 'UYU', rateMilli: rate }),
          `pack ${pack.id} a ${rate}`,
        ).toBe(`${UYU_SYMBOL} ${pack.totalPriceUyu.toLocaleString('es-UY')}`);
      }
    }
  });

  it('la tabla de escalones muestra los mismos pesos que `listPricingSteps`', () => {
    for (const rate of [BASE, 41_500n]) {
      for (const step of listPricingSteps(rate)) {
        expect(
          formatTotalPrice(BigInt(step.totalAtStepUsdMilli), { currency: 'UYU', rateMilli: rate }),
          `escalón ${step.minShipments} a ${rate}`,
        ).toBe(`${UYU_SYMBOL} ${step.totalAtStepUyu.toLocaleString('es-UY')}`);
      }
    }
  });

  it('barrido 0..2000: el peso mostrado es siempre usdMilliToUyuWhole', () => {
    // Sin esto, cualquier atajo de formato (dividir en float, truncar en vez de
    // redondear) pasaría desapercibido en los pocos valores de arriba.
    for (let n = 0; n <= 2000; n++) {
      const usdMilli = periodTotalUsdMilli(n);
      const esperado = usdMilliToUyuWhole(usdMilli, BASE);
      expect(formatTotalPrice(usdMilli, { currency: 'UYU', rateMilli: BASE }), `n=${n}`).toBe(
        `${UYU_SYMBOL} ${BigInt(esperado).toLocaleString('es-UY')}`,
      );
    }
  });
});

describe('la nota que acompaña a los montos', () => {
  it('en pesos avisa que el precio de lista es en dólares y a qué tipo se convierte', () => {
    const nota = currencyNote('UYU', '40');
    expect(nota).toContain('en dólares');
    expect(nota).toContain('40 UYU/USD');
    expect(nota).toContain('de referencia');
    expect(nota).toContain('cobra en pesos');
  });

  it('en dólares avisa que el cobro igual es en pesos y que el monto se ve antes de pagar', () => {
    const nota = currencyNote('USD', '41,5');
    expect(nota).toContain('MercadoPago cobra en pesos');
    expect(nota).toContain('41,5 UYU/USD');
    expect(nota).toContain('antes de pagar');
  });

  it('ninguna de las dos afirma que el tipo sea la cotización del día', () => {
    for (const c of CURRENCIES) {
      const sinNegacion = currencyNote(c, '40').replace(/no es la cotización del día/gi, '');
      expect(sinNegacion, c).not.toMatch(/cotizaci[oó]n del d[ií]a/i);
      expect(sinNegacion, c).not.toMatch(/tipo de cambio del d[ií]a/i);
    }
  });
});

/** Storage de mentira: un Map, o uno que explota, según haga falta. */
function fakeStorage(inicial: Record<string, string> = {}) {
  const datos = new Map(Object.entries(inicial));
  return {
    getItem: (k: string) => datos.get(k) ?? null,
    setItem: (k: string, v: string) => {
      datos.set(k, v);
    },
    leer: (k: string) => datos.get(k) ?? null,
  };
}

const storageQueExplota = {
  getItem() {
    throw new DOMException('SecurityError');
  },
  setItem() {
    throw new DOMException('QuotaExceededError');
  },
};

describe('persistencia de la elección', () => {
  it('lo que se guarda es lo que se lee', () => {
    const s = fakeStorage();
    for (const c of CURRENCIES) {
      writeStoredCurrency(c, s);
      expect(s.leer(CURRENCY_STORAGE_KEY)).toBe(c);
      expect(readStoredCurrency(s)).toBe(c);
    }
  });

  it('sin nada guardado cae en el default', () => {
    expect(readStoredCurrency(fakeStorage())).toBe(DEFAULT_CURRENCY);
  });

  it('un valor basura cae en el default en vez de romper la pantalla', () => {
    // Otra versión de la app, o alguien editando localStorage a mano.
    for (const basura of ['EUR', 'usd', '', '{"currency":"USD"}']) {
      expect(readStoredCurrency(fakeStorage({ [CURRENCY_STORAGE_KEY]: basura })), basura).toBe(
        DEFAULT_CURRENCY,
      );
    }
  });

  it('🔴 en modo privado el storage TIRA, y ni leer ni escribir pueden propagar', () => {
    // Safari con cookies bloqueadas tira en el acceso mismo. Perder la
    // preferencia es molesto; que se caiga la pantalla de compra, no.
    expect(readStoredCurrency(storageQueExplota)).toBe(DEFAULT_CURRENCY);
    expect(() => writeStoredCurrency('USD', storageQueExplota)).not.toThrow();
  });

  it('sin storage (SSR) devuelve el default sin tocar nada', () => {
    expect(readStoredCurrency(null)).toBe(DEFAULT_CURRENCY);
    expect(() => writeStoredCurrency('USD', null)).not.toThrow();
  });

  it('la clave es estable: cambiarla borra la preferencia de todo el mundo', () => {
    expect(CURRENCY_STORAGE_KEY).toBe('autoenvia.currency');
  });
});

describe('elegir moneda no cambia lo que se paga', () => {
  it('las dos vistas salen del MISMO total en dólares, no de dos cálculos', () => {
    // La moneda es de PRESENTACIÓN. El precio autoritativo (milésimos de USD)
    // es uno solo; cada vista es una función pura de ese número, así que no
    // puede existir un volumen donde las dos monedas cuenten historias
    // distintas.
    for (const n of [1, 49, 100, 800, 1000, 2500, 5000]) {
      const usdMilli = periodTotalUsdMilli(n);
      const enUsd = formatTotalPrice(usdMilli, { currency: 'USD', rateMilli: BASE });
      const enUyu = formatTotalPrice(usdMilli, { currency: 'UYU', rateMilli: BASE });

      // El dólar se muestra tal cual, sin pasar por el tipo de cambio: cambiar
      // el tipo no puede mover la vista en USD.
      expect(enUsd, `n=${n}`).toBe(
        formatTotalPrice(usdMilli, { currency: 'USD', rateMilli: 44_000n }),
      );
      // El peso sale de la conversión del checkout, y ésa sí se mueve.
      expect(enUyu, `n=${n}`).toBe(
        `${UYU_SYMBOL} ${BigInt(usdMilliToUyuWhole(usdMilli, BASE)).toLocaleString('es-UY')}`,
      );
      expect(enUsd).not.toBe(enUyu);
    }
  });

  it('mover USD_UYU_RATE mueve SÓLO la vista en pesos', () => {
    const usdMilli = periodTotalUsdMilli(1000); // USD 175,00
    expect(formatTotalPrice(usdMilli, { currency: 'UYU', rateMilli: BASE })).toBe('$U 7.000');
    expect(formatTotalPrice(usdMilli, { currency: 'UYU', rateMilli: 44_000n })).toBe('$U 7.700');
    expect(formatTotalPrice(usdMilli, { currency: 'USD', rateMilli: 44_000n })).toBe('USD 175,00');
  });
});
